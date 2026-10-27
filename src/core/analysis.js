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
  if (node.children) {
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
 * Las n carpetas más pesadas, SIN solapamientos.
 *
 * Criterio (en lenguaje llano):
 *  1. La carpeta raíz escaneada no cuenta (siempre sería la primera y no
 *     aporta nada).
 *  2. Una carpeta se descarta si una sola subcarpeta suya concentra casi todo
 *     su peso (por defecto 90 %, opción `dominance`): en ese caso la
 *     información útil está en la subcarpeta, y se muestra esa.
 *  3. De las que quedan se elige de mayor a menor, y se omite cualquiera que
 *     sea padre o hijo de una ya elegida. Así el resultado nunca mezcla
 *     "Videos" con "Videos\Vacaciones".
 *
 * Límite: con este criterio un padre grande con varios hijos repartidos sale
 * como una sola entrada; sus hijos no aparecen aparte.
 */
function topLargestFolders(tree, n, { dominance = 0.9 } = {}) {
  if (!tree || !(n > 0)) return [];
  const candidates = [];
  const parentOf = new Map();
  (function collect(node, isRoot) {
    if (isFile(node)) return;
    const folders = node.children.filter((c) => !isFile(c));
    if (!isRoot && node.size > 0) {
      const heaviest = folders.reduce((m, c) => Math.max(m, c.size), 0);
      if (heaviest / node.size < dominance) candidates.push(node);
    }
    for (const c of folders) {
      parentOf.set(c, node);
      collect(c, false);
    }
  })(tree, true);

  candidates.sort(bySizeThenPath);
  const chosen = [];
  const chosenSet = new Set();
  const chosenAncestors = new Set(); // padres de las ya elegidas
  for (const node of candidates) {
    if (chosen.length >= n) break;
    if (chosenAncestors.has(node)) continue; // es padre de una elegida
    let insideChosen = false;
    for (let p = parentOf.get(node); p; p = parentOf.get(p)) {
      if (chosenSet.has(p)) {
        insideChosen = true; // es hija de una elegida
        break;
      }
    }
    if (insideChosen) continue;
    chosen.push(node);
    chosenSet.add(node);
    for (let p = parentOf.get(node); p; p = parentOf.get(p)) chosenAncestors.add(p);
  }
  return chosen;
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
 *  - Carpeta: la más reciente de todo su contenido.
 *  - Carpeta vacía: solo su mtime. El atime propio de una carpeta se ignora a
 *    propósito: el simple hecho de escanearla (leer su lista) puede
 *    actualizarlo y daría falsos "usos recientes".
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
 */
function computeInfo(node, isProtected, ignoreAtime, memo) {
  const cached = memo.get(node);
  if (cached) return cached;
  const selfProtected = Boolean(isProtected(node.path));
  let lastUsed;
  let subtreeProtected = selfProtected;
  let fullyProtected = selfProtected;
  if (isFile(node)) {
    lastUsed = maxFinite(ignoreAtime ? [node.mtimeMs] : [node.atimeMs, node.mtimeMs]);
  } else if (node.children.length === 0) {
    lastUsed = maxFinite([node.mtimeMs]);
  } else {
    const dates = [];
    for (const child of node.children) {
      const info = computeInfo(child, isProtected, ignoreAtime, memo);
      dates.push(info.lastUsed);
      if (info.subtreeProtected) subtreeProtected = true;
      if (!info.fullyProtected) fullyProtected = false;
    }
    lastUsed = maxFinite(dates);
  }
  const info = { lastUsed, selfProtected, subtreeProtected, fullyProtected };
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
 * - Protegidos: un nodo protegido, o una carpeta con algo protegido dentro,
 *   no se ofrece completo; va a `protectedSkipped` (reason: 'protegido' o
 *   'contiene-protegidos'). De esa carpeta se siguen revisando sus hijos por
 *   separado, salvo que todo su contenido esté protegido.
 * - Las carpetas que no se pudieron leer (`incomplete`) no se ofrecen enteras.
 * - Con minSizeBytes = 0 también salen las carpetas vacías viejas.
 *
 * @param {object} tree
 * @param {object} opts
 * @param {number} opts.olderThanDays
 * @param {number} [opts.minSizeBytes=0]
 * @param {number} [opts.now=Date.now()] Inyectable para pruebas.
 * @param {boolean} [opts.ignoreAtime=false] Usar solo mtime.
 * @param {(p: string) => boolean} [opts.isProtected]
 * @returns {{items: Array, protectedSkipped: Array, totalBytes: number}}
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
  const protectedSkipped = [];
  if (!tree) return { items, protectedSkipped, totalBytes: 0 };

  const cutoff = now - olderThanDays * DAY_MS;
  const memo = new Map();

  function visit(node) {
    const info = computeInfo(node, isProtected, ignoreAtime, memo);
    const stale = info.lastUsed !== null && info.lastUsed < cutoff;
    if (!stale) {
      if (!isFile(node)) node.children.forEach(visit);
      return;
    }
    if (node.size < minSizeBytes) return; // sus hijos son aún más chicos

    if (info.selfProtected) {
      protectedSkipped.push(skipEntry(node, 'protegido'));
      if (info.fullyProtected) return; // todo lo de adentro también: no se desglosa
    } else if (info.subtreeProtected) {
      protectedSkipped.push(skipEntry(node, 'contiene-protegidos'));
    } else if (!node.incomplete) {
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
  protectedSkipped.sort(bySizeThenPath);
  return { items, protectedSkipped, totalBytes: items.reduce((s, i) => s + i.size, 0) };
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
 * - Si se selecciona una carpeta y algo dentro de ella, solo cuenta la
 *   carpeta. El mismo nodo repetido cuenta una vez. Se compara por ruta, por
 *   lo que también funciona con copias del nodo (p. ej. tras pasar por IPC).
 *
 * @param {object[]} selection Nodos del árbol.
 * @param {object} [opts]
 * @param {(p: string) => boolean} [opts.isProtected]
 * @returns {{totalBytes:number, totalFiles:number, counted:object[],
 *            excluded: Array<{node:object, reason:'protegido'|'contiene-protegidos'|'duplicado'|'dentro-de-otro-seleccionado'}>}}
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
