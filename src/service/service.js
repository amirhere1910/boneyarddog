'use strict';

/**
 * AnalysisService: puerta de entrada al análisis.
 *
 * El árbol completo vive solo dentro de un worker_thread (analysis-worker.js)
 * y NUNCA viaja a quien usa este servicio (la interfaz). Cada método devuelve
 * una promesa con un resultado pequeño. El que llama solo manda rutas, nunca
 * datos de nodos: el worker busca cada ruta en su propio árbol.
 *
 * Eventos (EventEmitter):
 *   'progress' -> { filesSeen, bytes, currentPath }   durante un escaneo
 *   'worker-error' -> Error                            el hilo falló (las
 *                     promesas pendientes ya fueron rechazadas)
 */

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const WORKER_FILE = path.join(__dirname, 'analysis-worker.js');

// Los errores pierden su clase al cruzar entre hilos: se reconstruye la básica.
const ERROR_CLASSES = { TypeError, RangeError };

class AnalysisService extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {() => Worker} [options.workerFactory] Para pruebas: crea el hilo.
   */
  constructor({ workerFactory } = {}) {
    super();
    this._factory = workerFactory || (() => new Worker(WORKER_FILE));
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
        const { filesSeen, bytes, currentPath } = msg;
        this.emit('progress', { filesSeen, bytes, currentPath });
        return;
      }
      const entry = msg && this._pending.get(msg.id);
      if (!entry) return;
      this._pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        const ErrorClass = ERROR_CLASSES[msg.error.name] || Error;
        const err = new ErrorClass(msg.error.message);
        err.code = msg.error.code;
        entry.reject(err);
      }
    });
    // Solo se rechazan las peticiones de ESTE hilo: el aviso tardío de un hilo
    // muerto no debe afectar a las del hilo nuevo.
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
    worker.on('exit', (code) => {
      fail(new Error(`El hilo de análisis terminó inesperadamente (código ${code})`));
    });
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

  /** Escanea una ruta. Un escaneo nuevo reemplaza (y cancela) al anterior. */
  startScan(rootPath) {
    return this._call('startScan', rootPath);
  }

  /** Cancela el escaneo en curso (si lo hay). */
  cancel() {
    return this._call('cancel');
  }

  getChildren(folderPath, options) {
    return this._call('getChildren', folderPath, options);
  }

  getLargestFiles(n) {
    return this._call('getLargestFiles', n);
  }

  getLargestFolders(n) {
    return this._call('getLargestFolders', n);
  }

  getStale(options) {
    return this._call('getStale', options);
  }

  summarizeSelection(paths) {
    return this._call('summarizeSelection', paths);
  }

  /** Cierra el hilo. */
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

module.exports = { AnalysisService };
