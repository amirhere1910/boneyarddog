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
const { parentPort } = require('node:worker_threads');

const { scan } = require('../core/scanner');
const analysis = require('../core/analysis');
const { isProtectedPath } = require('../core/protected');

const MAX_LIMIT = 1000;
const MAX_SELECTION = 10000;

let tree = null; // árbol del último escaneo completo
let rootPath = null;
let summary = null;
let scanSeq = 0;
let current = null; // { seq, controller }

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
    protected: isProtectedPath(node.path),
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

    const res = await scan(p, {
      signal: mine.controller.signal,
      onProgress: ({ filesSeen, bytes, currentPath }) => {
        if (mine.seq === scanSeq) parentPort.postMessage({ type: 'progress', filesSeen, bytes, currentPath });
      },
    });

    if (mine.seq !== scanSeq) return { cancelled: true, replaced: true, stats: res.stats };
    current = null;
    if (res.cancelled) return { cancelled: true, replaced: false, stats: res.stats };

    if (res.tree) analysis.annotateLastUsed(res.tree);
    tree = res.tree;
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

  async getLargestFiles(n) {
    checkCount(n);
    return analysis.topLargestFiles(requireTree(), n).map((f) => toLight(f));
  },

  async getLargestFolders(n) {
    checkCount(n);
    return analysis.topLargestFolders(requireTree(), n).map((f) => toLight(f));
  },

  async getStale(options = {}) {
    const { olderThanDays, minSizeBytes = 0, ignoreAtime = false, now } = options || {};
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0) throw new RangeError('olderThanDays debe ser un número >= 0');
    if (!Number.isFinite(minSizeBytes) || minSizeBytes < 0) throw new RangeError('minSizeBytes debe ser un número >= 0');
    const opts = { olderThanDays, minSizeBytes, ignoreAtime: ignoreAtime === true };
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
