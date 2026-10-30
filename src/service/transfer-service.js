'use strict';

/**
 * TransferService: puerta de entrada al motor de transferencias (hilo propio).
 *
 * - `trash(path)` (inyectada por quien crea el servicio; en la app real será shell.trashItem)
 *   se atiende aquí, en el hilo que la tenga disponible, cuando el worker la pide.
 * - El plan nunca sale del worker: preflight devuelve un `planId`; run recibe ese `planId`.
 * - Una sola transferencia a la vez.
 * Eventos: 'progress' -> { fase, bytesDone, bytesTotal, filesDone, filesTotal, archivo, ... }
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const WORKER_FILE = path.join(__dirname, 'transfer-worker.js');
const ERROR_CLASSES = { TypeError, RangeError };

class TransferService extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {(p: string) => Promise<void>} [options.trash] Envía a la Papelera (inyectada).
   * @param {() => Worker} [options.workerFactory] Para pruebas.
   * @param {number} [options.progressIntervalMs=200] Separación mínima entre avisos de progreso.
   * @param {string} [options.registryDir] Carpeta del registro de copias (en el PC, no en el destino).
   * @param {string} [options.diagFile] Archivo `diagnostico.log` (en el PC, no en el destino).
   * @param {number} [options.cancelGraceMs=10000] Perro guardián: si tras cancelar el hilo no responde en este tiempo, se le corta.
   * @param {object} [options.workerData] Solo pruebas (p. ej. `testHangFs`).
   */
  constructor({ trash, workerFactory, progressIntervalMs = 200, registryDir = null, diagFile = null, cancelGraceMs = 10000, workerData = {} } = {}) {
    super();
    this._trash = typeof trash === 'function' ? trash : null;
    this._cancelGraceMs = cancelGraceMs;
    this._factory = workerFactory || (() => new Worker(WORKER_FILE, { workerData: { ...workerData, hasTrash: this._trash !== null, progressIntervalMs, registryDir, diagFile } }));
    this._active = null; // { id, method, planId, started, timer, resolve, reject, settled }
    this._plans = new Map(); // planId -> { destinationRoot, totals } (para el resultado sintético)
    this._worker = null;
    this._nextId = 1;
    this._pending = new Map();
  }

  _ensureWorker() {
    if (this._worker) return this._worker;
    const worker = this._factory();
    this._worker = worker;
    worker.on('message', (msg) => {
      if (msg && msg.type === 'progress') {
        const { type: _t, ...rest } = msg;
        this.emit('progress', rest);
        return;
      }
      if (msg && msg.type === 'trash-request') {
        const reply = (ok, error) => worker.postMessage({ type: 'trash-result', reqId: msg.reqId, ok, error });
        if (!this._trash) return reply(false, 'No hay función de Papelera');
        Promise.resolve()
          .then(() => this._trash(msg.path))
          .then(() => reply(true), (err) => reply(false, err && err.message ? err.message : String(err)));
        return;
      }
      const entry = msg && this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const E = ERROR_CLASSES[msg.error.name] || Error;
        const err = new E(msg.error.message);
        err.code = msg.error.code;
        entry.reject(err);
      }
    });
    const fail = (err) => {
      if (this._worker === worker) this._worker = null;
      for (const [id, entry] of this._pending) {
        if (entry.worker !== worker) continue;
        this._pending.delete(id);
        entry.reject(err);
      }
    };
    worker.on('error', (err) => {
      fail(err);
      if (this.listenerCount('worker-error') > 0) this.emit('worker-error', err);
    });
    worker.on('exit', (code) => fail(new Error(`El hilo de transferencias terminó inesperadamente (código ${code})`)));
    return worker;
  }

  _call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      try {
        const worker = this._ensureWorker();
        const entry = { resolve, reject, worker };
        if (method === 'run' || method === 'verifyRecord') {
          const done = () => {
            if (this._active && this._active.id === id) {
              clearTimeout(this._active.timer);
              this._active = null;
            }
          };
          entry.resolve = (v) => (done(), resolve(v));
          entry.reject = (e) => (done(), reject(e));
          this._active = { id, method, planId: method === 'run' ? args[0] : null, started: Date.now(), timer: null, worker };
        }
        this._pending.set(id, entry);
        worker.postMessage({ id, method, args });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Revisa todo antes de copiar. Devuelve impedimentos, avisos y un planId (el plan se queda en el hilo). */
  async preflight(options) {
    const r = await this._call('preflight', options);
    if (r && r.planId && r.plan) {
      this._plans.set(r.planId, { destinationRoot: r.plan.destinationRoot, totals: r.plan.totals });
      if (this._plans.size > 20) this._plans.delete(this._plans.keys().next().value);
    }
    return r;
  }

  /** Ejecuta un plan ya revisado (solo por su planId). */
  run(planId) {
    return this._call('run', planId);
  }

  /**
   * Cancela la operación en curso. Perro guardián: si el hilo no termina de cancelar en `cancelGraceMs` (por ejemplo, el disco
   * dejó de responder y una lectura nunca vuelve), se le corta (`terminate`), se prepara un hilo nuevo y la operación se da por
   * cancelada a la fuerza. NADA se borra desde aquí: la carpeta «….copiando» queda anotada en el diario para limpiarla después.
   */
  async cancel() {
    const active = this._active;
    // El reloj se arma ANTES de avisar al hilo: si el hilo está tan bloqueado que ni contesta, igual se le corta.
    if (active && !active.timer) {
      active.timer = setTimeout(() => this._forceCancel(active), this._cancelGraceMs);
      if (active.timer.unref) active.timer.unref();
    }
    let res;
    try {
      res = await this._call('cancel');
    } catch (err) {
      if (this._active === active) return { cancelled: true, sinRespuesta: true };
      throw err;
    }
    if (active && !(res && res.cancelled) && this._active === active) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    return res;
  }

  /** Cancela y espera a que termine (a lo sumo `cancelGraceMs` + un margen, gracias al perro guardián). */
  async cancelAndWait() {
    const active = this._active;
    if (!active) return { cancelled: false };
    const entry = this._pending.get(active.id);
    const finished = new Promise((r) => {
      if (!entry) return r();
      const { resolve, reject } = entry;
      entry.resolve = (v) => (resolve(v), r());
      entry.reject = (e) => (reject(e), r());
    });
    await this.cancel().catch(() => {});
    await finished;
    return { cancelled: true };
  }

  async _forceCancel(active) {
    if (this._active !== active) return;
    const entry = this._pending.get(active.id);
    const worker = this._worker === active.worker ? active.worker : null;
    this._pending.delete(active.id);
    this._active = null;
    // Los pedidos que quedaron colgados de ese hilo no volverán: se rechazan; el hilo nuevo parte limpio.
    for (const [id, e] of this._pending) {
      if (e.worker !== active.worker) continue;
      this._pending.delete(id);
      e.reject(new Error('El hilo de transferencias se cortó por no responder'));
    }
    if (worker) this._worker = null;
    try {
      await active.worker.terminate();
    } catch {
      /* ya estaba cortado */
    }
    // El diario (en el PC) dice qué carpeta provisional dejó esta operación: se lee con el hilo nuevo.
    let pendientes = [];
    try {
      pendientes = (await this._call('listPending')).filter((p) => Date.parse(p.creada) >= active.started - 1000);
    } catch {
      /* sin diario no hay nombre exacto */
    }
    const nombres = pendientes.map((p) => p.ruta);
    const aviso = nombres.length
      ? `Cancelada a la fuerza porque el disco no respondía. Puede quedar la carpeta «${nombres.join('», «')}»: revísala y bórrala cuando el disco responda. Los originales no se tocaron.`
      : 'Cancelada a la fuerza porque el disco no respondía. Los originales no se tocaron.';
    this.emit('forced-cancel', { method: active.method, pendientes: nombres });
    if (!entry) return;
    if (active.method === 'verifyRecord') return entry.reject(new Error(aviso));
    const info = this._plans.get(active.planId) || {};
    entry.resolve({
      runId: null,
      estado: 'cancelada',
      abortada: true,
      forzada: true,
      aviso,
      pendientes: nombres,
      verificacion: null,
      avisoVerificacion: null,
      destinoRaiz: info.destinationRoot || null,
      totales: info.totals || null,
      carpetas: [],
    });
  }

  /** Vuelve a comprobar una copia anterior (por el id de su registro). */
  verifyRecord(id, options) {
    return this._call('verifyRecord', id, options);
  }

  listRecords() {
    return this._call('listRecords');
  }

  removeRecord(id) {
    return this._call('removeRecord', id);
  }

  /** Carpetas «….copiando» que quedaron de una sesión anterior (del diario). */
  listPending() {
    return this._call('listPending');
  }

  cleanPending(ruta) {
    return this._call('cleanPending', ruta);
  }

  quitarCopiado(runId) {
    return this._call('quitarCopiado', runId);
  }

  /**
   * Borra definitivamente los originales de carpetas de un resultado ya terminado cuya Papelera falló.
   * Vuelve a comprobar todo y rechaza índices que no correspondan. `confirm` debe ser exactamente `true`.
   */
  eliminarDefinitivamente(runId, indices, confirm) {
    return this._call('eliminarDefinitivamente', runId, indices, confirm);
  }

  async close() {
    const worker = this._worker;
    this._worker = null;
    for (const [id, entry] of this._pending) {
      this._pending.delete(id);
      entry.reject(new Error('El servicio se cerró'));
    }
    if (worker) await worker.terminate();
  }
}

module.exports = { TransferService };
