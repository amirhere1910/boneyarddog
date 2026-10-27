'use strict';

// Ayudas compartidas por las pruebas del motor de transferencia. Está FUERA de test/ para que
// `node --test` no la ejecute como si fuera una prueba.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTransferEngine } = require('../src/core/transfer');
const { isProtectedPath } = require('../src/core/protected');

const TMP_BASE = path.join(__dirname, '..', '.test-tmp');
const DAY = 24 * 60 * 60 * 1000;

function tmpDir(t, prefix = 'tr-') {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (isProtectedPath(dir)) throw new Error(`La carpeta de pruebas está protegida: ${dir}`);
  return dir;
}

function write(file, content, mtimeDaysAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeDaysAgo !== undefined) {
    const d = new Date(Date.now() - mtimeDaysAgo * DAY);
    fs.utimesSync(file, d, d);
  }
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Foto de un árbol: { 'rel/ruta': { type, size?, sha? } } con "/" como separador. */
function snapshot(root, { hashes = true } = {}) {
  const out = {};
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        out[r] = { type: 'dir' };
        walk(full, r);
      } else if (st.isSymbolicLink()) out[r] = { type: 'link' };
      else out[r] = hashes ? { type: 'file', size: st.size, sha: sha(full) } : { type: 'file', size: st.size };
    }
  })(root, '');
  return out;
}

/**
 * Carpeta de origen de ejemplo:
 *   <root>/Datos ñandú 🐕 con espacios/
 *     a.txt (fecha vieja), canción.txt, cero.bin (0 bytes), sub/hondo/x.bin, sub/y.txt, vacia/ (carpeta vacía)
 */
function makeSource(root, { big = false } = {}) {
  const src = path.join(root, 'origen', 'Datos ñandú 🐕 con espacios');
  write(path.join(src, 'a.txt'), 'hola mundo', 400);
  write(path.join(src, 'canción.txt'), 'acción: ñandú, tildes, emoji 🐕', 30);
  write(path.join(src, 'cero.bin'), '', 200);
  write(path.join(src, 'sub', 'hondo', 'x.bin'), Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)), 100);
  write(path.join(src, 'sub', 'y.txt'), 'y'.repeat(70000), 50);
  fs.mkdirSync(path.join(src, 'vacia'), { recursive: true });
  const old = new Date(Date.now() - 300 * DAY);
  fs.utimesSync(path.join(src, 'sub', 'hondo'), old, old);
  fs.utimesSync(path.join(src, 'vacia'), old, old);
  if (big) {
    const buf = Buffer.alloc(64 * 1024 * 1024);
    for (let i = 0; i < buf.length; i += 4096) buf.writeUInt32LE(i / 4096, i);
    write(path.join(src, 'grande.bin'), buf, 10);
  }
  return src;
}

const NTFS_FIXED = { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 5e11 };

/**
 * Envuelve fs.promises con un espía. `calls` registra cada llamada.
 *  - before(name, args): puede lanzar para simular un fallo.
 *  - after(name, args, result): puede alterar el disco después de la llamada.
 *  - wrapHandle(handle, args): devuelve el mismo handle (u otro) para alterar lecturas/escrituras.
 */
function spyFs({ before, after, wrapHandle } = {}) {
  const calls = [];
  const promises = new Proxy(fs.promises, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        calls.push({ name: String(prop), args });
        if (before) await before(String(prop), args);
        const out = await value.apply(target, args);
        let result = out;
        if (String(prop) === 'open' && wrapHandle) result = wrapHandle(out, args) || out;
        if (after) await after(String(prop), args, result);
        return result;
      };
    },
  });
  return { fs: { promises, constants: fs.constants }, calls };
}

/** Motor de pruebas: volumen NTFS fijo y Papelera falsa que quita de verdad. */
function makeEngine(base, overrides = {}) {
  const trashed = [];
  const engine = createTransferEngine({
    volumeInfo: async () => ({ ...NTFS_FIXED }),
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    },
    now: () => new Date(2026, 9, 27, 14, 5).getTime(),
    appVersion: '0.0.0-prueba',
    ...overrides,
  });
  return { engine, trashed };
}

function makeDest(base) {
  const dest = path.join(base, 'destino');
  fs.mkdirSync(dest, { recursive: true });
  return dest;
}

/** Llamadas que podrían eliminar o renombrar algo. */
const DESTRUCTIVE = new Set(['unlink', 'rm', 'rmdir', 'rename', 'truncate', 'rmSync', 'unlinkSync', 'renameSync']);

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

module.exports = { fs, path, TMP_BASE, DAY, tmpDir, write, sha, snapshot, makeSource, spyFs, makeEngine, makeDest, NTFS_FIXED, DESTRUCTIVE, isInside, createTransferEngine };
