'use strict';

/**
 * Reglas de análisis. Funciones puras: reciben el árbol que produce
 * scanner.js y NO tocan el disco.
 *
 * Fechas: números en milisegundos desde 1970 (igual que el árbol).
 *
 * PROTECCIONES: findStale y summarize usan `isProtected(ruta) -> boolean`
 * (por defecto isProtectedPath de protected.js; se puede reemplazar con la
 * opción `isProtected`). Un nodo protegido, o una carpeta que contiene algo
 * protegido, NUNCA se ofrece como un todo para eliminar o mover: se informa
 * aparte y se excluye de los totales.
 */

const path = require('node:path');
const { isProtectedPath } = require('./protected');

const DAY_MS = 24 * 60 * 60 * 1000;

const defaultIsProtected = isProtectedPath;

function isFile(node) {
  return node.type === 'file';
}

function* walk(node) {
  yield node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) yield* walk(child);
  }
}

function bySizeThenPath(a, b) {
  if (b.size !== a.size) return b.size - a.size;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Más grandes
// ---------------------------------------------------------------------------

/** Los n archivos más grandes (empates por ruta, para resultados estables). */
function topLargestFiles(tree, n) {
  if (!tree || !(n > 0)) return [];
  const files = [];
  for (const node of walk(tree)) if (isFile(node)) files.push(node);
  return files.sort(bySizeThenPath).slice(0, n);
}

/**
 * Las n carpetas más pesadas, SIN solapamientos (nunca padre e hijo a la vez).
 *
 * Criterio: exploración progresiva.
 *  1. Se parte de las subcarpetas directas de la raíz escaneada (la raíz misma
 *     no cuenta: siempre sería la primera y no aporta nada).
 *  2. Mientras haya menos de n entradas, se toma la MÁS PESADA que tenga
 *     subcarpetas y se reemplaza por sus subcarpetas (los archivos sueltos que
 *     tenía directamente dejan de aparecer).
 *  3. Se para al llegar a n entradas o cuando ninguna se puede abrir más.
 *  4. Se devuelven las n más pesadas, de mayor a menor (empates por ruta).
 * Como cada paso cambia una carpeta por sus hijas, el resultado nunca mezcla
 * padres con hijos. Si hay menos de n carpetas disponibles, devuelve las que
 * haya. Límite: una carpeta abierta se muestra solo por sus subcarpetas, así
 * que el peso de sus archivos sueltos no aparece en la lista.
 */
function topLargestFolders(tree, n) {
  if (!tree || !(n > 0) || isFile(tree)) return [];
  const subfolders = (node) => (node.children || []).filter((c) => !isFile(c));
  let entries = subfolders(tree);
  while (entries.length < n) {
    let target = null;
    for (const e of entries) {
      if (subfolders(e).length === 0) continue;
      if (target === null || bySizeThenPath(e, target) < 0) target = e;
    }
    if (target === null) break;
    entries = entries.filter((e) => e !== target).concat(subfolders(target));
  }
  return entries.sort(bySizeThenPath).slice(0, n);
}

// ---------------------------------------------------------------------------
// Fecha de último uso
// ---------------------------------------------------------------------------

function maxFinite(values) {
  let best = null;
  for (const v of values) {
    if (Number.isFinite(v) && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * Fecha de "último uso" (ms) = la más reciente entre atime y mtime.
 *  - Carpeta con contenido: se usa SOLO lo de adentro (la más reciente de
 *    todo su contenido). Ni el atime ni el mtime de la propia carpeta cuentan:
 *    escanearla (leer su lista) puede actualizar su atime y daría falsos
 *    "usos recientes".
 *  - Carpeta vacía: se usa su mtime (el atime propio se ignora por lo mismo).
 *  - `ignoreAtime: true` usa solo mtime (para cuando atime no es fiable).
 * Devuelve null si el nodo no trae fechas válidas.
 */
function lastUsedDate(node, { ignoreAtime = false } = {}) {
  return computeInfo(node, defaultIsProtected, ignoreAtime, new Map()).lastUsed;
}

/**
 * Información por nodo, calculada una sola vez (post-orden) y memorizada:
 *  - lastUsed: ver lastUsedDate
 *  - selfProtected: la ruta del nodo está protegida
 *  - subtreeProtected: el nodo o algo dentro de él está protegido
 *  - fullyProtected: el nodo y TODO lo que contiene está protegido
 *  - subtreeIncomplete: el nodo o algo dentro tiene `incomplete` (no se pudo
 *    leer su lista), `partial` (un hijo no se pudo leer) o no trae datos
 *  - noData: carpeta sin la lista `children`
 */
function computeInfo(node, isProtected, ignoreAtime, memo) {
  const cached = memo.get(node);
  if (cached) return cached;
  const selfProtected = Boolean(isProtected(node.path));
  let lastUsed;
  let subtreeProtected = selfProtected;
  let fullyProtected = selfProtected;
  // Carpeta sin lista de hijos (p. ej. copiada entre procesos): no hay datos.
  const noData = !isFile(node) && !Array.isArray(node.children);
  let subtreeIncomplete = noData || Boolean(node.incomplete) || Boolean(node.partial);
  if (isFile(node)) {
    lastUsed = maxFinite(ignoreAtime ? [node.mtimeMs] : [node.atimeMs, node.mtimeMs]);
  } else if (noData) {
    lastUsed = null;
  } else if (node.children.length === 0) {
    lastUsed = maxFinite([node.mtimeMs]);
  } else {
    const dates = [];
    for (const child of node.children) {
      const info = computeInfo(child, isProtected, ignoreAtime, memo);
      dates.push(info.lastUsed);
      if (info.subtreeProtected) subtreeProtected = true;
      if (!info.fullyProtected) fullyProtected = false;
      if (info.subtreeIncomplete) subtreeIncomplete = true;
    }
    lastUsed = maxFinite(dates);
  }
  const info = { lastUsed, selfProtected, subtreeProtected, fullyProtected, subtreeIncomplete, noData };
  memo.set(node, info);
  return info;
}

// ---------------------------------------------------------------------------
// Sin uso
// ---------------------------------------------------------------------------

/**
 * Archivos y carpetas sin uso desde hace MÁS de `olderThanDays` días y con al
 * menos `minSizeBytes`.
 *
 * - Una carpeta entera abandonada se devuelve como UNA sola entrada (no sus
 *   miles de archivos). Si tiene aunque sea un archivo reciente, la carpeta
 *   no está abandonada y se miran sus hijos por separado.
 * - Las entradas devueltas nunca se solapan entre sí.
 * - No se ofrecen (van a `notOffered`, con `reason`):
 *     'protegido'            el nodo está protegido
 *     'contiene-protegidos'  tiene algo protegido dentro
 *     'contiene-no-leidos'   él o algo dentro no se pudo leer del todo
 *                            (`incomplete` / `partial`): su tamaño y su fecha
 *                            de uso no son confiables
 *     'sin-datos'            carpeta sin lista `children`
 *   De una carpeta no ofrecida se siguen revisando sus hijos por separado,
 *   salvo que todo su contenido esté protegido o que no tenga datos.
 * - Con minSizeBytes = 0 también salen las carpetas vacías viejas.
 *
 * @param {object} tree
 * @param {object} opts
 * @param {number} opts.olderThanDays
 * @param {number} [opts.minSizeBytes=0]
 * @param {number} [opts.now=Date.now()] Inyectable para pruebas.
 * @param {boolean} [opts.ignoreAtime=false] Usar solo mtime.
 * @param {(p: string) => boolean} [opts.isProtected]
 * @returns {{items: Array, notOffered: Array, totalBytes: number}}
 */
function findStale(tree, opts = {}) {
  const {
    olderThanDays,
    minSizeBytes = 0,
    now = Date.now(),
    ignoreAtime = false,
    isProtected = defaultIsProtected,
  } = opts;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    throw new RangeError('olderThanDays debe ser un número mayor o igual a 0');
  }
  const items = [];
  const notOffered = [];
  if (!tree) return { items, notOffered, totalBytes: 0 };

  const cutoff = now - olderThanDays * DAY_MS;
  const memo = new Map();

  function visit(node) {
    const info = computeInfo(node, isProtected, ignoreAtime, memo);
    if (info.noData) {
      if (!(node.size < minSizeBytes)) notOffered.push(skipEntry(node, 'sin-datos'));
      return;
    }
    const stale = info.lastUsed !== null && info.lastUsed < cutoff;
    if (!stale) {
      if (!isFile(node)) node.children.forEach(visit);
      return;
    }
    if (node.size < minSizeBytes) return; // sus hijos son aún más chicos

    if (info.selfProtected) {
      notOffered.push(skipEntry(node, 'protegido'));
      if (info.fullyProtected) return; // todo lo de adentro también: no se desglosa
    } else if (info.subtreeProtected) {
      notOffered.push(skipEntry(node, 'contiene-protegidos'));
    } else if (info.subtreeIncomplete) {
      notOffered.push(skipEntry(node, 'contiene-no-leidos'));
    } else {
      items.push({
        node,
        path: node.path,
        type: node.type,
        size: node.size,
        fileCount: node.fileCount,
        lastUsedMs: info.lastUsed,
        daysUnused: Math.floor((now - info.lastUsed) / DAY_MS),
      });
      return;
    }
    if (!isFile(node)) node.children.forEach(visit);
  }
  visit(tree);

  items.sort(bySizeThenPath);
  notOffered.sort(bySizeThenPath);
  return { items, notOffered, totalBytes: items.reduce((s, i) => s + i.size, 0) };
}

function skipEntry(node, reason) {
  return { node, path: node.path, size: node.size, reason };
}

// ---------------------------------------------------------------------------
// Fiabilidad de la fecha de último acceso
// ---------------------------------------------------------------------------

/**
 * Heurística: ¿la fecha de último acceso (atime) parece fiable?
 *
 * Windows suele tener desactivado su registro (o lo actualiza con retraso), y
 * entonces atime queda igual a la fecha de modificación o de creación. Si casi
 * todos los archivos (>= `threshold`, 90 % por defecto) tienen atime a menos
 * de `toleranceMs` (2 s) de su mtime o de su fecha de creación, se marca
 * "poco-fiable". Con menos de `minFiles` archivos no se opina ("indeterminado").
 *
 * LÍMITES: es un indicio, no una prueba.
 *  - Falso "poco fiable": un disco de archivos que nadie ha vuelto a abrir
 *    se ve igual que uno con atime desactivado.
 *  - Falso "fiable": antivirus, indexadores y copias de seguridad leen los
 *    archivos y actualizan atime aunque el usuario no los haya usado; el
 *    atime variado no prueba que sea uso humano.
 *  - La fecha de creación puede faltar (0) en algunos sistemas; entonces solo
 *    se compara con mtime.
 *
 * @returns {{level: 'fiable'|'poco-fiable'|'indeterminado', reliable: boolean|null,
 *            sampleSize: number, similarCount: number, ratio: number, message: string}}
 */
function atimeReliability(tree, { toleranceMs = 2000, minFiles = 20, threshold = 0.9 } = {}) {
  let sampleSize = 0;
  let similarCount = 0;
  if (tree) {
    for (const node of walk(tree)) {
      if (!isFile(node) || !Number.isFinite(node.atimeMs)) continue;
      sampleSize++;
      const nearModified =
        Number.isFinite(node.mtimeMs) && Math.abs(node.atimeMs - node.mtimeMs) <= toleranceMs;
      const nearCreated =
        Number.isFinite(node.birthtimeMs) &&
        node.birthtimeMs > 0 &&
        Math.abs(node.atimeMs - node.birthtimeMs) <= toleranceMs;
      if (nearModified || nearCreated) similarCount++;
    }
  }
  const ratio = sampleSize === 0 ? 0 : similarCount / sampleSize;
  const pct = Math.round(ratio * 100);

  if (sampleSize < minFiles) {
    return {
      level: 'indeterminado',
      reliable: null,
      sampleSize,
      similarCount,
      ratio,
      message: `Hay muy pocos archivos (${sampleSize}) para saber si la fecha de último acceso es fiable.`,
    };
  }
  if (ratio >= threshold) {
    return {
      level: 'poco-fiable',
      reliable: false,
      sampleSize,
      similarCount,
      ratio,
      message:
        `La fecha de último acceso parece poco fiable: en ${similarCount} de ${sampleSize} archivos (${pct} %) ` +
        'coincide con la de modificación o creación. Windows suele tenerla desactivada; ' +
        'conviene guiarse por la fecha de modificación.',
    };
  }
  return {
    level: 'fiable',
    reliable: true,
    sampleSize,
    similarCount,
    ratio,
    message: `La fecha de último acceso parece fiable: solo ${pct} % de los archivos coincide con la de modificación o creación.`,
  };
}

// ---------------------------------------------------------------------------
// Resumen de una selección
// ---------------------------------------------------------------------------

function pathKey(p) {
  const win = p.includes('\\') || /^[a-zA-Z]:/.test(p);
  const sep = win ? '\\' : '/';
  let k = win ? path.win32.normalize(p).toLowerCase() : path.posix.normalize(p);
  if (k.length > 1 && k.endsWith(sep) && !/^[a-z]:\\$/.test(k)) k = k.slice(0, -1);
  return { key: (win ? 'w|' : 'p|') + k, body: k, prefix: win ? 'w|' : 'p|', sep, win };
}

function* ancestorKeys({ body, prefix, sep, win }) {
  let cur = body;
  let i;
  while ((i = cur.lastIndexOf(sep)) > 0) {
    cur = cur.slice(0, i);
    yield prefix + cur;
  }
  if (win && /^[a-z]:$/.test(cur)) yield prefix + cur + sep;
  else if (!win && body.startsWith('/') && body !== '/') yield prefix + '/';
}

/**
 * Espacio total que se liberaría al seleccionar un conjunto de nodos.
 *
 * - Protegidos (o carpetas con algo protegido dentro): excluidos.
 * - Carpetas con contenido no leído ('contiene-no-leidos') o sin lista de
 *   hijos ('sin-datos'): excluidas, porque su tamaño no es confiable.
 * - Si se selecciona una carpeta y algo dentro de ella, solo cuenta la
 *   carpeta. El mismo nodo repetido cuenta una vez. Se compara por ruta, por
 *   lo que también funciona con copias del nodo (p. ej. tras pasar por IPC).
 *
 * @param {object[]} selection Nodos del árbol.
 * @param {object} [opts]
 * @param {(p: string) => boolean} [opts.isProtected]
 * @returns {{totalBytes:number, totalFiles:number, counted:object[],
 *            excluded: Array<{node:object, reason:'protegido'|'contiene-protegidos'|'contiene-no-leidos'|'sin-datos'|'duplicado'|'dentro-de-otro-seleccionado'}>}}
 */
function summarize(selection, { isProtected = defaultIsProtected } = {}) {
  const counted = [];
  const excluded = [];
  const memo = new Map();
  const allowed = [];
  const seen = new Set();

  for (const node of selection || []) {
    const info = computeInfo(node, isProtected, false, memo);
    if (info.selfProtected) {
      excluded.push({ node, reason: 'protegido' });
    } else if (info.subtreeProtected) {
      excluded.push({ node, reason: 'contiene-protegidos' });
    } else if (info.noData) {
      excluded.push({ node, reason: 'sin-datos' });
    } else if (info.subtreeIncomplete) {
      excluded.push({ node, reason: 'contiene-no-leidos' });
    } else {
      const k = pathKey(node.path);
      if (seen.has(k.key)) {
        excluded.push({ node, reason: 'duplicado' });
      } else {
        seen.add(k.key);
        allowed.push({ node, k });
      }
    }
  }

  for (const { node, k } of allowed) {
    let nested = false;
    for (const anc of ancestorKeys(k)) {
      if (seen.has(anc)) {
        nested = true;
        break;
      }
    }
    if (nested) excluded.push({ node, reason: 'dentro-de-otro-seleccionado' });
    else counted.push(node);
  }

  return {
    totalBytes: counted.reduce((s, n) => s + n.size, 0),
    totalFiles: counted.reduce((s, n) => s + n.fileCount, 0),
    counted,
    excluded,
  };
}

module.exports = {
  DAY_MS,
  topLargestFiles,
  topLargestFolders,
  lastUsedDate,
  findStale,
  atimeReliability,
  summarize,
};
