'use strict';

/**
 * Crea y borra los datos de prueba (Documentos\BoneYardDog-Prueba). Es la parte con disco de
 * src/core/datos-prueba.js (que decide qué se crea y cuándo se puede borrar).
 *
 * La ruta NUNCA viene de la interfaz: la fija el proceso principal (carpeta Documentos + nombre fijo).
 * Lo único que borra esta clase es esa carpeta, y solo si tiene la marca `.byd-prueba` y nada ajeno dentro
 * (`removeRoot`; una prueba revisa el código fuente).
 */

const nodePath = require('node:path');
const crypto = require('node:crypto');
const T = require('../core/datos-prueba');

const CHUNK = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

class AbortedError extends Error {
  constructor() {
    super('Creación cancelada');
    this.name = 'AbortedError';
  }
}

/**
 * @param {object} options
 * @param {() => string} options.documentsDir Carpeta Documentos (la da el proceso principal).
 * @param {object} [options.fs] Para pruebas.
 * @param {string} [options.version]
 * @param {() => number} [options.now]
 */
function createTestDataService({ documentsDir, fs = require('node:fs'), version = '0.0.0', now = () => Date.now() } = {}) {
  const fsp = fs.promises;
  const rootPath = () => nodePath.join(documentsDir(), T.ROOT_NAME);

  /** Mira la carpeta SIN tocarla. */
  async function inspect() {
    const root = rootPath();
    const info = { path: root, exists: false, isDirectory: false, isLink: false, realPathIsSame: false, markerText: null, entries: [] };
    let st;
    try {
      st = await fsp.lstat(root);
    } catch {
      return info;
    }
    info.exists = true;
    info.isLink = st.isSymbolicLink();
    info.isDirectory = st.isDirectory();
    if (!info.isDirectory || info.isLink) return info;
    try {
      const real = await fsp.realpath(root);
      const parent = await fsp.realpath(documentsDir());
      info.realPathIsSame = real === nodePath.join(parent, T.ROOT_NAME) || real.toLowerCase() === nodePath.join(parent, T.ROOT_NAME).toLowerCase();
    } catch {
      info.realPathIsSame = false;
    }
    try {
      const mark = nodePath.join(root, T.MARK_NAME);
      const ms = await fsp.lstat(mark);
      if (ms.isFile() && ms.size < 20000) info.markerText = await fsp.readFile(mark, 'utf8');
    } catch {
      info.markerText = null;
    }
    try {
      info.entries = await fsp.readdir(root);
    } catch {
      info.entries = [];
    }
    return info;
  }

  async function status() {
    const info = await inspect();
    const verdict = T.checkRemovable(info);
    return { path: info.path, exists: info.exists, marked: T.parseMarker(info.markerText) !== null, removable: verdict.ok, reason: verdict.ok ? null : verdict.reason };
  }

  /** Espacio libre del disco de Documentos (null si no se puede saber). */
  async function freeBytes() {
    try {
      if (typeof fsp.statfs !== 'function') return null;
      const s = await fsp.statfs(documentsDir());
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) ? free : null;
    } catch {
      return null;
    }
  }

  /** ÚNICO lugar que borra: la carpeta de datos de prueba, tras la regla de la marca. */
  async function removeRoot() {
    const info = await inspect();
    const verdict = T.checkRemovable(info);
    if (!verdict.ok) throw Object.assign(new Error(verdict.reason), { code: 'NO_SE_BORRA' });
    await fsp.rm(info.path, { recursive: true, force: false });
    return { path: info.path };
  }

  /**
   * Crea los datos de prueba. Antes de escribir nada: plan válido, no existen ya, y hay espacio de sobra.
   * Si se cancela o falla, quita lo que esta operación creó (la marca se escribe PRIMERO, así la regla permite borrarlo).
   */
  async function create({ plan = T.PLAN, onProgress, signal, randomFill = (buf) => crypto.randomFillSync(buf) } = {}) {
    const problems = T.validatePlan(plan);
    if (problems.length) throw new Error(`El plan de datos de prueba no es válido: ${problems[0]}`);
    const totals = T.planTotals(plan);
    const root = rootPath();
    const before = await inspect();
    if (before.exists) throw Object.assign(new Error('Ya existen datos de prueba. Bórralos primero (botón «Borrar datos de prueba») o escanéalos tal como están.'), { code: 'YA_EXISTEN' });
    const space = T.checkSpace(await freeBytes(), totals.bytes);
    if (!space.ok) throw Object.assign(new Error(space.reason), { code: 'SIN_ESPACIO' });
    try {
      await fsp.stat(documentsDir());
    } catch {
      throw Object.assign(new Error('No se encontró la carpeta Documentos.'), { code: 'SIN_DOCUMENTOS' });
    }

    const startedAt = now();
    let bytesDone = 0;
    let filesDone = 0;
    let lastEmit = 0;
    const emit = (current, force) => {
      if (!onProgress) return;
      const t = Date.now();
      if (!force && t - lastEmit < 100) return;
      lastEmit = t;
      onProgress({ bytesDone, bytesTotal: totals.bytes, filesDone, filesTotal: totals.files, current });
    };
    const check = () => {
      if (signal && signal.aborted) throw new AbortedError();
    };

    let createdRoot = false;
    try {
      await fsp.mkdir(root); // sin recursive: si apareció algo mientras tanto, es un error
      createdRoot = true;
      await fsp.writeFile(nodePath.join(root, T.MARK_NAME), T.markerContent({ version, now: startedAt, plan }), { flag: 'wx' });
      const buf = Buffer.allocUnsafe(CHUNK);
      const dirsByFolder = [];
      for (const folder of plan) {
        check();
        const base = nodePath.join(root, folder.name);
        await fsp.mkdir(base);
        const dirs = new Set();
        for (const d of folder.emptyDirs || []) {
          await fsp.mkdir(nodePath.join(base, ...d.split('/')), { recursive: true });
          dirs.add(d);
        }
        const when = new Date(startedAt - folder.daysAgo * DAY);
        for (const f of folder.files) {
          check();
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const sub = parts.slice(0, i).join('/');
            if (!dirs.has(sub)) {
              await fsp.mkdir(nodePath.join(base, ...parts.slice(0, i)), { recursive: true });
              dirs.add(sub);
            }
          }
          const file = nodePath.join(base, ...parts);
          const h = await fsp.open(file, 'wx');
          try {
            let left = f.bytes;
            while (left > 0) {
              check();
              const n = Math.min(left, CHUNK);
              randomFill(buf.subarray(0, n)); // datos nuevos en cada trozo: nada se repite
              let off = 0;
              while (off < n) off += (await h.write(buf, off, n - off, null)).bytesWritten;
              left -= n;
              bytesDone += n;
              emit(`${folder.name}/${f.path}`);
            }
            await h.sync();
          } finally {
            await h.close();
          }
          await fsp.utimes(file, when, when); // fecha de modificación (la de creación no se puede cambiar en Windows)
          filesDone++;
          emit(`${folder.name}/${f.path}`, true);
        }
        dirsByFolder.push({ base, when, dirs: [...dirs] });
      }
      // Las fechas de las carpetas, de las más hondas a la raíz (escribir dentro cambia la fecha de la carpeta).
      for (const { base, when, dirs } of dirsByFolder) {
        for (const d of dirs.sort((a, b) => b.split('/').length - a.split('/').length)) await fsp.utimes(nodePath.join(base, ...d.split('/')), when, when);
        await fsp.utimes(base, when, when);
      }
      emit('', true);
      return { path: root, folders: totals.folders, files: totals.files, bytes: totals.bytes, names: plan.map((f) => f.name) };
    } catch (err) {
      // Se quita lo que esta operación creó (la regla de la marca lo permite porque la marca se escribió primero).
      if (createdRoot) await removeRoot().catch(() => {});
      throw err;
    }
  }

  return { rootPath, inspect, status, create, removeRoot, freeBytes };
}

module.exports = { createTestDataService, AbortedError };
