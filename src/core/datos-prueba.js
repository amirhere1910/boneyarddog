'use strict';

/**
 * Datos de prueba que la propia app puede crear (y borrar) en Documentos\BoneYardDog-Prueba.
 * Parte PURA (sin disco): el plan de carpetas, sus validaciones, el cálculo de espacio y la regla de la
 * MARCA `.byd-prueba` que decide si se puede borrar. La parte que escribe y borra está en
 * src/main/datos-prueba-service.js.
 *
 * Sobre las fechas: Node puede cambiar la fecha de MODIFICACIÓN (fs.utimes), pero NO la de CREACIÓN en
 * Windows. Los archivos recién creados siempre tienen fecha de creación de hoy; por eso la pantalla ofrece
 * «Para esta prueba, ignorar la fecha de creación» (useCreationTime: false). Está documentado en docs/.
 */

const MB = 1024 * 1024;
const GIB = 1024 * MB;
const ROOT_NAME = 'BoneYardDog-Prueba';
const MARK_NAME = '.byd-prueba';
const MARK_APP = 'BoneYardDog';
/** Nunca se escribe más de 1 GiB en total. */
const MAX_TOTAL_BYTES = GIB;
const MAX_FOLDERS = 20;
const MAX_FILES = 200;

/**
 * Cinco carpetas de 50 a 300 MB, con tildes, ñ, espacios y emoji, subcarpetas y una carpeta vacía.
 * `daysAgo`: antigüedad de la fecha de modificación de TODO lo que contiene.
 */
const PLAN = Object.freeze([
  {
    name: 'Fotos de vacaciones 🌴',
    daysAgo: 400,
    files: [
      { path: 'Playa/foto 01.jpg', bytes: 60 * MB },
      { path: 'Playa/foto 02.jpg', bytes: 60 * MB },
      { path: 'Montaña/video ñandú.mp4', bytes: 100 * MB },
      { path: 'leeme.txt', bytes: 2000 },
    ],
    emptyDirs: ['Pendientes por ordenar'],
  },
  {
    name: 'Música y canciones ñandú',
    daysAgo: 200,
    files: [
      { path: 'Álbum 1/canción 1.mp3', bytes: 40 * MB },
      { path: 'Álbum 1/canción 2.mp3', bytes: 40 * MB },
      { path: 'Álbum 2/canción única.mp3', bytes: 40 * MB },
    ],
    emptyDirs: [],
  },
  {
    name: 'Proyecto antiguo (copia de seguridad)',
    daysAgo: 100,
    files: [
      { path: 'datos/tabla grande.bin', bytes: 150 * MB },
      { path: 'datos/hondo/más hondo/registro.bin', bytes: 100 * MB },
      { path: 'datos/hondo/otro.bin', bytes: 50 * MB },
      { path: 'notas.txt', bytes: 1500 },
    ],
    emptyDirs: [],
  },
  {
    name: 'Documentos del año pasado',
    daysAgo: 30,
    files: [
      { path: 'informe final.pdf', bytes: 30 * MB },
      { path: 'cuentas/resumen.xlsx', bytes: 30 * MB },
    ],
    emptyDirs: [],
  },
  {
    name: 'Trabajo reciente',
    daysAgo: 2,
    files: [{ path: 'borrador.docx', bytes: 50 * MB }],
    emptyDirs: [],
  },
]);

// ----------------------------------------------------------------------------- validaciones

const FORBIDDEN_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** ¿Un nombre (de una carpeta o archivo) es válido en Windows? */
function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && !FORBIDDEN_CHARS.test(name) && !/[ .]$/.test(name) && name !== '.' && name !== '..' && !RESERVED.test(name) && name !== MARK_NAME;
}

/** Ruta relativa con «/»: cada parte debe ser un nombre válido, sin «..» ni partes vacías. */
function validRelPath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > 200) return false;
  return rel.split('/').every(validName);
}

function planTotals(plan = PLAN) {
  let bytes = 0;
  let files = 0;
  let dirs = 0;
  for (const folder of plan) {
    dirs += 1 + (folder.emptyDirs || []).length;
    const sub = new Set();
    for (const f of folder.files) {
      bytes += f.bytes;
      files++;
      const parts = f.path.split('/');
      for (let i = 1; i < parts.length; i++) sub.add(parts.slice(0, i).join('/'));
    }
    dirs += sub.size;
  }
  return { bytes, files, dirs, folders: plan.length };
}

/**
 * Valida un plan. Devuelve la lista de problemas (vacía = bueno).
 * Nombres válidos de Windows, sin repetidos (ni por mayúsculas), tamaños enteros, tope de 1 GiB.
 */
function validatePlan(plan = PLAN) {
  const problems = [];
  if (!Array.isArray(plan) || plan.length === 0) return ['El plan está vacío'];
  if (plan.length > MAX_FOLDERS) problems.push(`Demasiadas carpetas (máximo ${MAX_FOLDERS})`);
  const seen = new Set();
  let files = 0;
  for (const folder of plan) {
    if (!folder || !validName(folder.name)) {
      problems.push(`Nombre de carpeta no válido: ${String(folder && folder.name)}`);
      continue;
    }
    const key = folder.name.toLowerCase();
    if (seen.has(key)) problems.push(`Carpeta repetida: ${folder.name}`);
    seen.add(key);
    if (!Number.isFinite(folder.daysAgo) || folder.daysAgo < 0 || folder.daysAgo > 36500) problems.push(`Antigüedad no válida en ${folder.name}`);
    if (!Array.isArray(folder.files) || folder.files.length === 0) problems.push(`${folder.name} no tiene archivos`);
    const paths = new Set();
    for (const f of folder.files || []) {
      files++;
      if (!f || !validRelPath(f.path)) problems.push(`Ruta no válida en ${folder.name}: ${String(f && f.path)}`);
      else if (paths.has(f.path.toLowerCase())) problems.push(`Archivo repetido en ${folder.name}: ${f.path}`);
      else paths.add(f.path.toLowerCase());
      if (!f || !Number.isInteger(f.bytes) || f.bytes < 0) problems.push(`Tamaño no válido en ${folder.name}: ${String(f && f.path)}`);
    }
    for (const d of folder.emptyDirs || []) if (!validRelPath(d)) problems.push(`Carpeta vacía no válida en ${folder.name}: ${String(d)}`);
  }
  if (files > MAX_FILES) problems.push(`Demasiados archivos (máximo ${MAX_FILES})`);
  const total = planTotals(plan.filter((x) => x && Array.isArray(x.files))).bytes;
  if (total > MAX_TOTAL_BYTES) problems.push('El plan escribiría más de 1 GB');
  return problems;
}

/** Espacio libre que hace falta: lo que se escribe más un margen (el mayor entre 256 MB y el 10 %). */
function neededFreeBytes(totalBytes) {
  return totalBytes + Math.max(256 * MB, Math.ceil(totalBytes * 0.1));
}

/** ¿Hay espacio suficiente? `freeBytes` desconocido (null) NO basta: no se escribe a ciegas. */
function checkSpace(freeBytes, totalBytes) {
  const needed = neededFreeBytes(totalBytes);
  if (typeof freeBytes !== 'number' || !Number.isFinite(freeBytes)) return { ok: false, needed, reason: 'No se pudo saber cuánto espacio libre hay en el disco de Documentos, así que no se crea nada.' };
  if (freeBytes < needed) return { ok: false, needed, reason: `No hay espacio suficiente en el disco de Documentos: hacen falta ${Math.ceil(needed / MB)} MB libres y hay ${Math.floor(freeBytes / MB)} MB.` };
  return { ok: true, needed, reason: null };
}

// ----------------------------------------------------------------------------------- la marca

/** Contenido de la marca `.byd-prueba` (JSON): qué app la creó y qué carpetas contiene. */
function markerContent({ version = '0.0.0', now = Date.now(), plan = PLAN } = {}) {
  return JSON.stringify({ app: MARK_APP, tipo: 'datos-de-prueba', version, creada: new Date(now).toISOString(), carpetas: plan.map((f) => f.name) }, null, 2);
}

/** Interpreta la marca. Devuelve null si no es una marca válida de BoneYardDog. */
function parseMarker(text) {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > 20000) return null;
    const m = JSON.parse(text);
    if (!m || typeof m !== 'object' || m.app !== MARK_APP || m.tipo !== 'datos-de-prueba' || !Array.isArray(m.carpetas)) return null;
    if (!m.carpetas.every((n) => typeof n === 'string' && validName(n))) return null;
    return { carpetas: m.carpetas, creada: String(m.creada || ''), version: String(m.version || '') };
  } catch {
    return null;
  }
}

/**
 * REGLA DE LA MARCA: ¿se puede borrar esta carpeta de datos de prueba?
 * Solo si TODO se cumple: existe y es una carpeta de verdad (no un enlace), su ruta real es ella misma,
 * contiene una marca válida creada por la app, y lo que hay dentro son SOLO las carpetas de la marca
 * (más la marca): si el usuario guardó algo propio ahí, NO se borra nada.
 * @param {{exists: boolean, isDirectory: boolean, isLink: boolean, realPathIsSame: boolean, markerText: string|null, entries: string[]}} info
 * @returns {{ok: boolean, reason: string|null, extra?: string[]}}
 */
function checkRemovable(info) {
  if (!info || !info.exists) return { ok: false, reason: 'No hay datos de prueba que borrar.' };
  if (info.isLink || !info.isDirectory) return { ok: false, reason: `«${ROOT_NAME}» no es una carpeta normal (es un enlace u otra cosa): no se toca.` };
  if (!info.realPathIsSame) return { ok: false, reason: `La ruta de «${ROOT_NAME}» pasa por un enlace: no se toca.` };
  const mark = parseMarker(info.markerText);
  if (!mark) return { ok: false, reason: `«${ROOT_NAME}» no tiene la marca ${MARK_NAME} de BoneYardDog (o está dañada): por seguridad no se borra nada. Si la creaste tú, bórrala a mano desde el Explorador.` };
  const allowed = new Set([MARK_NAME, ...mark.carpetas]);
  const extra = (info.entries || []).filter((n) => !allowed.has(n));
  if (extra.length > 0) return { ok: false, reason: `Hay archivos o carpetas que no son de la prueba dentro de «${ROOT_NAME}» (${extra.slice(0, 5).join(', ')}): por seguridad no se borra nada.`, extra };
  return { ok: true, reason: null };
}

module.exports = {
  MB,
  GIB,
  ROOT_NAME,
  MARK_NAME,
  MAX_TOTAL_BYTES,
  PLAN,
  validName,
  validRelPath,
  planTotals,
  validatePlan,
  neededFreeBytes,
  checkSpace,
  markerContent,
  parseMarker,
  checkRemovable,
};
