'use strict';

/**
 * Escáner de disco.
 *
 * Recorre una ruta y devuelve un árbol de nodos:
 *   {
 *     name, path,
 *     type: 'file' | 'folder',
 *     size,          // bytes. En carpetas: suma de todo lo que contienen
 *     atimeMs,       // último acceso (ms desde 1970)
 *     mtimeMs,       // última modificación (ms desde 1970)
 *     birthtimeMs,   // creación (0 si el sistema no la informa)
 *     fileCount,     // archivos contenidos (un archivo cuenta como 1)
 *     children,      // solo en carpetas
 *     incomplete,    // solo en carpetas cuya lista no se pudo leer
 *     partial        // solo en carpetas con un hijo directo que no se pudo leer
 *   }               // (permisos, tipo especial u otro error; no cuenta que
 *                   // el hijo haya desaparecido ni que sea un enlace)
 *
 * Fechas como números (ms) y no como Date para que el árbol viaje sin
 * problemas entre procesos de Electron.
 *
 * TAMAÑO: se usa el tamaño real del archivo (stat.size), NO el "tamaño en
 * disco". Puede diferir del Explorador de Windows (clústeres, compresión NTFS,
 * archivos dispersos, archivos de OneDrive solo en la nube, enlaces duros que
 * se cuentan una vez por cada nombre).
 *
 * El escáner nunca abre ni lee el contenido de los archivos: solo pide
 * metadatos (lstat) y listas de carpetas (readdir).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const ABORTED = Symbol('scan-aborted');

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function classifyError(err) {
  const code = err && err.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return { kind: 'permission', code, reason: 'Sin permiso para leer' };
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { kind: 'not-found', code, reason: 'La ruta no existe (o desapareció durante el escaneo)' };
  }
  return {
    kind: 'other',
    code: code || 'DESCONOCIDO',
    reason: `Error al leer: ${(err && err.message) || String(err)}`,
  };
}

/**
 * @param {string} rootPath Carpeta (o archivo) a escanear.
 * @param {object} [options]
 * @param {number} [options.concurrency=16] Lecturas simultáneas al disco.
 * @param {(p: {filesSeen:number, bytes:number, currentPath:string}) => void} [options.onProgress]
 * @param {number} [options.progressIntervalMs=100] Separación mínima entre avisos de progreso.
 * @param {AbortSignal} [options.signal] Para cancelar.
 * @returns {Promise<{tree: object|null, skipped: Array, cancelled: boolean, stats: object}>}
 *   - skipped: [{ path, kind: 'permission'|'not-found'|'symlink'|'special'|'other', code?, reason }]
 *   - cancelled: true si se canceló. El árbol es entonces PARCIAL: los
 *     tamaños son solo lo leído hasta ese momento; no sirve para decidir nada.
 *   - tree es null si la ruta raíz no existe, no se puede leer o es un enlace.
 */
async function scan(rootPath, options = {}) {
  const { concurrency = 16, onProgress, progressIntervalMs = 100, signal } = options;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency debe ser un entero mayor o igual a 1');
  }
  if (typeof rootPath !== 'string' || rootPath.length === 0) {
    throw new TypeError('rootPath debe ser un texto no vacío');
  }

  const startedAt = Date.now();
  const root = path.resolve(rootPath);
  const limit = createLimiter(concurrency);
  const skipped = [];
  const unreadable = new Set(); // rutas que fallaron de forma que deja al padre incompleto
  let filesSeen = 0;
  let foldersSeen = 0;
  let bytes = 0;
  let currentPath = root;
  let lastEmit = 0;

  const isAborted = () => Boolean(signal && signal.aborted);

  // Solo la llamada real al disco ocupa una "ranura"; la recursión no, así
  // que no puede haber bloqueos por carpetas anidadas muy profundas.
  const io = (fn) =>
    limit(async () => {
      if (isAborted()) throw ABORTED;
      return fn();
    });

  function emit(force) {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < progressIntervalMs) return;
    lastEmit = now;
    onProgress({ filesSeen, bytes, currentPath });
  }

  function skip(p, info) {
    skipped.push({ path: p, ...info });
  }

  async function scanPath(p, name) {
    let st;
    try {
      st = await io(() => fsp.lstat(p));
    } catch (err) {
      if (err === ABORTED) return null;
      const info = classifyError(err);
      skip(p, info);
      if (info.kind !== 'not-found') unreadable.add(p);
      return null;
    }
    currentPath = p;

    // lstat no sigue enlaces. En Windows, Node informa también las junctions
    // (puntos de montaje) como enlaces simbólicos.
    if (st.isSymbolicLink()) {
      skip(p, {
        kind: 'symlink',
        reason: 'Enlace simbólico o punto de reanálisis (junction): no se sigue',
      });
      return null;
    }
    if (st.isDirectory()) return scanDir(p, name, st);
    if (st.isFile()) {
      filesSeen++;
      bytes += st.size;
      emit(false);
      return {
        name,
        path: p,
        type: 'file',
        size: st.size,
        atimeMs: st.atimeMs,
        mtimeMs: st.mtimeMs,
        birthtimeMs: st.birthtimeMs,
        fileCount: 1,
      };
    }
    skip(p, { kind: 'special', reason: 'Tipo especial (dispositivo, socket, tubería): se omite' });
    unreadable.add(p);
    return null;
  }

  async function scanDir(p, name, st) {
    foldersSeen++;
    const node = {
      name,
      path: p,
      type: 'folder',
      size: 0,
      atimeMs: st.atimeMs,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs,
      fileCount: 0,
      children: [],
    };
    let names;
    try {
      names = await io(() => fsp.readdir(p));
    } catch (err) {
      if (err === ABORTED) return node;
      skip(p, classifyError(err));
      node.incomplete = true;
      return node;
    }
    const results = await Promise.all(names.map((n) => scanPath(path.join(p, n), n)));
    for (const child of results) {
      if (!child) continue;
      node.children.push(child);
      node.size += child.size;
      node.fileCount += child.fileCount;
    }
    if (names.some((n) => unreadable.has(path.join(p, n)))) node.partial = true;
    node.children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return node;
  }

  const tree = await scanPath(root, path.basename(root) || root);
  const cancelled = isAborted();
  emit(true);

  return {
    tree,
    skipped,
    cancelled,
    stats: {
      files: filesSeen,
      folders: foldersSeen,
      bytes,
      skipped: skipped.length,
      durationMs: Date.now() - startedAt,
    },
  };
}

module.exports = { scan };
