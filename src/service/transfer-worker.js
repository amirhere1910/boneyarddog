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

const hasTrash = Boolean(workerData && workerData.hasTrash);
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

const engine = createTransferEngine({
  volumeInfo: (p) => volumeInfoForPath(p),
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
    fileSystem: plan.fileSystem,
    totals: plan.totals,
    sources: plan.sources.map((s) => ({
      source: s.source,
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
    batchFolder: result.batchFolder,
    lote: result.lote,
    totales: result.totales,
    carpetas: result.carpetas.map((c) => ({ ...c, errores: c.errores.slice(0, 50), erroresTotal: c.errores.length })),
  };
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

  async verifyBatch(batchFolder, options = {}) {
    if (running) throw new ServiceError('Ya hay una transferencia en curso', 'OCUPADO');
    const mode = options && options.mode === 'quick' ? 'quick' : 'full';
    const controller = new AbortController();
    running = { controller };
    try {
      return await engine.verifyBatch(batchFolder, { mode, signal: controller.signal, onProgress: (p) => parentPort.postMessage({ type: 'progress', ...p }) });
    } finally {
      running = null;
    }
  },

  async quitarCopiado(runId) {
    const result = runs.get(runId);
    if (!result) throw new ServiceError('Resultado desconocido', 'RESULTADO_DESCONOCIDO');
    return engine.quitarCopiado(result);
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
