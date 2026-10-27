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
   */
  constructor({ trash, workerFactory, progressIntervalMs = 200 } = {}) {
    super();
    this._trash = typeof trash === 'function' ? trash : null;
    this._factory = workerFactory || (() => new Worker(WORKER_FILE, { workerData: { hasTrash: this._trash !== null, progressIntervalMs } }));
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
        this._pending.set(id, { resolve, reject, worker });
        worker.postMessage({ id, method, args });
      } catch (err) {
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Revisa todo antes de copiar. Devuelve impedimentos, avisos y un planId (el plan se queda en el hilo). */
  preflight(options) {
    return this._call('preflight', options);
  }

  /** Ejecuta un plan ya revisado (solo por su planId). */
  run(planId) {
    return this._call('run', planId);
  }

  cancel() {
    return this._call('cancel');
  }

  verifyBatch(batchFolder, options) {
    return this._call('verifyBatch', batchFolder, options);
  }

  quitarCopiado(runId) {
    return this._call('quitarCopiado', runId);
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
