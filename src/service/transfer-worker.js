'use strict';

/**
 * Hilo de transferencias: aquí corre el motor (src/core/transfer.js), nunca en el hilo principal
 * ni en el del análisis. Una sola operación a la vez.
 *
 * El plan completo (puede tener millones de elementos) se queda AQUÍ: hacia afuera solo viaja un
 * resumen y un `planId`. Para ejecutar, quien llama manda el `planId`, nunca un plan.
 * La Papelera real solo existe en el proceso principal (shell.trashItem): se le pide por mensajes.
 *
 * Protocolo (igual que analysis-worker): { id, method, args } -> { id, ok, result | error }.
 *   salida extra: { type: 'progress', ... } y { type: 'trash-request', reqId, path }.
 *   entrada extra: { type: 'trash-result', reqId, ok, error }.
 */

const crypto = require('node:crypto');
const { parentPort, workerData } = require('node:worker_threads');
const { createTransferEngine } = require('../core/transfer');
const { volumeInfoForPath } = require('../main/volume-info');
const { createRegistry } = require('../core/registro');

const hasTrash = Boolean(workerData && workerData.hasTrash);
// Solo la prueba automática lo pasa: las carpetas cuyo nombre empieza así se tratan como si estuvieran en un disco extraíble
// (sin Papelera), para poder recorrer en la interfaz el camino «probablemente no cabe en la Papelera».
// Solo la prueba automática: las carpetas cuyo nombre empieza así se copian despacio (1,2 s por archivo) para poder cancelarlas a mitad.
const smokeSlowPrefix = workerData && typeof workerData.smokeSlowPrefix === 'string' ? workerData.smokeSlowPrefix : null;
const smokeRemovablePrefix = workerData && typeof workerData.smokeRemovablePrefix === 'string' ? workerData.smokeRemovablePrefix : null;
const progressIntervalMs = workerData && Number.isFinite(workerData.progressIntervalMs) && workerData.progressIntervalMs >= 0 ? workerData.progressIntervalMs : 200;
const version = (() => {
  try {
    return require('../../package.json').version;
  } catch {
    return '0.0.0';
  }
})();

const pendingTrash = new Map();
function askMainToTrash(p) {
  return new Promise((resolve, reject) => {
    const reqId = crypto.randomBytes(8).toString('hex');
    pendingTrash.set(reqId, { resolve, reject });
    parentPort.postMessage({ type: 'trash-request', reqId, path: p });
  });
}

// El registro (datos para verificar copias más tarde) vive en el PC: este hilo es su ÚNICO escritor.
const registry = workerData && typeof workerData.registryDir === 'string' && workerData.registryDir !== '' ? createRegistry({ dir: workerData.registryDir }) : null;

const engine = createTransferEngine({
  registry,
  volumeInfo: async (p) => {
    const info = await volumeInfoForPath(p);
    if (smokeRemovablePrefix && require('node:path').basename(String(p)).startsWith(smokeRemovablePrefix)) return { ...info, driveType: 'removable' };
    return info;
  },
  trash: hasTrash ? askMainToTrash : null,
  appVersion: version,
});

const plans = new Map(); // planId -> plan (se queda en este hilo)
const runs = new Map(); // runId -> resultado completo
let running = null; // { controller }

class ServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function summarizePlan(plan) {
  return {
    mode: plan.mode,
    verify: plan.verify,
    disposal: plan.disposal,
    confirmPermanentDelete: plan.confirmPermanentDelete === true,
    recycleVerdict: plan.recycleVerdict || null,
    destinationRoot: plan.destinationRoot,
    fileSystem: plan.fileSystem,
    totals: plan.totals,
    sources: plan.sources.map((s) => ({
      source: s.source,
      requested: s.requested,
      finalName: s.finalName,
      renamed: s.renamed,
      destino: s.destino,
      files: s.files,
      dirs: s.dirs,
      bytes: s.bytes,
      links: s.links.length,
      unreadable: s.unreadable.length,
      special: s.special.length,
    })),
  };
}

function summarizeRun(result, runId) {
  return {
    runId,
    estado: result.estado,
    abortada: result.abortada,
    verificacion: result.verificacion,
    avisoVerificacion: result.avisoVerificacion,
    destinoRaiz: result.destinoRaiz,
    totales: result.totales,
    carpetas: result.carpetas.map(summarizeFolder),
  };
}

const MAX_LIST = 500;
/** Una carpeta del resultado, acotada: nunca viajan listas enormes (el detalle completo está en MANIFIESTO.json). */
function summarizeFolder(c) {
  const out = { ...c, errores: c.errores.slice(0, 50), erroresTotal: c.errores.length };
  if (c.borradoParcial) {
    out.borradoParcial = {
      error: c.borradoParcial.error,
      borradosTotal: c.borradoParcial.borrados.length,
      restantesTotal: c.borradoParcial.restantes.length,
      borrados: c.borradoParcial.borrados.slice(0, MAX_LIST),
      restantes: c.borradoParcial.restantes.slice(0, MAX_LIST),
    };
  }
  return out;
}

const handlers = {
  async preflight(options) {
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    const r = await engine.preflight(options);
    let planId = null;
    if (r.plan) {
      planId = crypto.randomBytes(8).toString('hex');
      plans.set(planId, r.plan);
      if (plans.size > 20) plans.delete(plans.keys().next().value);
    }
    return { blockers: r.blockers, warnings: r.warnings, destination: r.destination, disposal: r.disposal, planId, plan: r.plan ? summarizePlan(r.plan) : null };
  },

  async run(planId) {
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    const plan = plans.get(planId);
    if (!plan) throw new ServiceError('Plan desconocido: hay que revisar de nuevo antes de ejecutar', 'PLAN_DESCONOCIDO');
    plans.delete(planId); // un plan se ejecuta UNA vez
    const controller = new AbortController();
    running = { controller };
    try {
      const result = await engine.run(plan, {
        signal: controller.signal,
        progressIntervalMs,
        hooks: smokeSlowPrefix
          ? { beforeFile: async ({ folder }) => (require('node:path').basename(folder.source).startsWith(smokeSlowPrefix) ? new Promise((r) => setTimeout(r, 1200)) : undefined) }
          : {},
        onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }),
      });
      const runId = crypto.randomBytes(8).toString('hex');
      runs.set(runId, result);
      if (runs.size > 10) runs.delete(runs.keys().next().value);
      return summarizeRun(result, runId);
    } finally {
      running = null;
    }
  },

  async cancel() {
    if (!running) return { cancelled: false };
    running.controller.abort();
    return { cancelled: true };
  },

  async verifyRecord(id, options = {}) {
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    if (!registry) throw new ServiceError('No hay registro de copias', 'SIN_REGISTRO');
    const record = await registry.get(id);
    if (!record) throw new ServiceError('Esa copia no está en el registro (o el registro está dañado)', 'REGISTRO_DESCONOCIDO');
    const mode = options && options.mode === 'quick' ? 'quick' : 'full';
    const controller = new AbortController();
    running = { controller };
    try {
      const res = await engine.verifyRecord(record, { mode, signal: controller.signal, onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }) });
      return { ...res, nombre: record.nombre, destino: record.destino, origen: record.origen, fecha: record.fecha };
    } finally {
      running = null;
    }
  },

  /** Lista de copias anteriores (resumen: sin la lista de archivos). */
  async listRecords() {
    return registry ? registry.list() : [];
  },

  async removeRecord(id) {
    if (!registry) return { quitado: false };
    return { quitado: await registry.remove(id) };
  },

  /** Carpetas «….copiando» que esta app dejó a medias (diario) y que todavía existen. */
  async listPending() {
    if (!registry) return [];
    const out = [];
    for (const p of await registry.listPending()) {
      const exists = await require('node:fs').promises.lstat(p.ruta).then(() => true, () => false);
      if (exists) out.push(p);
      else await registry.removePending(p.ruta);
    }
    return out;
  },

  /** Borra UNA carpeta provisional del diario (el motor comprueba que sea suya). */
  async cleanPending(ruta) {
    if (!registry) throw new ServiceError('No hay diario de copias', 'SIN_REGISTRO');
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    const entry = (await registry.listPending()).find((p) => p.ruta === ruta);
    if (!entry) throw new ServiceError('BoneYardDog no anotó esa carpeta: no se toca', 'NO_ANOTADA');
    const r = await engine.removePendingWork(ruta, entry);
    await registry.removePending(ruta);
    return r;
  },

  async quitarCopiado(runId) {
    const result = runs.get(runId);
    if (!result) throw new ServiceError('Resultado desconocido', 'RESULTADO_DESCONOCIDO');
    return engine.quitarCopiado(result);
  },

  async eliminarDefinitivamente(runId, indices, confirm) {
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    const result = runs.get(runId);
    if (!result) throw new ServiceError('Resultado desconocido', 'RESULTADO_DESCONOCIDO');
    running = { controller: new AbortController() };
    try {
      const out = await engine.eliminarDefinitivamente(result, indices, { confirm });
      return { estado: out.estado, manifiestoActualizado: out.manifiestoActualizado, resumen: summarizeRun(result, runId) };
    } finally {
      running = null;
    }
  },
};

parentPort.on('message', async (msg) => {
  if (msg && msg.type === 'trash-result') {
    const p = pendingTrash.get(msg.reqId);
    if (!p) return;
    pendingTrash.delete(msg.reqId);
    if (msg.ok) p.resolve();
    else p.reject(new Error(msg.error || 'La Papelera no pudo retirar el elemento'));
    return;
  }
  const { id, method, args } = msg || {};
  try {
    if (!Object.hasOwn(handlers, method)) throw new ServiceError(`Método desconocido: ${method}`, 'METODO_DESCONOCIDO');
    const result = await handlers[method](...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { name: err && err.name, message: err && err.message ? err.message : String(err), code: err && err.code } });
  }
});
