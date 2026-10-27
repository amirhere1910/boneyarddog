'use strict';

/**
 * Hilo de análisis. Aquí vive el árbol completo del escaneo: NUNCA sale de
 * este hilo. Hacia afuera solo viajan resultados pequeños ("nodos livianos":
 * sin hijos, sin subárboles).
 *
 * Protocolo con service.js:
 *   entrada:  { id, method, args }
 *   salida:   { id, ok: true, result } | { id, ok: false, error: {name, message, code} }
 *             { type: 'progress', ... }   (avisos de un escaneo en curso)
 */

const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

const { scan } = require('../core/scanner');
const analysis = require('../core/analysis');
const { isProtectedPath } = require('../core/protected');

const MAX_LIMIT = 1000;
const MAX_SELECTION = 10000;
const MAX_FOLDERS = 500;
const MAX_EXCLUDED = 500;
const MAX_MIN_BYTES = 10 * 1024 ** 4; // 10 TB
const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_MAP_MIN_BYTES = 100 * 1024 * 1024; // 100 MB

let tree = null; // árbol del último escaneo completo
let rootPath = null;
let summary = null;
let scanSeq = 0;
let current = null; // { seq, controller }
// Opciones de "uso" vigentes (ver analysis.js). UNA sola fuente de verdad: las
// fechas que se muestran (lastUsedMs) y los cálculos (daysUnused, sin uso) las usan siempre.
let usage = analysis.normalizeUsage();
// Último resultado de carpetas sin uso, por parámetros. `treeVersion` cambia cuando
// cambia el árbol o las opciones de uso, y con eso se descarta el resultado guardado.
let treeVersion = 0;
let folderCache = null; // { key, value }

// Solo para la prueba automática: nombres de carpeta que se muestran como protegidas
// (el main los pasa por workerData únicamente en modo smoke; normalmente está vacío).
const smokeProtectedNames = new Set((workerData && workerData.smokeProtectedNames) || []);
function protectedPath(p) {
  return isProtectedPath(p) || smokeProtectedNames.has(path.basename(p));
}

class ServiceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function requireTree() {
  if (!tree) throw new ServiceError('No hay un análisis disponible: primero hay que escanear una carpeta.', 'SIN_ANALISIS');
  return tree;
}

function toLight(node, extra) {
  return {
    name: node.name,
    path: node.path,
    type: node.type,
    size: node.size,
    fileCount: node.fileCount,
    lastUsedMs: node.lastUsedMs === undefined ? null : node.lastUsedMs,
    protected: protectedPath(node.path),
    hasChildren: node.type === 'folder' && Array.isArray(node.children) && node.children.length > 0,
    ...extra,
  };
}

function checkCount(n, name = 'n') {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new RangeError(`${name} debe ser un entero entre 1 y ${MAX_LIMIT}`);
  }
  return n;
}

/**
 * Busca un nodo por su ruta dentro del árbol PROPIO. Rechaza (null) todo lo que
 * no esté en el árbol: el renderer nunca puede hacer que se use otra cosa.
 */
function findNode(p) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
  const root = requireTree();
  const rel = path.relative(rootPath, path.resolve(p));
  if (rel === '') return root;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  let node = root;
  for (const part of rel.split(path.sep)) {
    if (node.type !== 'folder' || !Array.isArray(node.children)) return null;
    const next = node.children.find((c) => c.name === part); // coincidencia exacta
    if (!next) return null;
    node = next;
  }
  return node;
}

function unknownPath(p) {
  return new ServiceError(`Ruta desconocida (no está en el análisis actual): ${String(p).slice(0, 200)}`, 'RUTA_DESCONOCIDA');
}

function countBy(list, key) {
  const out = {};
  for (const item of list) out[item[key]] = (out[item[key]] || 0) + 1;
  return out;
}

const handlers = {
  async startScan(p) {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) {
      throw new TypeError('La ruta a escanear debe ser un texto válido');
    }
    if (current) current.controller.abort(); // un escaneo nuevo reemplaza al anterior
    const mine = { seq: ++scanSeq, controller: new AbortController() };
    current = mine;
    tree = null;
    summary = null;
    treeVersion++;

    const res = await scan(p, {
      signal: mine.controller.signal,
      onProgress: ({ filesSeen, bytes, currentPath }) => {
        if (mine.seq === scanSeq) parentPort.postMessage({ type: 'progress', filesSeen, bytes, currentPath });
      },
    });

    if (mine.seq !== scanSeq) return { cancelled: true, replaced: true, stats: res.stats };
    current = null;
    if (res.cancelled) return { cancelled: true, replaced: false, stats: res.stats };

    if (res.tree) analysis.annotateLastUsed(res.tree, usage);
    tree = res.tree;
    treeVersion++;
    rootPath = path.resolve(p);
    summary = {
      cancelled: false,
      rootPath,
      hasTree: Boolean(res.tree),
      stats: res.stats,
      skippedCount: res.skipped.length,
      skippedByKind: countBy(res.skipped, 'kind'),
      atimeReliability: analysis.atimeReliability(res.tree),
    };
    return summary;
  },

  /** Cambia qué cuenta como uso y vuelve a anotar todo el árbol (un recorrido lineal). */
  async setUsageOptions(options) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('Las opciones de uso deben ser un objeto');
    }
    for (const key of ['useAccessTime', 'useCreationTime']) {
      if (key in options && typeof options[key] !== 'boolean') throw new TypeError(`${key} debe ser verdadero o falso`);
    }
    usage = analysis.normalizeUsage({ ...usage, ...options });
    if (tree) analysis.annotateLastUsed(tree, usage);
    treeVersion++;
    return { ...usage };
  },

  async cancel() {
    if (!current) return { cancelled: false };
    current.controller.abort();
    return { cancelled: true };
  },

  async getChildren(folderPath, { sortBy = 'size', limit = 200, offset = 0 } = {}) {
    const node = findNode(folderPath);
    if (!node) throw unknownPath(folderPath);
    if (node.type !== 'folder') throw new ServiceError('La ruta no es una carpeta', 'NO_ES_CARPETA');
    if (!['size', 'name', 'lastUsed'].includes(sortBy)) throw new RangeError("sortBy debe ser 'size', 'name' o 'lastUsed'");
    checkCount(limit, 'limit');
    if (!Number.isInteger(offset) || offset < 0) throw new RangeError('offset debe ser un entero >= 0');

    const list = (node.children || []).slice();
    const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (sortBy === 'size') list.sort((a, b) => b.size - a.size || byName(a, b));
    else if (sortBy === 'lastUsed') list.sort((a, b) => (a.lastUsedMs ?? Infinity) - (b.lastUsedMs ?? Infinity) || byName(a, b));
    else list.sort(byName);

    return {
      path: node.path,
      total: list.length,
      offset,
      limit,
      items: list.slice(offset, offset + limit).map((c) => toLight(c)),
    };
  },

  /** Confirma que la ruta está en el árbol propio y devuelve su nodo liviano (con la ruta canónica del árbol). */
  async getNode(p) {
    const node = findNode(p);
    if (!node) throw unknownPath(p);
    return toLight(node);
  },

  async getLargestFiles(n) {
    checkCount(n);
    return analysis.topLargestFiles(requireTree(), n).map((f) => toLight(f));
  },

  async getLargestFolders(n) {
    checkCount(n);
    return analysis.topLargestFolders(requireTree(), n).map((f) => toLight(f));
  },

  async getStale(options = {}) {
    const { olderThanDays, minSizeBytes = 0, now } = options || {};
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new RangeError('olderThanDays debe ser un número >= 0');
    if (!Number.isFinite(minSizeBytes) || minSizeBytes < 0) throw new RangeError('minSizeBytes debe ser un número >= 0');
    const opts = { olderThanDays, minSizeBytes, ...usage };
    if (now !== undefined) {
      if (!Number.isFinite(now)) throw new RangeError('now debe ser un número');
      opts.now = now;
    }
    const { items, notOffered, totalBytes } = analysis.findStale(requireTree(), opts);
    return {
      items: items.slice(0, MAX_LIMIT).map((i) => toLight(i.node, { daysUnused: i.daysUnused })),
      count: items.length,
      truncated: items.length > MAX_LIMIT,
      totalBytes,
      notOfferedCount: notOffered.length,
      notOfferedByReason: countBy(notOffered, 'reason'),
    };
  },

  /**
   * Carpetas sin uso (ver analysis.findStaleFolders). Parámetros: olderThanDays
   * (entero 1–3650), minSizeBytes (0–10 TB), excludedPaths (hasta 500 rutas) y
   * `now` (solo para pruebas). Las opciones de uso salen del estado del worker.
   */
  async getStaleFolders(options = {}) {
    const o = options === null || typeof options !== 'object' || Array.isArray(options) ? null : options;
    if (!o) throw new TypeError('Las opciones deben ser un objeto');
    const olderThanDays = o.olderThanDays === undefined ? analysis.DEFAULT_STALE_DAYS : o.olderThanDays;
    const minSizeBytes = o.minSizeBytes === undefined ? analysis.DEFAULT_MIN_FOLDER_BYTES : o.minSizeBytes;
    const excludedPaths = o.excludedPaths === undefined ? [] : o.excludedPaths;
    if (!Number.isInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650) {
      throw new RangeError('olderThanDays debe ser un entero entre 1 y 3650');
    }
    if (!Number.isInteger(minSizeBytes) || minSizeBytes < 0 || minSizeBytes > MAX_MIN_BYTES) {
      throw new RangeError('minSizeBytes debe ser un entero entre 0 y 10 TB');
    }
    if (!Array.isArray(excludedPaths) || excludedPaths.length > MAX_EXCLUDED) {
      throw new RangeError(`excludedPaths debe ser una lista de hasta ${MAX_EXCLUDED} rutas`);
    }
    for (const p of excludedPaths) {
      if (typeof p !== 'string' || p === '' || p.length > 32767 || p.includes('\0')) throw new TypeError('excludedPaths solo admite rutas como texto');
    }
    const params = { olderThanDays, minSizeBytes, excludedPaths: [...excludedPaths].sort() };
    if (o.now !== undefined) {
      if (!Number.isFinite(o.now)) throw new RangeError('now debe ser un número');
      params.now = o.now;
    }
    const root = requireTree();
    const key = JSON.stringify([treeVersion, params]);
    // Con `now` fijo el resultado es siempre el mismo; sin él, el reloj cuenta: no se reutiliza pasado un rato.
    if (folderCache && folderCache.key === key && (params.now !== undefined || Date.now() - folderCache.at < 60_000)) {
      return folderCache.value;
    }

    const { items, notOffered, totalBytes } = analysis.findStaleFolders(root, { ...params, ...usage });
    const value = {
      items: items.slice(0, MAX_FOLDERS).map((i) =>
        toLight(i.node, { lastUsedMs: i.lastUsedMs, daysUnused: i.daysUnused, newestFile: i.newestFile, hasLinks: i.hasLinks }),
      ),
      count: items.length,
      truncated: items.length > MAX_FOLDERS,
      totalBytes,
      notOfferedCount: notOffered.length,
      notOfferedByReason: countBy(notOffered, 'reason'),
    };
    folderCache = { key, value, at: Date.now() };
    return value;
  },

  /**
   * Celdas del mapa de una carpeta: una por subcarpeta con tamaño >= minBytes, una de
   * "archivos sueltos" si suman >= minBytes y UNA de "otras" con todo lo demás (bajo
   * el mínimo o fuera del tope de celdas). La suma de las celdas es el tamaño de la
   * carpeta: no se pierde nada. Las fechas usan las opciones de uso vigentes.
   */
  async getTreemap(folderPath, options = {}) {
    const o = options === null || typeof options !== 'object' || Array.isArray(options) ? null : options;
    if (!o) throw new TypeError('Las opciones deben ser un objeto');
    const minBytes = o.minBytes === undefined ? DEFAULT_MAP_MIN_BYTES : o.minBytes;
    const maxCells = o.maxCells === undefined ? 40 : o.maxCells;
    if (!Number.isInteger(minBytes) || minBytes < 0 || minBytes > MAX_MIN_BYTES) throw new RangeError('minBytes debe ser un entero entre 0 y 10 TB');
    if (!Number.isInteger(maxCells) || maxCells < 10 || maxCells > 200) throw new RangeError('maxCells debe ser un entero entre 10 y 200');
    if (o.now !== undefined && !Number.isFinite(o.now)) throw new RangeError('now debe ser un número');
    const now = o.now === undefined ? Date.now() : o.now;

    const node = findNode(folderPath);
    if (!node) throw unknownPath(folderPath);
    if (node.type !== 'folder') throw new ServiceError('La ruta no es una carpeta', 'NO_ES_CARPETA');

    const days = (ms) => (Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / DAY)) : null);
    const children = Array.isArray(node.children) ? node.children : [];
    const folders = children.filter((c) => c.type === 'folder');
    const files = children.filter((c) => c.type === 'file');
    const maxDate = (list) => list.reduce((m, c) => (Number.isFinite(c.lastUsedMs) && (m === null || c.lastUsedMs > m) ? c.lastUsedMs : m), null);

    const candidates = [];
    const small = []; // por debajo del mínimo
    for (const f of folders) (f.size >= minBytes ? candidates : small).push({ kind: 'folder', node: f, size: f.size });
    const looseBytes = files.reduce((s, f) => s + f.size, 0);
    const looseCell = files.length > 0 && looseBytes >= minBytes ? { kind: 'files', size: looseBytes } : null;
    if (looseCell) candidates.push(looseCell);
    candidates.sort((a, b) => b.size - a.size || (a.kind === 'folder' && b.kind === 'folder' ? (a.node.path < b.node.path ? -1 : 1) : a.kind < b.kind ? -1 : 1));

    // Con "otras" el total de celdas no pasa de maxCells.
    const needsOthers = small.length > 0 || (files.length > 0 && !looseCell) || candidates.length > maxCells;
    const keepMax = needsOthers ? maxCells - 1 : maxCells;
    const kept = candidates.slice(0, keepMax);
    const leftover = candidates.slice(keepMax);

    const cells = kept.map((c) => {
      if (c.kind === 'files') {
        return { kind: 'files', name: 'Archivos sueltos', size: c.size, fileCount: files.length, lastUsedMs: maxDate(files), daysUnused: days(maxDate(files)), protected: false, hasLinks: false, unreadable: false, canEnter: false };
      }
      const f = c.node;
      const unreadable = Boolean(f.incomplete || f.partial || f.subtreeIncomplete);
      return {
        kind: 'folder',
        name: f.name,
        path: f.path,
        size: f.size,
        fileCount: f.fileCount,
        lastUsedMs: f.lastUsedMs === undefined ? null : f.lastUsedMs,
        daysUnused: days(f.lastUsedMs),
        protected: protectedPath(f.path),
        hasLinks: Boolean(f.hasLinks || f.subtreeHasLinks),
        unreadable,
        canEnter: Array.isArray(f.children) && f.children.some((x) => x.type === 'folder'),
      };
    });

    // Todo lo que no tiene celda propia se agrupa.
    const groupedFolders = small.map((c) => c.node).concat(leftover.filter((c) => c.kind === 'folder').map((c) => c.node));
    const groupedFiles = looseCell && !leftover.includes(looseCell) ? [] : files;
    const groupedAll = groupedFolders.concat(groupedFiles);
    if (groupedAll.length > 0) {
      const last = maxDate(groupedAll);
      cells.push({
        kind: 'others',
        name: 'Otras',
        size: groupedAll.reduce((s, c) => s + c.size, 0),
        bytes: groupedAll.reduce((s, c) => s + c.size, 0),
        count: groupedFolders.length,
        looseFiles: groupedFiles.length,
        fileCount: groupedAll.reduce((s, c) => s + c.fileCount, 0),
        lastUsedMs: last,
        daysUnused: days(last),
        protected: false,
        hasLinks: groupedFolders.some((f) => f.hasLinks || f.subtreeHasLinks),
        unreadable: groupedFolders.some((f) => f.incomplete || f.partial || f.subtreeIncomplete),
        canEnter: false,
      });
    }

    // Migas de pan: desde la carpeta raíz escaneada hasta esta.
    const breadcrumbs = [{ name: tree.name, path: tree.path }];
    const rel = path.relative(rootPath, node.path);
    if (rel !== '') {
      let cur = tree;
      for (const part of rel.split(path.sep)) {
        cur = cur.children.find((c) => c.name === part);
        breadcrumbs.push({ name: cur.name, path: cur.path });
      }
    }

    return {
      folder: {
        path: node.path,
        name: node.name,
        size: node.size,
        fileCount: node.fileCount,
        lastUsedMs: node.lastUsedMs === undefined ? null : node.lastUsedMs,
        daysUnused: days(node.lastUsedMs),
      },
      breadcrumbs,
      parentPath: breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2].path : null,
      totalBytes: node.size,
      cells,
    };
  },

  /** Detalles de una carpeta o archivo (se calcula al pedirlo, con un recorrido del subárbol). */
  async getDetails(p, options = {}) {
    const node = findNode(p);
    if (!node) throw unknownPath(p);
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const buckets = { hasta30: { bytes: 0, files: 0 }, hasta90: { bytes: 0, files: 0 }, hasta180: { bytes: 0, files: 0 }, hasta365: { bytes: 0, files: 0 }, mas365: { bytes: 0, files: 0 }, desconocido: { bytes: 0, files: 0 } };
    let folderCount = 0;
    let newest = null;
    let containsProtected = false;
    const stack = [node];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n !== node && !containsProtected && protectedPath(n.path)) containsProtected = true;
      if (n.type === 'folder') {
        if (n !== node) folderCount++;
        if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
      } else {
        const ms = n.lastUsedMs;
        let b;
        if (!Number.isFinite(ms)) b = buckets.desconocido;
        else {
          const d = (now - ms) / DAY;
          b = d <= 30 ? buckets.hasta30 : d <= 90 ? buckets.hasta90 : d <= 180 ? buckets.hasta180 : d <= 365 ? buckets.hasta365 : buckets.mas365;
          if (newest === null || ms > newest.ms || (ms === newest.ms && n.path < newest.path)) newest = { path: n.path, name: n.name, ms };
        }
        b.bytes += n.size;
        b.files += 1;
      }
    }
    const subfolders = (node.type === 'folder' && Array.isArray(node.children) ? node.children : []).filter((c) => c.type === 'folder');
    const topSubfolders = subfolders
      .slice()
      .sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1))
      .slice(0, 5)
      .map((f) => ({ name: f.name, path: f.path, size: f.size, fileCount: f.fileCount, lastUsedMs: f.lastUsedMs === undefined ? null : f.lastUsedMs }));
    const last = node.lastUsedMs === undefined ? null : node.lastUsedMs;
    return {
      path: node.path,
      name: node.name,
      type: node.type,
      size: node.size,
      fileCount: node.fileCount,
      folderCount,
      lastUsedMs: last,
      daysUnused: Number.isFinite(last) ? Math.max(0, Math.floor((now - last) / DAY)) : null,
      newestFile: newest,
      protected: protectedPath(node.path),
      containsProtected,
      hasLinks: Boolean(node.hasLinks || node.subtreeHasLinks),
      unreadable: Boolean(node.incomplete || node.partial || node.subtreeIncomplete),
      ageBuckets: buckets,
      topSubfolders,
    };
  },

  async summarizeSelection(paths) {
    if (!Array.isArray(paths) || paths.length > MAX_SELECTION) {
      throw new RangeError(`La selección debe ser una lista de hasta ${MAX_SELECTION} rutas`);
    }
    const nodes = paths.map((p) => {
      const node = findNode(p);
      if (!node) throw unknownPath(p);
      return node;
    });
    const r = analysis.summarize(nodes);
    return {
      totalBytes: r.totalBytes,
      totalFiles: r.totalFiles,
      counted: r.counted.map((n) => n.path),
      excluded: r.excluded.map((e) => ({ path: e.node.path, reason: e.reason })),
    };
  },
};

parentPort.on('message', async ({ id, method, args }) => {
  try {
    if (!Object.hasOwn(handlers, method)) throw new ServiceError(`Método desconocido: ${method}`, 'METODO_DESCONOCIDO');
    const result = await handlers[method](...(Array.isArray(args) ? args : []));
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { name: err && err.name, message: err && err.message ? err.message : String(err), code: err && err.code } });
  }
});
