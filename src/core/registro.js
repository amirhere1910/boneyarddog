'use strict';

/**
 * Registro de copias en EL PC (no en el destino): por cada carpeta copiada y verificada, un archivo
 * `<id>.json` en la carpeta de datos de la app con lo necesario para verificarla más tarde (nombre final,
 * origen y destino, fecha, modo, tipo de verificación y, por archivo: ruta relativa, tamaño, fecha de
 * modificación y SHA-256). El registro NO hace falta para que una copia sea válida: es solo para poder
 * comprobarla después («Copias anteriores»).
 *
 * Además lleva un diario de carpetas provisionales (`pendientes.json`): las carpetas «….copiando» que esta app
 * creó y todavía no terminó o no pudo limpiar. Es lo único que permite a la app borrar una carpeta
 * «….copiando» ajena a la sesión actual (por ejemplo tras un cierre forzado).
 *
 * Escritura atómica (archivo temporal + rename). Conserva los últimos 200 registros. Un archivo dañado, de otra
 * versión o con un formato raro se IGNORA sin romper nada.
 */

const nodePath = require('node:path');
const crypto = require('node:crypto');

const MAX_RECORDS = 200;
const VERSION = 1;
const ID_RE = /^[0-9a-f]{16}$/;
const MAX_FILE_BYTES = 256 * 1024 * 1024; // un registro enorme (millones de archivos) no se lee entero a ciegas

const isId = (id) => typeof id === 'string' && ID_RE.test(id);

/** Un registro válido tiene exactamente la forma que escribe el motor; todo lo demás se descarta. */
function validRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.version !== VERSION) return false;
  if (!isId(r.id)) return false;
  for (const k of ['nombre', 'origen', 'destino', 'destinoRaiz', 'fecha', 'modo', 'verificacion', 'sistemaDeArchivos']) if (typeof r[k] !== 'string' || r[k] === '') return false;
  if (!['copy', 'move'].includes(r.modo) || !['full', 'quick'].includes(r.verificacion)) return false;
  if (!Array.isArray(r.archivos) || !Array.isArray(r.carpetasVacias)) return false;
  if (!Number.isFinite(r.totalBytes) || r.totalBytes < 0) return false;
  for (const a of r.archivos) {
    if (!a || typeof a.ruta !== 'string' || a.ruta === '' || !Number.isFinite(a.tamano) || a.tamano < 0 || !Number.isFinite(a.mtimeMs)) return false;
    if (a.sha256 !== null && !(typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256))) return false;
  }
  return true;
}

function createRegistry({ fs = require('node:fs'), dir, now = () => Date.now(), maxRecords = MAX_RECORDS } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new Error('Falta la carpeta del registro');
  const fsp = fs.promises;
  const fileOf = (id) => nodePath.join(dir, `${id}.json`);
  const journalFile = nodePath.join(dir, 'pendientes.json');

  async function atomicWrite(file, text) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fsp.writeFile(tmp, text, { flag: 'wx' });
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {}); // el temporal es nuestro
      throw err;
    }
  }

  async function readJson(file) {
    try {
      const st = await fsp.stat(file);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Guarda un registro nuevo. Devuelve el id. */
  async function save(record) {
    const id = isId(record && record.id) ? record.id : crypto.randomBytes(8).toString('hex');
    const full = { ...record, version: VERSION, id, fecha: record.fecha || new Date(now()).toISOString() };
    if (!validRecord(full)) throw new Error('El registro no tiene el formato esperado');
    await atomicWrite(fileOf(id), JSON.stringify(full));
    await prune().catch(() => {});
    return id;
  }

  async function ids() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    return names.filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => n.slice(0, 16));
  }

  async function get(id) {
    if (!isId(id)) return null;
    const r = await readJson(fileOf(id));
    return validRecord(r) && r.id === id ? r : null;
  }

  /** Lista resumida (sin los archivos), de la más reciente a la más antigua. Lo dañado se ignora. */
  async function list() {
    const out = [];
    for (const id of await ids()) {
      const r = await get(id);
      if (!r) continue;
      const { archivos, carpetasVacias, ...resumen } = r;
      out.push({ ...resumen, archivosTotal: archivos.length, carpetasVaciasTotal: carpetasVacias.length });
    }
    out.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));
    return out;
  }

  /** Cambia campos sueltos (por ejemplo qué se hizo con el original). Nunca cambia id, versión ni archivos. */
  async function update(id, patch) {
    const r = await get(id);
    if (!r) return false;
    const { id: _i, version: _v, archivos: _a, ...safe } = patch || {};
    const next = { ...r, ...safe };
    if (!validRecord(next)) return false;
    await atomicWrite(fileOf(id), JSON.stringify(next));
    return true;
  }

  /** Quita UN registro (solo el archivo de ese id dentro de la carpeta del registro). */
  async function remove(id) {
    if (!isId(id)) return false;
    try {
      await fsp.unlink(fileOf(id));
      return true;
    } catch {
      return false;
    }
  }

  async function prune() {
    const all = await list();
    for (const old of all.slice(maxRecords)) await remove(old.id);
  }

  // ------------------------------------------------------------- diario de carpetas provisionales

  async function journal() {
    const j = await readJson(journalFile);
    if (!j || j.version !== VERSION || !Array.isArray(j.pendientes)) return [];
    return j.pendientes.filter((p) => p && typeof p.ruta === 'string' && typeof p.raiz === 'string' && typeof p.creada === 'string');
  }

  async function writeJournal(list) {
    await atomicWrite(journalFile, JSON.stringify({ version: VERSION, pendientes: list }));
  }

  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };

  /** Anota una carpeta provisional que esta app acaba de crear: { ruta, raiz, origen }. */
  const addPending = ({ ruta, raiz, origen }) =>
    serial(async () => {
      const list = (await journal()).filter((p) => p.ruta !== ruta);
      list.push({ ruta, raiz, origen: origen || null, creada: new Date(now()).toISOString() });
      await writeJournal(list);
    });

  /** Quita la anotación (la carpeta se terminó o se limpió). */
  const removePending = (ruta) =>
    serial(async () => {
      const list = await journal();
      const rest = list.filter((p) => p.ruta !== ruta);
      if (rest.length !== list.length) await writeJournal(rest);
    });

  const listPending = () => serial(() => journal());

  return { save, get, list, update, remove, addPending, removePending, listPending, dir };
}

module.exports = { createRegistry, validRecord, isId, MAX_RECORDS, VERSION };
