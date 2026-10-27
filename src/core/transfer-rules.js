'use strict';

/**
 * Reglas PURAS para copiar y transferir carpetas a otro disco. No tocan el disco: se
 * pueden probar con casos límite y de ataque, y las usan el motor (transfer.js) y las
 * pantallas futuras para explicar por qué algo se bloquea.
 */

const path = require('node:path');

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/**
 * Límites por formato del destino.
 *  - maxFileBytes: tamaño máximo de UN archivo (null = sin límite práctico).
 *  - mtimeToleranceMs: cuánto puede diferir la fecha de modificación al copiar (FAT y exFAT
 *    guardan fechas con resolución de 2 segundos; NTFS casi exacta).
 *  - maxEntriesPerFolder: entradas por carpeta a partir de las cuales se avisa (null = no aplica).
 *  - warnFileAtLeastBytes: en formatos que no se conocen, se avisa si algún archivo mide 4 GiB o más.
 */
const FS_LIMITS = Object.freeze({
  NTFS: Object.freeze({ maxFileBytes: null, mtimeToleranceMs: 2, maxEntriesPerFolder: null, warnFileAtLeastBytes: null }),
  ReFS: Object.freeze({ maxFileBytes: null, mtimeToleranceMs: 2, maxEntriesPerFolder: null, warnFileAtLeastBytes: null }),
  exFAT: Object.freeze({ maxFileBytes: null, mtimeToleranceMs: 2000, maxEntriesPerFolder: null, warnFileAtLeastBytes: null }),
  FAT32: Object.freeze({ maxFileBytes: 4294967295, mtimeToleranceMs: 2000, maxEntriesPerFolder: 20000, warnFileAtLeastBytes: null }),
  FAT: Object.freeze({ maxFileBytes: 2147483647, mtimeToleranceMs: 2000, maxEntriesPerFolder: 20000, warnFileAtLeastBytes: null }),
  desconocido: Object.freeze({ maxFileBytes: null, mtimeToleranceMs: 2000, maxEntriesPerFolder: null, warnFileAtLeastBytes: 4 * GIB }),
});

function limitsFor(fileSystem) {
  return FS_LIMITS[fileSystem] || FS_LIMITS.desconocido; // "otro" y lo demás: se trata con cautela
}

// --- Espacio ----------------------------------------------------------------

/** Margen de espacio libre: el mayor entre 64 MB y el 1 % de lo que se va a copiar. */
function freeSpaceMargin(totalBytes) {
  return Math.max(64 * MIB, Math.ceil(totalBytes * 0.01));
}

function requiredFreeBytes(totalBytes) {
  return totalBytes + freeSpaceMargin(totalBytes);
}

// --- Nombres ------------------------------------------------------------------

const RESERVED_NAMES = Object.freeze(new Set(['CON', 'PRN', 'AUX', 'NUL', ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]));
const INVALID_CHARS = /[<>:"/\\|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_NAME_LENGTH = 255;

/**
 * Problemas de un nombre de archivo o carpeta para un destino con letra de unidad
 * (las reglas de Windows valen para NTFS, exFAT, FAT32 y FAT).
 * @param {string} name Solo el nombre, sin ruta.
 * @param {string} fileSystem Formato del destino (hoy no cambia las reglas; se conserva para futuro).
 * @param {{siblings?: string[]}} [options] Nombres hermanos, para detectar choques de mayúsculas.
 * @returns {Array<{code: string, message: string}>} Lista vacía si el nombre es válido.
 */
function checkName(name, fileSystem, { siblings = [] } = {}) {
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (typeof name !== 'string' || name.length === 0) {
    add('vacio', 'El nombre está vacío');
    return problems;
  }
  if (name === '.' || name === '..') add('punto', `«${name}» no es un nombre válido`);
  if (name.length > MAX_NAME_LENGTH) add('demasiado-largo', `El nombre supera ${MAX_NAME_LENGTH} caracteres`);
  const bad = [...new Set(name.split('').filter((c) => INVALID_CHARS.test(c)))];
  if (bad.length) add('caracter-invalido', `Tiene caracteres que Windows no permite en nombres: ${bad.join(' ')}`);
  if (CONTROL_CHARS.test(name)) add('control', 'Tiene caracteres de control (invisibles)');
  if (/[ .]$/.test(name) && name !== '.' && name !== '..') add('termina-en-espacio-o-punto', 'Termina en espacio o en punto, y Windows no lo permite');
  const base = name.split('.')[0].replace(/ +$/, '').toUpperCase();
  if (RESERVED_NAMES.has(base)) add('reservado', `«${base}» es un nombre reservado de Windows (con o sin extensión)`);
  const lower = name.toLowerCase();
  const clash = siblings.find((s) => s !== name && typeof s === 'string' && s.toLowerCase() === lower);
  if (clash !== undefined) add('colision-mayusculas', `Choca con «${clash}»: el destino no distingue mayúsculas de minúsculas`);
  return problems;
}

/** Largo de una ruta de destino. Aviso por encima de 240 caracteres (el Explorador falla desde 260). */
const PATH_WARN_LENGTH = 240;
function checkPathLength(destPath) {
  const length = typeof destPath === 'string' ? destPath.length : 0;
  return { length, warning: length > PATH_WARN_LENGTH, limit: PATH_WARN_LENGTH };
}

// --- Rutas ------------------------------------------------------------------------

const DRIVE = /^[A-Za-z]:/;

function isWindowsStyle(p) {
  return typeof p === 'string' && (DRIVE.test(p) || p.includes('\\') || /^\/\//.test(p));
}

/**
 * Normaliza una ruta para comparar: Windows -> {kind:'win', root, parts} sin distinguir
 * mayúsculas, con "/" y "\", resolviendo "." y "..", ignorando espacios y puntos finales
 * de cada nombre y el prefijo \\?\; otras rutas -> {kind:'posix', root:'/', parts}.
 * Devuelve null si la ruta no es absoluta o no es un texto válido.
 */
function normalizePath(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
  if (isWindowsStyle(p)) {
    let s = p.replace(/^[\\/]{2}[?.][\\/](?=[a-zA-Z]:)/, '');
    const { root } = path.win32.parse(s);
    if (root === '' || /^[a-zA-Z]:$/.test(root)) return null; // relativa o relativa a la unidad
    let rootKey;
    if (/^[\\/]{2}/.test(root)) rootKey = root.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase(); // \\servidor\recurso
    else if (DRIVE.test(root)) rootKey = `${root[0].toLowerCase()}:`;
    else rootKey = '\\';
    const parts = [];
    for (const raw of s.slice(root.length).split(/[\\/]+/)) {
      if (raw === '' || raw === '.') continue;
      if (raw === '..') {
        parts.pop();
        continue;
      }
      const name = raw.split(':')[0].replace(/[ .]+$/, '');
      if (name === '') continue;
      parts.push(name.toLowerCase());
    }
    return { kind: 'win', root: rootKey, parts };
  }
  if (!p.startsWith('/')) return null;
  const parts = [];
  for (const raw of p.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return { kind: 'posix', root: '/', parts };
}

/** ¿`child` está dentro de `parent`, o es la misma ruta? (Windows: sin mayúsculas, con "..", barras mixtas y prefijos engañosos). */
function isInside(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p || c.kind !== p.kind || c.root !== p.root) return false;
  if (c.parts.length < p.parts.length) return false;
  return p.parts.every((part, i) => part === c.parts[i]);
}

/**
 * ¿Misma unidad? Solo por letra (o \\servidor\recurso). Con rutas que no son de Windows no se
 * puede saber sin consultar el disco: devuelve false (el motor usa st_dev para eso).
 */
function sameVolume(a, b) {
  const x = normalizePath(a);
  const y = normalizePath(b);
  return Boolean(x && y && x.kind === 'win' && y.kind === 'win' && x.root === y.root);
}

// --- Papelera ------------------------------------------------------------------------

/**
 * La Papelera de Windows tiene una cuota por volumen que el usuario puede configurar y que no se
 * puede leer sin permisos especiales. Regla CONSERVADORA y estimada: si lo que se va a enviar
 * supera el 5 % del tamaño del volumen de origen, se avisa que puede no caber.
 */
const RECYCLE_FRACTION = 0.05;

function recycleVerdict({ bytes, source } = {}) {
  const driveType = source && source.driveType;
  const sizeBytes = source && source.sizeBytes;
  if (driveType === 'removable' || driveType === 'network' || driveType === 'cdrom') {
    return { verdict: 'sin-papelera', reason: 'Los discos extraíbles y de red no tienen Papelera: lo que se elimine no se puede recuperar de ahí.' };
  }
  if (driveType !== 'fixed' || !(typeof sizeBytes === 'number' && sizeBytes > 0) || !(typeof bytes === 'number' && bytes >= 0)) {
    return { verdict: 'desconocido', reason: 'No se pudo saber el tipo o el tamaño del disco de origen, así que no se puede estimar si cabe en la Papelera.' };
  }
  if (bytes > RECYCLE_FRACTION * sizeBytes) {
    return { verdict: 'puede-no-caber', reason: 'Esto es más del 5 % del disco de origen: la Papelera puede no tener espacio y Windows podría pedir eliminarlo de forma definitiva.' };
  }
  return { verdict: 'probablemente-cabe', reason: 'El tamaño es pequeño frente al disco de origen; es probable que quepa en la Papelera.' };
}

// --- Fechas -----------------------------------------------------------------------------

/** ¿Las dos fechas (ms) son iguales dentro de la tolerancia del formato? */
function mtimeClose(a, b, fileSystem) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= limitsFor(fileSystem).mtimeToleranceMs;
}

module.exports = {
  GIB,
  FS_LIMITS,
  limitsFor,
  freeSpaceMargin,
  requiredFreeBytes,
  RESERVED_NAMES,
  checkName,
  PATH_WARN_LENGTH,
  checkPathLength,
  normalizePath,
  isInside,
  sameVolume,
  RECYCLE_FRACTION,
  recycleVerdict,
  mtimeClose,
};
