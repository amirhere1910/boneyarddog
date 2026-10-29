'use strict';

/**
 * Motor de copia y transferencia de carpetas a otro disco.
 *
 * REGLA DE ORO: este código solo elimina algo del ORIGEN de dos maneras: (a) la Papelera inyectada
 * (`trashOriginal`) o (b) el borrado definitivo (`deleteTree`, solo desde `permanentlyDelete`); y en
 * ambos casos solo tras verificar TODO. La única otra eliminación permitida es quitar lo que ESTA
 * operación creó en el destino: la carpeta provisional «….copiando» y su contenido (lista registrada, sin
 * seguir enlaces, sin salir de ella), y —con el diario de la app— una carpeta «….copiando» que una sesión
 * anterior dejó a medias (`removePendingWork`). Las únicas llamadas de eliminación o cambio de nombre de todo el
 * archivo están en `removeOwn`, `removeCreatedEntry`, `trashOriginal`, `deleteTree`, `removePendingWork` y
 * `renameToFinal`; hay una prueba que lo revisa en el código fuente.
 *
 * Todo se hace con módulos de Node. Las dependencias se inyectan (`fs`, `volumeInfo`, `trash`, `now`,
 * `env`, `isProtected`, `registry`) para poder probar cada caso sin tocar discos reales.
 *
 * Destino: para cada origen `X:\ruta\Fotos` queda `<destino>\Fotos` (solo el nombre de la carpeta, tal cual estaba, y
 * NINGÚN archivo más). Se copia a `<destino>\Fotos.copiando` y SOLO cuando todo quedó copiado y verificado se
 * renombra a `Fotos` (sin sobrescribir nunca: si ya existe algo con ese nombre, se usa `Fotos (2)`). Una copia a medias,
 * cancelada o interrumpida nunca parece una copia buena: queda con la extensión `.copiando`. Los datos de
 * verificación (huellas SHA-256…) se guardan en el PC (registro), no en el destino.
 */

const nodePath = require('node:path');
const crypto = require('node:crypto');
const { isProtectedPath, isProtectedDestination, describeProtectedDestination, describeProtectedSource } = require('./protected');
const { unknownVolume } = require('./volume');
const R = require('./transfer-rules');

const CHUNK = 1024 * 1024;
/** Archivos más pequeños que esto se copian en un solo golpe con copyFile (rápida); los grandes se copian por bloques para informar del avance. */
const COPYFILE_MAX = 16 * 1024 * 1024;
const MAX_SOURCES = 500;
/** Carpeta provisional: «Fotos.copiando» (o «Fotos.copiando (2)» si ya existía). */
const WORK_RE = /\.copiando(?: \(\d+\))?$/i;
const FATAL_IO = new Set(['ENODEV', 'EIO', 'ENXIO', 'UNKNOWN', 'ENOTCONN', 'ESHUTDOWN']);

class FatalTransferError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'FatalTransferError';
    this.code = code;
  }
}

class AbortedError extends Error {
  constructor() {
    super('Operación cancelada');
    this.name = 'AbortedError';
  }
}

// ---------------------------------------------------------------- utilidades puras

/**
 * Nombre final y provisional libres para una carpeta: «Fotos», «Fotos (2)»… y «Fotos.copiando», «Fotos.copiando (2)»…
 * `taken` (nombres en minúsculas ya ocupados) se actualiza con lo elegido.
 */
function pickNames(base, taken) {
  const has = (n) => taken.has(n.toLowerCase());
  let finalName = base;
  for (let n = 2; has(finalName); n++) finalName = `${base} (${n})`;
  let workName = `${finalName}.copiando`;
  for (let m = 2; has(workName); m++) workName = `${finalName}.copiando (${m})`;
  taken.add(finalName.toLowerCase());
  taken.add(workName.toLowerCase());
  return { finalName, workName, renamed: finalName !== base };
}

/** Parte una ruta absoluta en carpeta de unidad y nombres (respetando mayúsculas). */
function splitAbsolute(p) {
  const win = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\');
  if (win) {
    const parsed = nodePath.win32.parse(p);
    const drive = /^[A-Za-z]:/.test(parsed.root) ? parsed.root[0].toUpperCase() : 'red';
    const rest = p.slice(parsed.root.length).split(/[\\/]+/).filter((x) => x && x !== '.');
    return { drive, parts: rest };
  }
  return { drive: 'raiz', parts: p.split('/').filter((x) => x && x !== '.') };
}

const relToPath = (base, rel) => (rel === '' ? base : nodePath.join(base, ...rel.split('/')));

function classify(err, side) {
  const code = err && err.code;
  if (code === 'ENOSPC') return { fatal: true, message: 'Sin espacio en el destino', code };
  if (FATAL_IO.has(code)) return { fatal: true, message: 'El disco se desconectó o falló la lectura/escritura (E/S)', code };
  if (side === 'dest' && (code === 'EBUSY' || code === 'EROFS')) return { fatal: true, message: 'El volumen de destino no está disponible o es de solo lectura', code };
  if (code === 'EACCES' || code === 'EPERM') return { fatal: false, message: side === 'dest' ? 'Sin permiso para escribir en el destino' : 'Sin permiso para leer el archivo', code };
  if (code === 'EBUSY') return { fatal: false, message: 'El archivo está bloqueado por otro programa', code };
  if (code === 'ENOENT') return { fatal: false, message: 'El archivo desapareció durante la operación', code };
  if (code === 'EEXIST') return { fatal: false, message: 'Ya existía en el destino (no se sobrescribe)', code };
  return { fatal: false, message: `Error: ${(err && err.message) || String(err)}`, code: code || 'DESCONOCIDO' };
}

/** Estrictamente dentro (no la misma ruta). */
const strictlyInside = (child, parent) => R.isInside(child, parent) && !R.isInside(parent, child);

// ---------------------------------------------------------------------- el motor

function createTransferEngine(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const fsp = fs.promises;
  const volumeInfo = deps.volumeInfo || (async () => unknownVolume());
  const trash = deps.trash || null;
  const now = deps.now || (() => Date.now());
  const isProtected = deps.isProtected || isProtectedPath;
  // El destino se juzga con reglas propias: la RAÍZ de una unidad (E:\) sí sirve; solo se bloquea la del sistema.
  const isProtectedDest = deps.isProtectedDestination || (deps.isProtected ? deps.isProtected : (p) => isProtectedDestination(p, { env: deps.env || process.env }));
  const explainDest = (p, real) => {
    const why = describeProtectedDestination(p, { env: deps.env || process.env }) || (real ? describeProtectedDestination(real, { env: deps.env || process.env }) : null);
    return why || `«${real || p}» es una ruta protegida del sistema: elige otra carpeta.`;
  };
  const env = deps.env || process.env;
  const appVersion = deps.appVersion || '0.0.0'; // eslint-disable-line no-unused-vars
  const diag = typeof deps.diag === 'function' ? deps.diag : null; // diag(evento, datos): registro de diagnóstico (no incluye contenido de archivos)
  const dlog = (evento, datos) => {
    if (!diag) return;
    try {
      diag(evento, datos);
    } catch {
      /* el diagnóstico nunca rompe una copia */
    }
  };
  const registry = deps.registry || null; // { save, update, remove, addPending, removePending }: el registro vive en el PC

  /** ¿La ruta real de `p` sigue siendo `p`? (si un enlace o punto de unión la desvió, no). */
  async function stillItsOwnRealPath(p) {
    try {
      const r = await fsp.realpath(p);
      return r === p || (R.isInside(r, p) && R.isInside(p, r));
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------- eliminaciones (únicas)

  /**
   * ¿La carpeta que contiene `p` está REALMENTE dentro de `container`? Resuelve enlaces: si una carpeta
   * intermedia fuera un enlace hacia otro sitio, `lstat` solo no lo notaría (no sigue el último
   * componente, pero sí los de en medio) y se podría borrar algo ajeno.
   */
  async function parentReallyInside(p, container) {
    try {
      const realParent = await fsp.realpath(nodePath.dirname(p));
      const realContainer = await fsp.realpath(container);
      return R.isInside(realParent, realContainer);
    } catch {
      return false;
    }
  }

  /** Quita UN archivo que esta operación creó (lo registrado), solo dentro de su lote. */
  async function removeOwn(filePath, batchFolder) { // batchFolder: la carpeta propia dentro de la cual se puede quitar
    if (!strictlyInside(filePath, batchFolder) || !(await parentReallyInside(filePath, batchFolder))) return false;
    let st;
    try {
      st = await fsp.lstat(filePath);
    } catch {
      return false;
    }
    if (!st.isFile()) return false; // nunca sigue enlaces ni toca carpetas aquí
    await fsp.unlink(filePath);
    return true;
  }

  /** Quita un elemento registrado (archivo, o carpeta vacía) dentro del lote. */
  async function removeCreatedEntry(entry, container) {
    const p = entry.path;
    if (!strictlyInside(p, container) || !(await parentReallyInside(p, container))) return 'fuera-del-lote';
    let st;
    try {
      st = await fsp.lstat(p);
    } catch {
      return 'ya-no-esta';
    }
    if (st.isSymbolicLink()) return 'enlace-no-se-sigue';
    if (entry.type === 'file') {
      if (!st.isFile()) return 'no-es-archivo';
      await fsp.unlink(p);
      return 'quitado';
    }
    if (!st.isDirectory()) return 'no-es-carpeta';
    if ((await fsp.readdir(p)).length > 0) return 'no-esta-vacia';
    await fsp.rmdir(p);
    return 'quitado';
  }

  /** Papelera inyectada. Solo se llama tras verificar todo y volver a comprobar el origen. */
  async function trashOriginal(sourcePath) {
    await trash(sourcePath);
  }

  /**
   * Borrado definitivo del ORIGEN. Única llamada de borrado recursivo de todo el motor; solo la usa
   * `permanentlyDelete`, después de todas sus comprobaciones. `fs.rm` no sigue enlaces (borra el enlace,
   * no su destino) y con force:false falla si algo no existe, en vez de callar.
   */
  async function deleteTree(sourcePath) {
    await fsp.rm(sourcePath, { recursive: true, force: false });
  }

  // ------------------------------------------------------------------ recorrido

  /** Recorre una carpeta EN VIVO con lstat: sin seguir enlaces ni puntos de reanálisis. */
  async function walk(root, { checkProtected = true } = {}) {
    const entries = [];
    const links = [];
    const unreadable = [];
    const special = [];
    const protectedHits = [];
    const stack = [{ abs: root, rel: '' }];
    while (stack.length > 0) {
      const { abs, rel } = stack.pop();
      let names;
      try {
        names = await fsp.readdir(abs);
      } catch (err) {
        unreadable.push({ ruta: abs, codigo: (err && err.code) || 'DESCONOCIDO' });
        continue;
      }
      names.sort();
      for (const name of names) {
        const childAbs = nodePath.join(abs, name);
        const childRel = rel ? `${rel}/${name}` : name;
        let st;
        try {
          st = await fsp.lstat(childAbs);
        } catch (err) {
          unreadable.push({ ruta: childAbs, codigo: (err && err.code) || 'DESCONOCIDO' });
          continue;
        }
        if (checkProtected && isProtected(childAbs)) protectedHits.push(childAbs);
        if (st.isSymbolicLink()) {
          links.push({ ruta: childAbs, rel: childRel });
        } else if (st.isDirectory()) {
          entries.push({ rel: childRel, type: 'dir', mtimeMs: st.mtimeMs });
          stack.push({ abs: childAbs, rel: childRel });
        } else if (st.isFile()) {
          entries.push({ rel: childRel, type: 'file', size: st.size, mtimeMs: st.mtimeMs, atimeMs: st.atimeMs });
        } else {
          special.push({ ruta: childAbs, rel: childRel });
        }
      }
    }
    entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { entries, links, unreadable, special, protectedHits };
  }

  /**
   * ¿El origen sigue EXACTAMENTE como se planificó? Devuelve null si sí, o el motivo si no:
   * misma ruta real (ningún enlace la desvió), no protegido, y mismo recorrido en vivo
   * (nombres, tipos, tamaños y fechas), sin enlaces ni elementos nuevos ilegibles.
   */
  async function sourceChangeReason(folder) {
    try {
      if (!(await stillItsOwnRealPath(folder.source))) return 'su ruta real cambió: un enlace o punto de unión la desvía a otro sitio';
      const again = await walk(folder.source, { checkProtected: false });
      if (again.links.length || again.unreadable.length || again.special.length) return 'aparecieron enlaces o elementos ilegibles';
      if (again.entries.length !== folder.entries.length) return 'cambió la cantidad de archivos o carpetas';
      for (let i = 0; i < again.entries.length; i++) {
        const a = again.entries[i];
        const b = folder.entries[i];
        if (a.rel !== b.rel || a.type !== b.type || a.size !== b.size || a.mtimeMs !== b.mtimeMs) return `cambió «${a.rel}»`;
      }
      return null;
    } catch (err) {
      return `no se pudo volver a leer el origen (${err.code || err.message})`;
    }
  }

  /**
   * ¿La copia de esta carpeta sigue completa en el destino? Comprueba que la carpeta de la copia está
   * REALMENTE dentro del destino elegido (y no es el origen visto por un enlace) y, para cada elemento, que existe
   * con el mismo tipo, tamaño y fecha. No relee el contenido (eso ya lo hizo la verificación completa).
   * Devuelve null si está completa, o el motivo.
   */
  async function copyProblem(folder, destBase, destRoot, fsName) {
    try {
      const realRoot = await fsp.realpath(destRoot);
      const realDest = await fsp.realpath(destBase);
      if (!strictlyInside(realDest, realRoot) || R.isInside(realDest, folder.source) || R.isInside(folder.source, realDest)) return 'la carpeta de la copia ya no está donde debe';
    } catch {
      return 'no se encuentra la carpeta de la copia';
    }
    for (const e of folder.entries) {
      let st;
      try {
        st = await fsp.lstat(relToPath(destBase, e.rel));
      } catch {
        return `falta «${e.rel}»`;
      }
      if (e.type === 'dir') {
        if (!st.isDirectory()) return `«${e.rel}» ya no es una carpeta`;
        continue;
      }
      if (!st.isFile()) return `«${e.rel}» ya no es un archivo`;
      if (st.size !== e.size) return `cambió el tamaño de «${e.rel}»`;
      if (!R.mtimeClose(st.mtimeMs, e.mtimeMs, fsName)) return `cambió la fecha de «${e.rel}»`;
    }
    return null;
  }

  /** Qué se borró y qué no cuando el borrado se detuvo a medias (comparando el origen EN VIVO con el plan). */
  async function describePartial(folder, error) {
    const exists = await fsp.lstat(folder.source).then(() => true, () => false);
    const planned = folder.entries.map((e) => e.rel);
    if (!exists) return { borrados: planned, restantes: [], error };
    const live = await walk(folder.source, { checkProtected: false });
    const remaining = new Set(live.entries.map((e) => e.rel));
    const extra = [...live.links.map((l) => l.rel), ...live.special.map((x) => x.rel), ...live.unreadable.map((u) => u.ruta)];
    const restantes = [...remaining, ...extra];
    return { borrados: planned.filter((rel) => !remaining.has(rel)), restantes: restantes.length ? restantes : ['(la carpeta raíz, vacía)'], error };
  }

  /**
   * BORRADO DEFINITIVO del original de UNA carpeta. Solo borra si TODO esto se cumple, comprobado AQUÍ
   * (no se confía en lo que hizo quien llama):
   *   confirmación explícita · copia verificada por completo (SHA-256) · sin enlaces, ilegibles ni especiales ·
   *   no protegida (ruta real) · el origen no cambió desde el plan · la copia sigue completa en el destino.
   * Si falla a mitad, informa exactamente qué se borró y qué no, y NO reintenta.
   * @returns {Promise<{estado: 'borrado'|'parcial'|'sin-tocar', motivo?: string, codigo?: string, borrados?: string[], restantes?: string[], error?: string}>}
   */
  async function permanentlyDelete({ folder, destBase, destRoot, verified, verify, confirm, fsName }) {
    const keep = (motivo, codigo) => ({ estado: 'sin-tocar', motivo, codigo });
    if (confirm !== true) return keep('Falta la confirmación del borrado definitivo: el original sigue donde estaba', 'sin-confirmacion');
    if (verified !== true || verify !== 'full') return keep('La copia no está verificada por completo: el original sigue donde estaba', 'copia-no-verificada');
    if (folder.links.length || folder.unreadable.length || folder.special.length) {
      return keep('Contiene enlaces o elementos que no se copiaron: se deja el original para no perderlos', 'con-enlaces');
    }
    if (isProtected(folder.source)) return keep('La carpeta está protegida por el sistema (se volvió a comprobar antes de borrarla)', 'protegida');
    const changed = await sourceChangeReason(folder);
    if (changed) return keep(`El origen cambió desde que se planificó (${changed}): no se toca`, 'origen-cambio');
    const lost = await copyProblem(folder, destBase, destRoot, fsName);
    if (lost) return keep(`La copia en el destino ya no está completa (${lost}): el original NO se borra`, 'copia-incompleta');
    let failure = null;
    try {
      await deleteTree(folder.source);
    } catch (err) {
      failure = (err && err.message) || String(err);
    }
    const partial = await describePartial(folder, failure).catch((err) => ({ borrados: [], restantes: ['(no se pudo comprobar qué quedó)'], error: failure || (err && err.message) }));
    if (partial.restantes.length === 0) return { estado: 'borrado' };
    return { estado: 'parcial', ...partial, error: partial.error || 'El sistema terminó, pero la carpeta sigue ahí' };
  }

  /** Aplica el resultado de `permanentlyDelete` a la fila de resultado. Devuelve qué se hizo con el original (para el registro). */
  function applyDeleteOutcome(result, out) {
    result.motivoCodigo = null;
    result.borradoParcial = null;
    if (out.estado === 'borrado') {
      result.resultado = 'original-borrado-definitivamente';
      result.motivo = null;
      return { accion: 'borrado-definitivo', motivo: null };
    }
    if (out.estado === 'parcial') {
      result.resultado = 'borrado-parcial';
      result.motivo = `El borrado se detuvo a medias (${out.error}). Se borraron ${out.borrados.length} elementos y quedaron ${out.restantes.length}. No se reintentó: la copia en el destino está completa.`;
      result.borradoParcial = { borrados: out.borrados, restantes: out.restantes, error: out.error };
      return { accion: 'borrado-parcial', motivo: result.motivo };
    }
    result.resultado = 'original-sin-tocar';
    result.motivo = out.motivo;
    result.motivoCodigo = out.codigo;
    return { accion: 'sin-tocar', motivo: out.motivo };
  }

  // -------------------------------------------------------------------- preflight

  /**
   * Revisa TODO antes de escribir nada (salvo una sonda de escritura que se crea y se quita).
   * @returns {Promise<{blockers: Array, warnings: Array, plan: object|null, destination: object, disposal: object}>}
   */
  async function preflight(rawOptions) {
    const options = rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions) ? rawOptions : {};
    const blockers = [];
    const warnings = [];
    const block = (code, message, extra) => blockers.push({ code, message, ...extra });
    const warn = (code, message, extra) => warnings.push({ code, message, ...extra });
    const { sources, destinationRoot, mode, verify = 'full', disposal = 'ninguna', confirmPermanentDelete = false } = options;
    const result = (plan, destination = null, disposalInfo = null) => ({ blockers, warnings, plan: blockers.length ? null : plan, destination, disposal: disposalInfo });

    if (mode !== 'copy' && mode !== 'move') block('modo-invalido', 'El modo debe ser «copiar» o «transferir (mover)».');
    if (verify !== 'full' && verify !== 'quick') block('verificacion-invalida', 'La verificación debe ser «completa» o «rápida».');
    if (mode === 'move' && !['papelera', 'borrar', 'ninguna'].includes(disposal)) block('disposicion-invalida', 'Qué hacer con el original debe ser Papelera, borrarlo definitivamente o dejarlo.');
    if (mode === 'move' && disposal === 'borrar' && confirmPermanentDelete !== true) {
      block('borrado-sin-confirmar', 'El borrado definitivo del original necesita que lo confirmes de forma explícita.');
    }
    if (mode === 'move' && verify !== 'full') block('mover-requiere-verificacion-completa', 'Para retirar el original hace falta la verificación completa (comparar el contenido); la rápida no lo comprueba.');
    if (!Array.isArray(sources) || sources.length === 0) block('sin-origenes', 'No hay carpetas de origen.');
    else if (sources.length > MAX_SOURCES) block('demasiados-origenes', `Máximo ${MAX_SOURCES} carpetas por operación.`);
    if (typeof destinationRoot !== 'string' || destinationRoot === '' || destinationRoot.includes('\0') || !R.normalizePath(destinationRoot)) {
      block('destino-no-valido', 'El destino debe ser una carpeta con ruta absoluta.');
    } else if (/^[\\/]{2}/.test(destinationRoot) && !/^[\\/]{2}[?.][\\/][A-Za-z]:/.test(destinationRoot)) {
      block('destino-red', 'No se admiten rutas de red como destino en esta versión: elige una unidad con letra (USB, disco externo).');
    }
    if (blockers.length) return result(null);

    const srcList = [];
    for (const raw of sources) {
      if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || !R.normalizePath(raw)) {
        block('origen-no-valido', 'Un origen no es una ruta absoluta válida.', { ruta: String(raw).slice(0, 200) });
        continue;
      }
      srcList.push(raw);
    }
    if (blockers.length) return result(null);

    // Rutas REALES: un enlace (o punto de unión) en medio de la ruta puede llevar a otro sitio, y las
    // protecciones y las comprobaciones «dentro de» comparan texto. Todo se decide con la ruta real.
    const realOf = async (p) => {
      try {
        return await fsp.realpath(p);
      } catch {
        return null; // no existe: se informa más abajo
      }
    };
    const givenList = srcList;
    const realList = await Promise.all(givenList.map(realOf));
    const effList = givenList.map((g, i) => realList[i] || g); // ruta real, o la dada si no existe
    const destReal = await realOf(destinationRoot);
    const destEff = destReal || destinationRoot;
    const same = (a, b) => a === b || (R.isInside(a, b) && R.isInside(b, a));

    // Origen protegido: se vuelve a comprobar AHORA (no solo al listar), con la ruta dada Y la real.
    givenList.forEach((g, i) => {
      if (isProtected(g)) block('origen-protegido', describeProtectedSource(g) || `«${g}» está protegido y no se puede copiar ni mover.`, { ruta: g });
      else if (!same(effList[i], g) && isProtected(effList[i])) {
        block('origen-protegido', `«${g}» pasa por un enlace y en realidad es «${effList[i]}». ${describeProtectedSource(effList[i]) || 'Esa ruta está protegida.'}`, { ruta: g, rutaReal: effList[i] });
      }
    });
    // Orígenes repetidos o anidados (por ruta real).
    for (let i = 0; i < effList.length; i++) {
      for (let j = 0; j < effList.length; j++) {
        if (i !== j && R.isInside(effList[i], effList[j]) && !(R.isInside(effList[j], effList[i]) && j < i)) {
          block('origen-anidado', `«${givenList[i]}» está dentro de otra carpeta de origen («${givenList[j]}»).`, { ruta: givenList[i] });
        }
      }
    }
    if (isProtectedDest(destinationRoot)) block('destino-protegido', explainDest(destinationRoot), { ruta: destinationRoot });
    else if (destReal && !same(destReal, destinationRoot) && isProtectedDest(destReal)) {
      block('destino-protegido', `«${destinationRoot}» pasa por un enlace y en realidad es «${destReal}». ${explainDest(destReal)}`, { ruta: destinationRoot, rutaReal: destReal });
    }
    givenList.forEach((g, i) => {
      if (R.isInside(destinationRoot, g) || R.isInside(destEff, effList[i])) {
        block('destino-dentro-del-origen', `El destino está dentro de la carpeta de origen «${g}» (o es la misma)${same(destEff, destinationRoot) ? '' : `: pasa por un enlace y en realidad es «${destEff}»`}.`, { ruta: g });
      }
    });

    // Destino: carpeta existente y escribible (sonda propia).
    let destStat = null;
    try {
      destStat = await fsp.stat(destEff);
    } catch {
      block('destino-no-existe', 'La carpeta de destino no existe o no está disponible (¿el disco está conectado?).');
    }
    if (destStat && !destStat.isDirectory()) block('destino-no-es-carpeta', 'El destino no es una carpeta.');
    if (blockers.length) return result(null);

    const probeName = `.byd-sonda-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const probePath = nodePath.join(destEff, probeName);
    let probeCreated = false;
    try {
      const h = await fsp.open(probePath, 'wx');
      probeCreated = true;
      try {
        await h.write(Buffer.from('BoneYardDog: sonda de escritura\n'));
        await h.sync();
      } finally {
        await h.close();
      }
    } catch (err) {
      block('destino-no-escribible', `No se puede escribir en el destino (${(err && err.code) || 'error'}).`);
    }
    if (probeCreated) {
      try {
        await fsp.unlink(probePath); // archivo propio de esta comprobación
      } catch {
        warn('sonda-no-retirada', `No se pudo quitar el archivo de prueba «${probeName}» del destino; puedes borrarlo.`);
      }
    }

    // Orígenes: carpeta real, sin enlaces en la raíz.
    const walks = [];
    for (let i = 0; i < givenList.length; i++) {
      const s = givenList[i];
      let st;
      try {
        st = await fsp.lstat(s);
      } catch {
        block('origen-no-existe', `«${s}» no existe.`, { ruta: s });
        walks.push(null);
        continue;
      }
      if (st.isSymbolicLink()) {
        block('origen-es-enlace', `«${s}» es un enlace, no una carpeta.`, { ruta: s });
        walks.push(null);
        continue;
      }
      if (!st.isDirectory()) {
        block('origen-no-es-carpeta', `«${s}» no es una carpeta.`, { ruta: s });
        walks.push(null);
        continue;
      }
      const w = await walk(effList[i]);
      if (w.protectedHits.length) {
        block('origen-contiene-protegidos', `«${s}» contiene elementos protegidos del sistema.`, { ruta: s, ejemplos: w.protectedHits.slice(0, 5) });
      }
      walks.push({ st, ...w });
    }
    if (blockers.length) return result(null);

    // Información del destino (formato, espacio).
    let info = unknownVolume();
    try {
      info = (await volumeInfo(destEff)) || unknownVolume();
    } catch {
      info = unknownVolume();
    }
    const fsName = info.fileSystem || 'desconocido';
    const limits = R.limitsFor(fsName);

    // Totales y comprobaciones por formato.
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    const tooBig = [];
    const warnBig = [];
    const badNames = [];
    const manyEntries = [];
    const longPaths = [];
    // Nombres finales: solo el nombre de la carpeta; si ya existe algo igual (o dos orígenes se llaman igual), «Fotos (2)».
    const taken = new Set((await fsp.readdir(destEff).catch(() => [])).map((n) => n.toLowerCase()));
    const existing = new Set(taken); // lo que YA estaba en el destino (para explicar por qué se renombra)
    const renamedList = [];
    const planSources = effList.map((s, i) => {
      const w = walks[i];
      const baseName = nodePath.basename(s);
      const alreadyThere = existing.has(baseName.toLowerCase());
      const names = pickNames(baseName, taken);
      if (names.renamed) renamedList.push({ origen: s, nombre: baseName, guardadoComo: names.finalName, motivo: alreadyThere ? 'ya-existe' : 'repetido' });
      const destBase = nodePath.join(destEff, names.finalName);
      let sFiles = 0;
      let sDirs = 0;
      let sBytes = 0;
      const byParent = new Map();
      for (const e of w.entries) {
        const idx = e.rel.lastIndexOf('/');
        const parent = idx === -1 ? '' : e.rel.slice(0, idx);
        const name = idx === -1 ? e.rel : e.rel.slice(idx + 1);
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent).push(name);
        if (e.type === 'file') {
          sFiles++;
          sBytes += e.size;
          if (limits.maxFileBytes !== null && e.size > limits.maxFileBytes) tooBig.push({ ruta: nodePath.join(s, ...e.rel.split('/')), bytes: e.size });
          if (limits.warnFileAtLeastBytes !== null && e.size >= limits.warnFileAtLeastBytes) warnBig.push({ ruta: nodePath.join(s, ...e.rel.split('/')), bytes: e.size });
        } else sDirs++;
        // La ruta más larga es la de la carpeta provisional (lleva «.copiando»): se avisa con ella.
        const destPath = relToPath(nodePath.join(destEff, names.workName), e.rel);
        if (R.checkPathLength(destPath).warning) longPaths.push(destPath);
      }
      for (const [parent, nameList] of byParent) {
        for (const name of nameList) {
          const problems = R.checkName(name, fsName, { siblings: nameList });
          if (problems.length) badNames.push({ ruta: relToPath(s, parent), nombre: name, problemas: problems.map((p) => p.message) });
        }
        if (limits.maxEntriesPerFolder !== null && nameList.length > limits.maxEntriesPerFolder) manyEntries.push({ ruta: relToPath(s, parent), entradas: nameList.length });
      }
      for (const nm of [names.finalName, names.workName]) {
        const problems = R.checkName(nm, fsName);
        if (problems.length) badNames.push({ ruta: s, nombre: nm, problemas: problems.map((p) => p.message) });
      }
      files += sFiles;
      dirs += sDirs + 1;
      bytes += sBytes;
      return {
        index: i,
        source: s, // ruta REAL
        requested: givenList[i], // la que se pidió
        baseName,
        finalName: names.finalName,
        workName: names.workName,
        renamed: names.renamed,
        destino: destBase,
        files: sFiles,
        dirs: sDirs,
        bytes: sBytes,
        mtimeMs: w.st.mtimeMs,
        entries: w.entries,
        links: w.links,
        unreadable: w.unreadable,
        special: w.special,
      };
    });
    if (renamedList.length) {
      warn(
        'renombrado-por-nombre-existente',
        renamedList.map((r) => `Se guardará como «${r.guardadoComo}» porque ${r.motivo === 'ya-existe' ? 'ya existe algo con ese nombre en el destino' : 'otra carpeta elegida se llama igual'}.`).join(' '),
        { carpetas: renamedList },
      );
    }

    if (tooBig.length) {
      block('archivo-demasiado-grande', `El destino está en formato ${fsName}, que no admite archivos de más de 4 GB. Elige otro destino o reformatea el disco a exFAT o NTFS (se borra todo lo que tenga).`, { archivos: tooBig.slice(0, 20), cantidad: tooBig.length });
    }
    if (badNames.length) {
      block('nombres-no-validos', 'Hay nombres que el destino no admite (caracteres no permitidos, nombres reservados de Windows, terminan en espacio o punto, o chocan por mayúsculas).', { nombres: badNames.slice(0, 50), cantidad: badNames.length });
    }
    const required = R.requiredFreeBytes(bytes);
    if (typeof info.freeBytes === 'number') {
      if (info.freeBytes < required) {
        block('sin-espacio', 'No hay espacio libre suficiente en el destino (se necesita lo copiado más un margen).', { libreBytes: info.freeBytes, necesarioBytes: required, copiarBytes: bytes });
      }
    } else {
      warn('espacio-desconocido', 'No se pudo saber cuánto espacio libre tiene el destino; si se llena, la operación se detendrá sin tocar los originales.');
    }

    // Avisos.
    const allLinks = planSources.flatMap((p) => p.links.map((l) => l.ruta));
    const allUnreadable = planSources.flatMap((p) => p.unreadable);
    const allSpecial = planSources.flatMap((p) => p.special.map((x) => x.ruta));
    if (allLinks.length) warn('enlaces-no-se-copian', 'Estos enlaces (accesos directos del sistema) no se siguen ni se copian.', { enlaces: allLinks.slice(0, 50), cantidad: allLinks.length });
    if (allUnreadable.length) warn('elementos-ilegibles', 'Estos elementos no se pudieron leer y no se copiarán.', { elementos: allUnreadable.slice(0, 50), cantidad: allUnreadable.length });
    if (allSpecial.length) warn('tipos-especiales', 'Estos elementos son de tipo especial y no se copian.', { elementos: allSpecial.slice(0, 50), cantidad: allSpecial.length });
    if (allLinks.length || allUnreadable.length || allSpecial.length) {
      if (mode === 'move') warn('original-no-se-retirara', 'Las carpetas con enlaces, elementos ilegibles o especiales se copian, pero su original NO se retira (se perdería lo que no se copió).');
    }
    const dests = await Promise.all(effList.map(async (s) => ({ s, dev: (await fsp.stat(s)).dev })));
    const destDev = (await fsp.stat(destEff)).dev;
    const sameDisk = dests.filter((d) => d.dev === destDev || R.sameVolume(d.s, destEff));
    if (sameDisk.length) warn('mismo-disco', 'El origen y el destino están en el mismo disco: no liberarás espacio con esto.', { origenes: sameDisk.map((d) => d.s) });
    if (longPaths.length) warn('ruta-larga', 'Algunas rutas de destino superan 240 caracteres; el Explorador de Windows puede fallar con ellas (límite 260).', { ejemplos: longPaths.slice(0, 5), cantidad: longPaths.length });
    if (manyEntries.length) warn('carpeta-con-muchas-entradas', `En ${fsName} las carpetas con muchas entradas (unas ${limits.maxEntriesPerFolder}) se vuelven lentas o fallan.`, { carpetas: manyEntries.slice(0, 20) });
    if (fsName === 'desconocido' || fsName === 'otro') warn('formato-desconocido', 'No se pudo saber el formato del destino; se aplican reglas cautelosas.');
    if (warnBig.length) warn('archivo-de-4gb-o-mas', 'Hay archivos de 4 GB o más y no se sabe si el destino los admite.', { archivos: warnBig.slice(0, 20) });
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const od = env[key];
      if (typeof od === 'string' && od !== '') {
        const inOd = givenList.filter((g, i) => R.isInside(g, od) || R.isInside(effList[i], od));
        if (inOd.length) warn('onedrive', 'Esta carpeta está dentro de OneDrive: los archivos que están solo en la nube se descargarían al copiarlos.', { origenes: inOd });
        break;
      }
    }

    // Disposición del original.
    const disposalInfo = { elegida: mode === 'move' ? disposal : 'ninguna', papelera: null };
    if (mode === 'move' && disposal === 'papelera') {
      let srcInfo = unknownVolume();
      try {
        srcInfo = (await volumeInfo(effList[0])) || unknownVolume();
      } catch {
        srcInfo = unknownVolume();
      }
      const verdict = R.recycleVerdict({ bytes, source: { driveType: srcInfo.driveType, sizeBytes: srcInfo.sizeBytes } });
      disposalInfo.papelera = verdict;
      if (typeof trash !== 'function') block('sin-funcion-papelera', 'No hay forma de enviar a la Papelera en este entorno.');
      // El 5 % es solo una estimación: NO bloquea. La interfaz pregunta qué hacer (borrar definitivamente o dejar el original).
      else if (verdict.verdict === 'puede-no-caber' || verdict.verdict === 'sin-papelera') {
        warn('papelera-no-cabe', verdict.reason, { veredicto: verdict.verdict, bytes, carpetas: planSources.length });
      } else if (verdict.verdict === 'desconocido') {
        warn('papelera-desconocida', verdict.reason, { veredicto: verdict.verdict });
      }
    }

    const plan = {
      version: 2,
      mode,
      verify,
      disposal: disposalInfo.elegida,
      confirmPermanentDelete: disposalInfo.elegida === 'borrar' && confirmPermanentDelete === true,
      recycleVerdict: disposalInfo.papelera ? disposalInfo.papelera.verdict : null,
      destinationRoot: destEff, // ruta REAL
      fileSystem: fsName,
      sources: planSources,
      totals: { files, dirs, bytes },
    };
    return result(plan, { fileSystem: fsName, driveType: info.driveType, freeBytes: info.freeBytes, sizeBytes: info.sizeBytes, requiredBytes: required }, disposalInfo);
  }

  // -------------------------------------------------------------------------- run

  /** Quita lo que ESTA operación creó bajo `root` (lista registrada), sin seguir enlaces y sin salir de `root`. */
  async function removeCreated(created, root, container) {
    const rep = { quitados: 0, omitidos: [] };
    const note = (r, p) => {
      if (r === 'quitado') rep.quitados++;
      else if (r !== 'ya-no-esta') rep.omitidos.push({ ruta: p, motivo: r });
    };
    const files = created.filter((c) => c.type === 'file');
    const dirs = created.filter((c) => c.type === 'dir').sort((a, b) => b.rel.split('/').length - a.rel.split('/').length);
    for (const e of [...files, ...dirs]) {
      const p = relToPath(root, e.rel);
      note(await removeCreatedEntry({ path: p, type: e.type }, root), p);
    }
    note(await removeCreatedEntry({ path: root, type: 'dir' }, container), root);
    rep.limpio = rep.omitidos.length === 0 && !(await fsp.lstat(root).then(() => true, () => false));
    return rep;
  }

  /** Una operación sobre un disco que no responde no puede colgar la limpieza: se da por fallida a los `ms`. */
  function withTimeout(promise, ms) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sin respuesta del disco')), ms); if (timer.unref) timer.unref(); })]).finally(() => clearTimeout(timer));
  }

  /**
   * Ejecuta un plan de `preflight`. NUNCA sobrescribe. Cada carpeta se copia a `<destino>\<nombre>.copiando` y SOLO cuando
   * TODA ella quedó copiada y verificada se renombra a `<destino>\<nombre>` (mismo volumen). Si algo falla o se cancela, el
   * motor quita lo que creó (la carpeta provisional y su contenido). En el destino no se escribe nada más que la carpeta.
   * @param {object} plan
   * @param {{onProgress?: Function, signal?: AbortSignal, progressIntervalMs?: number, hooks?: object}} [opts]
   */
  async function runBody(plan, { onProgress, signal, progressIntervalMs = 200, hooks = {} } = {}, hb = { tick: null }) {
    // `hooks` existe SOLO para pruebas (simular que algo cambia en un momento exacto).
    if (!plan || plan.version !== 2 || !Array.isArray(plan.sources) || !['copy', 'move'].includes(plan.mode) || !['full', 'quick'].includes(plan.verify)) {
      throw new Error('Plan no válido: hay que usar el que devuelve preflight()');
    }
    if (plan.mode === 'move' && plan.verify !== 'full') throw new Error('Para retirar el original hace falta la verificación completa');
    const startedAt = now();
    const fsName = plan.fileSystem || 'desconocido';
    const destRoot = plan.destinationRoot;
    const results = [];
    const ctxs = [];
    let fatal = null;
    let cancelled = false;
    const totalBytes = plan.totals.bytes;
    const totalFiles = plan.totals.files;
    let overallBytes = 0;
    let overallFiles = 0;
    let copiedBytes = 0;
    let verifiedBytes = 0;
    let lastEmit = 0;
    const speedStart = Date.now();
    // Latido: etapa actual y desde cuándo no avanzan los bytes (para que la pantalla nunca parezca congelada).
    let etapa = 'preparando destino';
    let advancedAt = Date.now();
    let lastMark = 0;
    let lastExtra = { fase: 'preparando' };
    const setEtapa = (name, datos) => {
      if (etapa !== name) dlog('etapa', { etapa: name, ...datos });
      etapa = name;
      emit({}, true);
    };

    const throwIfAborted = () => {
      if (signal && signal.aborted) throw new AbortedError();
    };

    function emit(extra, force) {
      if (!onProgress) return;
      const t = Date.now();
      if (overallBytes !== lastMark) {
        lastMark = overallBytes;
        advancedAt = t;
      }
      if (!force && t - lastEmit < progressIntervalMs) return;
      lastEmit = t;
      lastExtra = { ...lastExtra, ...extra };
      const elapsed = Math.max(1, t - speedStart) / 1000;
      const bps = overallBytes / elapsed;
      const remaining = Math.max(0, totalBytes * (plan.mode === 'move' || plan.verify === 'full' ? 2 : 1) - overallBytes);
      onProgress({
        ...lastExtra,
        bytesPerSecond: Math.round(bps),
        etaSeconds: bps > 0 ? Math.round(remaining / bps) : null,
        overallBytesDone: overallBytes,
        overallFilesDone: overallFiles,
        copiadoBytes: copiedBytes,
        verificadoBytes: verifiedBytes,
        totalVerificarBytes: plan.verify === 'full' ? totalBytes : 0,
        totalBytes,
        totalFiles,
        etapa,
        sinAvanceSegundos: Math.round(((t - advancedAt) / 1000) * 10) / 10,
        rssMB: Math.round(process.memoryUsage().rss / 1048576),
      });
    }
    hb.tick = () => emit({}, true); // el latido: cada segundo, aunque no haya terminado ningún bloque

    const journalAdd = async (ruta, origen) => {
      if (registry && registry.addPending) await registry.addPending({ ruta, raiz: destRoot, origen }).catch(() => {});
    };
    const journalRemove = async (ruta) => {
      if (registry && registry.removePending) await registry.removePending(ruta).catch(() => {});
    };

    // El destino debe seguir ahí antes de empezar.
    await fsp.stat(destRoot).catch((err) => {
      throw new FatalTransferError(`El destino no está disponible (${err.code || err.message})`, err.code);
    });
    // Nombres ocupados AHORA (el plan pudo quedar viejo): nunca se mezcla con algo existente.
    const taken = new Set((await fsp.readdir(destRoot).catch(() => [])).map((n) => n.toLowerCase()));

    // ---- copia de un archivo (a la carpeta provisional)
    async function copyOne(srcPath, destPath, entry, ctx) {
      const before = await fsp.lstat(srcPath).catch((err) => {
        throw Object.assign(new Error('origen no legible'), { code: err.code, side: 'source' });
      });
      if (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
        throw Object.assign(new Error('El archivo cambió desde que se planificó la copia'), { code: 'CAMBIO_ANTES', side: 'source', custom: true });
      }
      let sha = null;
      let destCreated = false;
      const doHash = plan.verify === 'full';
      const fileStart = Date.now();
      let timings = { aperturaOrigenMs: null, aperturaDestinoMs: null, primeraLecturaMs: null, syncMs: null };
      try {
        if (!doHash && entry.size < COPYFILE_MAX) {
          // Rápida y pequeño: un solo golpe (copyFile no informa del avance, pero dura un instante).
          setEtapa('copiando', { ruta: srcPath, tamano: entry.size });
          try {
            await fsp.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
          } catch (err) {
            // copyFile no dice de qué lado falló: por el código se distingue el destino del origen.
            throw Object.assign(err, { side: ['EEXIST', 'ENOSPC', 'EROFS'].includes(err.code) ? 'dest' : 'source' });
          }
          destCreated = true;
          ctx.created.push({ rel: entry.rel, type: 'file' });
          setEtapa('guardando en el disco', { ruta: destPath });
          const h = await fsp.open(destPath, 'r+');
          try {
            await h.sync();
          } finally {
            await h.close();
          }
          overallBytes += entry.size;
          copiedBytes += entry.size;
          ctx.bytes += entry.size;
        } else {
          let src;
          let dst;
          try {
            setEtapa('abriendo origen', { ruta: srcPath, tamano: entry.size });
            let t0 = Date.now();
            src = await fsp.open(srcPath, 'r').catch((err) => {
              throw Object.assign(err, { side: 'source' });
            });
            timings.aperturaOrigenMs = Date.now() - t0; // un antivirus que examina un archivo recién creado se nota aquí o en la primera lectura
            setEtapa('abriendo destino', { ruta: destPath });
            t0 = Date.now();
            dst = await fsp.open(destPath, 'wx').catch((err) => {
              throw Object.assign(err, { side: 'dest' });
            });
            timings.aperturaDestinoMs = Date.now() - t0;
            destCreated = true;
            ctx.created.push({ rel: entry.rel, type: 'file' });
            const hash = doHash ? crypto.createHash('sha256') : null;
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = 0;
            setEtapa('copiando', { ruta: srcPath });
            for (;;) {
              throwIfAborted();
              const tr = Date.now();
              const { bytesRead } = await src.read(buf, 0, buf.length, pos).catch((err) => {
                throw Object.assign(err, { side: 'source' });
              });
              if (pos === 0) {
                timings.primeraLecturaMs = Date.now() - tr;
                dlog('archivo-abierto', { ruta: srcPath, tamano: entry.size, ...timings });
              }
              if (bytesRead === 0) break;
              if (hash) hash.update(buf.subarray(0, bytesRead));
              let off = 0;
              while (off < bytesRead) {
                const { bytesWritten } = await dst.write(buf, off, bytesRead - off, null).catch((err) => {
                  throw Object.assign(err, { side: 'dest' });
                });
                off += bytesWritten;
              }
              pos += bytesRead;
              overallBytes += bytesRead;
              copiedBytes += bytesRead;
              ctx.bytes += bytesRead;
              emit({ fase: 'copiando', carpeta: ctx.origen, carpetaIndice: ctx.index, archivo: srcPath, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
            }
            setEtapa('guardando en el disco', { ruta: destPath });
            const ts = Date.now();
            await dst.sync().catch((err) => {
              throw Object.assign(err, { side: 'dest' });
            });
            timings.syncMs = Date.now() - ts;
            sha = hash ? hash.digest('hex') : null;
            if (pos !== entry.size) {
              throw Object.assign(new Error('Se leyó un tamaño distinto al esperado'), { code: 'CAMBIO_DURANTE', side: 'source', custom: true });
            }
          } finally {
            if (src) await src.close().catch(() => {});
            if (dst) await dst.close().catch(() => {});
          }
        }
        // ¿Cambió el origen mientras se copiaba?
        const after = await fsp.lstat(srcPath).catch((err) => {
          throw Object.assign(err, { side: 'source' });
        });
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
          throw Object.assign(new Error('El archivo cambió durante la copia'), { code: 'CAMBIO_DURANTE', side: 'source', custom: true });
        }
        // Fechas: se conserva la de modificación.
        try {
          await fsp.utimes(destPath, before.atimeMs / 1000, before.mtimeMs / 1000);
        } catch (err) {
          throw Object.assign(err, { side: 'dest' });
        }
        const ms = Date.now() - fileStart;
        dlog('archivo-copiado', { ruta: srcPath, tamano: entry.size, ms, ...timings, mbPorSeg: ms > 0 ? Math.round((entry.size / 1048576 / (ms / 1000)) * 10) / 10 : null });
        return sha;
      } catch (err) {
        dlog('archivo-error', { ruta: srcPath, tamano: entry.size, etapa, codigo: err && err.code, lado: err && err.side, mensaje: err && err.message, ...timings });
        if (destCreated) await removeOwn(destPath, ctx.workPath).catch(() => {}); // lo que quedó a medias lo creamos nosotros
        throw err;
      }
    }

    // ---- verificación de un archivo ya copiado (releyéndolo del destino, con avance por bloques)
    async function hashFile(p, ctx, rel) {
      const t0 = Date.now();
      const h = await fsp.open(p, 'r');
      const openMs = Date.now() - t0;
      try {
        const hash = crypto.createHash('sha256');
        const buf = Buffer.allocUnsafe(CHUNK);
        let pos = 0;
        for (;;) {
          throwIfAborted();
          const tr = Date.now();
          const { bytesRead } = await h.read(buf, 0, buf.length, pos);
          if (pos === 0) dlog('verificacion-abierta', { ruta: p, aperturaMs: openMs, primeraLecturaMs: Date.now() - tr });
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
          overallBytes += bytesRead;
          verifiedBytes += bytesRead;
          emit({ fase: 'verificando', carpeta: ctx.origen, carpetaIndice: ctx.index, archivo: p, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
        }
        return { sha: hash.digest('hex'), bytes: pos };
      } finally {
        await h.close().catch(() => {});
      }
    }

    // ---- una carpeta de origen completa
    for (const folder of plan.sources) {
      if (fatal || cancelled) {
        results.push({
          origen: folder.source,
          solicitado: folder.requested || folder.source,
          nombreFinal: folder.finalName,
          resultado: 'cancelada',
          motivo: fatal ? `Se detuvo toda la operación: ${fatal.message}` : 'Cancelada antes de empezar esta carpeta. No se tocó nada.',
          motivoCodigo: null,
          verificada: false,
          verificacion: plan.verify,
          errores: [],
          limpieza: null,
        });
        ctxs.push(null);
        continue;
      }
      const names = pickNames(folder.baseName, taken);
      const finalPath = nodePath.join(destRoot, names.finalName);
      const workPath = nodePath.join(destRoot, names.workName);
      const ctx = { origen: folder.source, index: folder.index, bytes: 0, files: 0, totalBytes: folder.bytes, totalFiles: folder.files, workPath, finalPath, root: workPath, created: [], workCreated: false, renamed: false, keepWork: false };
      ctxs.push(ctx);
      const errores = [];
      const archivos = [];
      const fileHashes = new Map();
      const result = {
        origen: folder.source,
        solicitado: folder.requested || folder.source,
        nombreFinal: names.finalName,
        destino: finalPath,
        carpetaProvisional: workPath,
        resultado: 'copiada-verificada',
        motivo: null,
        motivoCodigo: null,
        verificada: false,
        verificacion: plan.verify,
        errores,
        limpieza: null,
        registroId: null,
      };
      const addError = (rel, err, fallback) => {
        const c = err && err.custom ? { message: err.message, code: err.code } : classify(err, err && err.side);
        errores.push({ ruta: rel, codigo: c.code, mensaje: fallback || c.message });
        return c;
      };
      let dirEntries = [];

      try {
        throwIfAborted();
        try {
          setEtapa('creando la carpeta provisional', { ruta: workPath });
          await fsp.mkdir(workPath); // sin recursive: si algo apareció con ese nombre, es un error
        } catch (err) {
          throw Object.assign(err, { side: 'dest' });
        }
        ctx.workCreated = true;
        await journalAdd(workPath, folder.source);
        dirEntries = folder.entries.filter((e) => e.type === 'dir');
        for (const d of dirEntries) {
          throwIfAborted();
          const p = relToPath(workPath, d.rel);
          try {
            await fsp.mkdir(p);
            ctx.created.push({ rel: d.rel, type: 'dir' });
          } catch (err) {
            const c = classify(Object.assign(err, { side: 'dest' }), 'dest');
            if (c.fatal) throw Object.assign(err, { side: 'dest' });
            errores.push({ ruta: d.rel, codigo: c.code, mensaje: `Carpeta: ${c.message}` });
          }
        }

        // Archivos.
        const fileEntries = folder.entries.filter((e) => e.type === 'file');
        for (const e of fileEntries) {
          throwIfAborted();
          const srcPath = relToPath(folder.source, e.rel);
          const destPath = relToPath(workPath, e.rel);
          if (hooks.beforeFile) await hooks.beforeFile({ srcPath, destPath, entry: e, folder });
          try {
            const sha = await copyOne(srcPath, destPath, e, ctx);
            if (sha) fileHashes.set(e.rel, sha);
            ctx.files++;
            overallFiles++;
            archivos.push({ ruta: e.rel, tamano: e.size, mtimeMs: e.mtimeMs, sha256: sha || null });
            emit({ fase: 'copiando', carpeta: folder.source, carpetaIndice: folder.index, archivo: srcPath, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
          } catch (err) {
            if (err instanceof AbortedError) throw err;
            const c = classify(err, err && err.side);
            if (c.fatal) throw Object.assign(err, { fatalInfo: c });
            addError(e.rel, err);
            dlog('error-de-archivo', { ruta: e.rel, codigo: err && err.code, mensaje: err && err.message });
            ctx.files++;
            overallFiles++;
          }
        }

        // Verificación.
        if (errores.length === 0) {
          for (const e of fileEntries) {
            throwIfAborted();
            const destPath = relToPath(workPath, e.rel);
            const srcRec = archivos.find((a) => a.ruta === e.rel);
            setEtapa('verificando destino', { ruta: destPath });
            emit({ fase: 'verificando', carpeta: folder.source, carpetaIndice: folder.index, archivo: destPath, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
            try {
              const st = await fsp.lstat(destPath);
              if (!st.isFile() || st.size !== e.size) {
                errores.push({ ruta: e.rel, codigo: 'TAMANO', mensaje: `El tamaño en el destino (${st.size}) no coincide con el original (${e.size})` });
                continue;
              }
              if (plan.verify === 'full') {
                const { sha } = await hashFile(destPath, ctx, e.rel);
                if (sha !== srcRec.sha256) {
                  errores.push({ ruta: e.rel, codigo: 'HUELLA', mensaje: 'La huella SHA-256 del destino no coincide con la del original: la copia está dañada' });
                  continue;
                }
              } else if (!R.mtimeClose(st.mtimeMs, e.mtimeMs, fsName)) {
                errores.push({ ruta: e.rel, codigo: 'FECHA', mensaje: 'La fecha de modificación del destino no coincide con la del original' });
                continue;
              }
            } catch (err) {
              if (err instanceof AbortedError) throw err;
              const c = classify(Object.assign(err, { side: 'dest' }), 'dest');
              if (c.fatal) throw Object.assign(err, { fatalInfo: c });
              errores.push({ ruta: e.rel, codigo: c.code, mensaje: `Al verificar: ${c.message}` });
            }
          }
        }

        // Carpetas: fechas (de las hojas hacia la raíz) y comparación del contenido del destino con el plan.
        for (const d of [...dirEntries].sort((a, b) => b.rel.split('/').length - a.rel.split('/').length)) {
          try {
            await fsp.utimes(relToPath(workPath, d.rel), d.mtimeMs / 1000, d.mtimeMs / 1000);
          } catch {
            /* la fecha de una carpeta no es crítica */
          }
        }
        try {
          await fsp.utimes(workPath, folder.mtimeMs / 1000, folder.mtimeMs / 1000);
        } catch {
          /* idem */
        }
        {
          setEtapa('comparando la carpeta con lo planificado', { ruta: workPath });
          const live = await walk(workPath, { checkProtected: false });
          const want = new Map(folder.entries.map((e) => [e.rel, e]));
          const failedRels = new Set(errores.map((x) => x.ruta));
          let gotBytes = 0;
          for (const e of live.entries) {
            const w = want.get(e.rel);
            if (!w) errores.push({ ruta: e.rel, codigo: 'SOBRANTE', mensaje: 'Hay algo en el destino que no estaba en el plan' });
            else if (w.type !== e.type) errores.push({ ruta: e.rel, codigo: 'TIPO', mensaje: 'El tipo en el destino no coincide con el original' });
            else if (e.type === 'file') gotBytes += e.size;
          }
          const have = new Set(live.entries.map((e) => e.rel));
          for (const e of folder.entries) {
            if (!have.has(e.rel) && !failedRels.has(e.rel)) errores.push({ ruta: e.rel, codigo: 'FALTANTE', mensaje: 'Falta en el destino' });
          }
          if (errores.length === 0 && (gotBytes !== folder.bytes || live.entries.filter((e) => e.type === 'file').length !== folder.files)) {
            errores.push({ ruta: '', codigo: 'TOTALES', mensaje: 'Las cantidades o los bytes del destino no coinciden con el plan' });
          }
        }

        if (errores.length > 0) {
          result.resultado = 'con-errores';
          result.motivo = `${errores.length} problema(s) al copiar o verificar. El original no se tocó.`;
        } else {
          throwIfAborted();
          if (hooks.beforeRename) await hooks.beforeRename({ folder, workPath, finalPath }); // solo pruebas
          // ---- TODO copiado y verificado: la carpeta provisional pasa a su nombre final (nunca sobrescribe)
          setEtapa('cambiando el nombre a la carpeta final', { de: workPath, a: finalPath });
          const outcome = await renameToFinal(workPath, finalPath);
          if (outcome.ok) {
            ctx.renamed = true;
            ctx.root = finalPath;
            result.verificada = true;
            try {
              await fsp.utimes(finalPath, folder.mtimeMs / 1000, folder.mtimeMs / 1000);
            } catch {
              /* la fecha de la carpeta no es crítica */
            }
          } else {
            ctx.keepWork = true; // la copia está verificada: se conserva con su nombre provisional
            result.resultado = 'con-errores';
            result.motivoCodigo = 'nombre-ocupado';
            result.verificada = false;
            result.motivo = `La copia quedó completa y verificada, pero «${names.finalName}» apareció en el destino mientras tanto y no se sobrescribe. Se dejó como «${names.workName}»: cámbiale el nombre o bórrala tú. El original no se tocó. (${outcome.reason})`;
          }
        }
      } catch (err) {
        if (err instanceof AbortedError) {
          cancelled = true;
          result.resultado = 'cancelada';
          result.motivo = 'Cancelada por el usuario.';
        } else {
          const c = err && err.fatalInfo ? err.fatalInfo : classify(err, err && err.side);
          result.resultado = 'con-errores';
          if (c.fatal) {
            fatal = { message: c.message, code: c.code };
            result.motivo = `Se detuvo toda la operación: ${c.message}`;
          } else result.motivo = c.message;
          errores.push({ ruta: '', codigo: c.code, mensaje: c.message });
        }
      }

      // ---- si algo salió mal, esta operación quita lo que creó (la carpeta provisional y su contenido)
      if (ctx.workCreated && !ctx.renamed && !ctx.keepWork) {
        let lim;
        try {
          lim = await withTimeout(removeCreated(ctx.created, workPath, destRoot), fatal ? 8000 : 120000);
        } catch (err) {
          lim = { limpio: false, quitados: 0, omitidos: [{ ruta: workPath, motivo: (err && err.message) || 'error' }] };
        }
        result.limpieza = { limpia: lim.limpio, pendientes: lim.limpio ? [] : [workPath] };
        if (lim.limpio) {
          await journalRemove(workPath);
          result.motivo = `${result.motivo || ''} Se quitó la copia incompleta. Los originales no se tocaron.`.trim();
        } else if (fatal) {
          result.motivo = `El disco se desconectó o dejó de responder. Los originales no se tocaron. Vuelve a conectarlo y revisa si quedó una carpeta «${names.workName}» para borrarla.`;
        } else {
          result.motivo = `${result.motivo || ''} No se pudo quitar del todo la copia incompleta: quedó la carpeta «${names.workName}» en el destino. Bórrala tú.`.trim();
        }
      } else if (ctx.renamed) {
        await journalRemove(workPath);
      } else if (ctx.keepWork) {
        result.limpieza = { limpia: false, pendientes: [workPath] }; // verificada pero con su nombre provisional: se explica en el motivo
      }

      // ---- registro para verificar más tarde (en el PC, no en el destino)
      let originalInfo = { accion: 'sin-tocar', motivo: result.resultado === 'copiada-verificada' ? 'copiar no retira nada' : 'la copia no quedó verificada' };
      if (ctx.renamed && result.verificada && registry && registry.save) {
        setEtapa('guardando el registro de la copia');
        try {
          result.registroId = await registry.save({
            version: 1,
            nombre: names.finalName,
            origen: folder.source,
            destino: finalPath,
            destinoRaiz: destRoot,
            fecha: new Date(startedAt).toISOString(),
            modo: plan.mode,
            verificacion: plan.verify,
            sistemaDeArchivos: fsName,
            totalBytes: folder.bytes,
            archivos,
            carpetasVacias: dirEntries.map((d) => d.rel),
            original: originalInfo,
          });
        } catch (err) {
          result.avisoRegistro = `No se pudo guardar el registro para verificar más tarde (${(err && err.message) || err}). La copia está bien igualmente.`;
        }
      }

      // ---- retirar el original (solo modo "mover", solo tras verificar TODO)
      if (plan.mode === 'move' && result.resultado === 'copiada-verificada' && result.verificada) {
        setEtapa('retirando el original', { ruta: folder.source });
        emit({ fase: 'retirando original', carpeta: folder.source, carpetaIndice: folder.index, archivo: folder.source, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles }, true);
        const keep = (motivo, codigo = null) => {
          result.resultado = 'original-sin-tocar';
          result.motivo = motivo;
          result.motivoCodigo = codigo;
          originalInfo = { accion: 'sin-tocar', motivo };
        };
        if (plan.disposal === 'ninguna') {
          keep('Pedido: dejar el original donde está');
        } else if (signal && signal.aborted) {
          cancelled = true;
          keep('Cancelada antes de retirar el original');
        } else if (plan.disposal === 'borrar') {
          if (hooks.afterVerify) await hooks.afterVerify({ folder }); // solo pruebas
          const out = await permanentlyDelete({ folder, destBase: finalPath, destRoot, verified: result.verificada, verify: plan.verify, confirm: plan.confirmPermanentDelete, fsName });
          originalInfo = applyDeleteOutcome(result, out);
        } else if (plan.disposal !== 'papelera') {
          keep(`Disposición desconocida: ${String(plan.disposal)}`);
        } else if (isProtected(folder.source)) {
          keep('La carpeta está protegida por el sistema (se volvió a comprobar antes de retirarla)');
        } else if (folder.links.length || folder.unreadable.length || folder.special.length) {
          keep('Contiene enlaces o elementos que no se copiaron: se deja el original para no perderlos');
        } else {
          if (hooks.afterVerify) await hooks.afterVerify({ folder }); // solo pruebas
          // El origen debe seguir EXACTAMENTE como se planificó.
          const changed = await sourceChangeReason(folder);
          if (changed) {
            keep(`El origen cambió desde que se planificó (${changed}): no se toca`);
          } else {
            const noCabe = plan.recycleVerdict === 'puede-no-caber' || plan.recycleVerdict === 'sin-papelera';
            try {
              if (typeof trash !== 'function') throw new Error('No hay función de Papelera');
              await trashOriginal(folder.source);
              const stillThere = await fsp.lstat(folder.source).then(() => true, () => false);
              if (stillThere) keep('La Papelera no retiró la carpeta: el original sigue donde estaba', noCabe ? 'papelera-no-cabe' : 'papelera-fallo');
              else {
                result.resultado = 'original-enviado-a-papelera';
                originalInfo = { accion: 'papelera', motivo: null };
              }
            } catch (err) {
              const msg = (err && err.message) || String(err);
              keep(`No se pudo enviar a la Papelera (${msg}): el original sigue donde estaba`, noCabe ? 'papelera-no-cabe' : 'papelera-fallo');
              result.errorPapelera = msg;
            }
          }
        }
      }
      if (result.registroId && registry && registry.update) await registry.update(result.registroId, { original: originalInfo }).catch(() => {});
      results.push(result);
    }

    // ---- cierre
    const anyError = results.some((r) => r.resultado === 'con-errores' || r.resultado === 'borrado-parcial');
    const estado = cancelled ? 'cancelado' : fatal || anyError ? 'con-errores' : 'completo';
    emit({ fase: 'terminado', bytesDone: overallBytes, bytesTotal: totalBytes, filesDone: overallFiles, filesTotal: totalFiles }, true);

    const outcome = {
      estado,
      abortada: fatal,
      verificacion: plan.verify,
      avisoVerificacion: plan.verify === 'quick' ? 'Verificación RÁPIDA: solo comprueba tamaño y fecha, NO el contenido.' : null,
      destinoRaiz: destRoot,
      carpetas: results,
      totales: { archivos: overallFiles, bytes: totalBytes },
    };
    // Lo que `eliminarDefinitivamente` y `quitarCopiado` necesitan: no se enumera ni sale del motor.
    Object.defineProperty(outcome, '_interno', { value: { plan, ctxs, fsName }, enumerable: false });
    return outcome;
  }

  /** `run` con latido: cada segundo emite el estado aunque no haya terminado ningún bloque. */
  async function run(plan, opts = {}) {
    const hb = { tick: null };
    const timer = setInterval(() => hb.tick && hb.tick(), 1000);
    if (timer.unref) timer.unref();
    dlog('inicio', { modo: plan && plan.mode, verificacion: plan && plan.verify, carpetas: plan && plan.sources ? plan.sources.length : 0, bytes: plan && plan.totals ? plan.totals.bytes : null, destino: plan && plan.destinationRoot, formato: plan && plan.fileSystem });
    try {
      const out = await runBody(plan, opts, hb);
      dlog('fin', { estado: out.estado, abortada: out.abortada, carpetas: out.carpetas.map((c) => [c.nombreFinal, c.resultado]) });
      return out;
    } catch (err) {
      dlog('fallo', { mensaje: err && err.message, codigo: err && err.code });
      throw err;
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * Pasa la carpeta provisional a su nombre final SIN sobrescribir: si el nombre final ya existe (aunque sea una carpeta
   * vacía, que en algunos sistemas el rename reemplazaría), no se hace nada y se informa.
   */
  async function renameToFinal(workPath, finalPath) {
    const exists = await fsp.lstat(finalPath).then(() => true, () => false);
    if (exists) return { ok: false, reason: 'ya existe algo con ese nombre' };
    try {
      await fsp.rename(workPath, finalPath);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `no se pudo cambiar el nombre: ${(err && err.code) || (err && err.message) || err}` };
    }
  }

  // ------------------------------------------------------------ eliminarDefinitivamente

  /**
   * Borra definitivamente el original de carpetas de un resultado YA terminado cuya Papelera falló
   * (o se calculó que no cabía). Aplica EXACTAMENTE las mismas comprobaciones que el borrado de `run`
   * (todo se vuelve a comprobar ahora) y rechaza —sin tocar nada— cualquier índice que no corresponda.
   * @param {object} resultado Lo que devolvió `run`.
   * @param {number[]} indices Posiciones en `resultado.carpetas`.
   * @param {{confirm: boolean}} options `confirm` debe ser exactamente `true`.
   */
  async function eliminarDefinitivamente(resultado, indices, { confirm } = {}) {
    const inn = resultado && resultado._interno;
    if (!inn || !Array.isArray(resultado.carpetas)) throw new Error('Resultado no válido');
    if (confirm !== true) throw new Error('Falta la confirmación del borrado definitivo');
    if (!Array.isArray(indices) || indices.length === 0 || indices.length > MAX_SOURCES) throw new Error('Hay que indicar qué carpetas borrar');
    if (new Set(indices).size !== indices.length) throw new Error('Hay índices repetidos');
    for (const i of indices) {
      if (!Number.isInteger(i) || i < 0 || i >= resultado.carpetas.length) throw new Error(`El índice ${String(i)} no corresponde a ninguna carpeta`);
      const c = resultado.carpetas[i];
      if (c.resultado !== 'original-sin-tocar' || !['papelera-fallo', 'papelera-no-cabe'].includes(c.motivoCodigo)) {
        throw new Error(`La carpeta «${c.origen}» no se puede borrar así: su estado es «${c.resultado}»${c.motivoCodigo ? ` (${c.motivoCodigo})` : ''}`);
      }
    }
    const done = [];
    for (const i of indices) {
      const c = resultado.carpetas[i];
      const out = await permanentlyDelete({
        folder: inn.plan.sources[i],
        destBase: c.destino,
        destRoot: inn.plan.destinationRoot,
        verified: c.verificada,
        verify: resultado.verificacion,
        confirm: true,
        fsName: inn.fsName,
      });
      const originalInfo = applyDeleteOutcome(c, out);
      if (c.registroId && registry && registry.update) await registry.update(c.registroId, { original: originalInfo }).catch(() => {});
      done.push({ indice: i, resultado: c.resultado, motivo: c.motivo, borradoParcial: c.borradoParcial });
    }
    if (resultado.carpetas.some((r) => r.resultado === 'borrado-parcial') && resultado.estado === 'completo') resultado.estado = 'con-errores';
    return { carpetas: done, estado: resultado.estado };
  }

  // -------------------------------------------------------------- quitarCopiado

  /**
   * Deshace una COPIA completa (para «Quitar la copia»): quita solo lo que esta operación creó (lista registrada), sin
   * seguir enlaces y sin salir de la carpeta copiada. Se niega si ya se retiró algún original (la copia es lo único que
   * queda) y solo toca carpetas copiadas y verificadas cuyo original sigue ahí.
   */
  async function quitarCopiado(resultado) {
    const inn = resultado && resultado._interno;
    if (!inn || !Array.isArray(resultado.carpetas)) throw new Error('Resultado no válido');
    if (resultado.carpetas.some((c) => ['original-enviado-a-papelera', 'original-borrado-definitivamente', 'borrado-parcial'].includes(c.resultado))) {
      throw new Error('No se puede quitar la copia: ya se retiró algún original y la copia es lo único que queda');
    }
    const report = { quitados: 0, omitidos: [], carpetas: [] };
    resultado.carpetas.forEach((c, i) => {
      const ctx = inn.ctxs[i];
      if (ctx && ctx.renamed && c.verificada === true && ['copiada-verificada', 'original-sin-tocar'].includes(c.resultado)) report.carpetas.push(i);
    });
    if (report.carpetas.length === 0) throw new Error('No hay ninguna copia que se pueda quitar');
    for (const i of report.carpetas) {
      const c = resultado.carpetas[i];
      const ctx = inn.ctxs[i];
      const r = await removeCreated(ctx.created, ctx.finalPath, inn.plan.destinationRoot);
      report.quitados += r.quitados;
      report.omitidos.push(...r.omitidos);
      if (r.limpio) {
        c.resultado = 'copia-quitada';
        c.verificada = false;
        c.motivo = 'La copia se quitó. El original no se tocó.';
        if (c.registroId && registry && registry.remove) await registry.remove(c.registroId).catch(() => {});
      }
    }
    return report;
  }

  // ------------------------------------------------- carpetas provisionales de una sesión anterior

  /**
   * Borra UNA carpeta provisional «….copiando» que el diario sabe que creó esta app (por ejemplo tras un cierre forzado).
   * Se niega si el nombre no es de una carpeta provisional, si no es una carpeta de verdad (un enlace no), si no está
   * donde el diario la anotó o si el diario no la conoce.
   */
  async function removePendingWork(ruta, entry) {
    if (typeof ruta !== 'string' || !entry || entry.ruta !== ruta || !WORK_RE.test(nodePath.basename(ruta))) throw new Error('Esa carpeta no es una copia incompleta de BoneYardDog');
    let st;
    try {
      st = await fsp.lstat(ruta);
    } catch {
      return { estado: 'ya-no-esta' };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('Esa ruta no es una carpeta normal: no se toca');
    const realParent = await fsp.realpath(nodePath.dirname(ruta));
    const realRoot = await fsp.realpath(entry.raiz);
    if (!R.isInside(realParent, realRoot) || !R.isInside(realRoot, realParent)) throw new Error('La carpeta no está donde la anotó BoneYardDog: no se toca');
    if (isProtectedDest(ruta)) throw new Error('La carpeta está en una zona protegida: no se toca');
    await fsp.rm(ruta, { recursive: true, force: false });
    return { estado: 'quitada' };
  }

  // ----------------------------------------------------------------------- verifyRecord

  /**
   * Vuelve a comprobar una copia ya hecha con los datos de su REGISTRO (guardado en el PC): cada archivo debe estar, con su
   * tamaño y —en modo completo— su huella SHA-256; no debe sobrar nada. NUNCA dice «bien» si no se comprobó ningún
   * archivo. Estados: 'ok' | 'problemas' | 'sin-archivos' | 'no-disponible' | 'distinta'.
   */
  async function verifyRecord(record, { mode = 'full', onProgress, signal } = {}) {
    if (!record || typeof record.destino !== 'string' || !R.normalizePath(record.destino) || !Array.isArray(record.archivos)) throw new Error('El registro de esa copia no es válido');
    const fsName = record.sistemaDeArchivos || 'desconocido';
    const root = record.destino;
    const drive = /^[A-Za-z]:/.test(root) ? `${root[0].toUpperCase()}:` : null;
    let st;
    try {
      st = await fsp.lstat(root);
    } catch (err) {
      const gone = err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err.code === 'EIO' || err.code === 'ENODEV' || err.code === 'ENXIO');
      return { estado: 'no-disponible', modo: mode, verificados: 0, problemas: [], motivo: gone ? `No encuentro esa carpeta: conecta el disco${drive ? ` ${drive}` : ''} y vuelve a probar.` : `No se pudo leer esa carpeta (${(err && err.code) || (err && err.message)}).` };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { estado: 'distinta', modo: mode, verificados: 0, problemas: [], motivo: `«${root}» ya no es la carpeta que se copió (es un archivo o un enlace).` };
    const safeRel = (rel) => typeof rel === 'string' && rel !== '' && !rel.split('/').some((p) => p === '..' || p === '' || p === '.') && !/^[A-Za-z]:|^[\\/]/.test(rel) && !rel.includes('\\') && !rel.includes('\0');
    const problems = [];
    const expected = new Set();
    let checked = 0;
    let bytesChecked = 0;
    const totalFiles = record.archivos.length;
    for (const a of record.archivos) {
      if (signal && signal.aborted) throw new AbortedError();
      if (!safeRel(a.ruta)) {
        problems.push({ ruta: String(a.ruta), problema: 'ruta-no-valida' });
        continue;
      }
      expected.add(a.ruta);
      const p = relToPath(root, a.ruta);
      checked++;
      try {
        const fst = await fsp.lstat(p);
        if (!fst.isFile()) problems.push({ ruta: a.ruta, problema: 'no-es-archivo' });
        else if (fst.size !== a.tamano) problems.push({ ruta: a.ruta, problema: 'tamano', esperado: a.tamano, encontrado: fst.size });
        else if (mode === 'full' && a.sha256) {
          const h = await fsp.open(p, 'r');
          try {
            const hash = crypto.createHash('sha256');
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = 0;
            for (;;) {
              if (signal && signal.aborted) throw new AbortedError();
              const { bytesRead } = await h.read(buf, 0, buf.length, pos);
              if (bytesRead === 0) break;
              hash.update(buf.subarray(0, bytesRead));
              pos += bytesRead;
              bytesChecked += bytesRead;
              if (onProgress) onProgress({ fase: 'verificando', filesDone: checked - 1, filesTotal: totalFiles, bytesDone: bytesChecked, archivo: p });
            }
            if (hash.digest('hex') !== a.sha256) problems.push({ ruta: a.ruta, problema: 'huella' });
          } finally {
            await h.close().catch(() => {});
          }
        } else if (!R.mtimeClose(fst.mtimeMs, a.mtimeMs, fsName)) {
          problems.push({ ruta: a.ruta, problema: 'fecha' });
        } else if (mode === 'full' && !a.sha256) {
          problems.push({ ruta: a.ruta, problema: 'sin-huella-en-el-registro', aviso: true });
        }
      } catch (err) {
        if (err instanceof AbortedError) throw err;
        problems.push({ ruta: a.ruta, problema: err.code === 'ENOENT' ? 'falta' : `error-${err.code || 'desconocido'}` });
      }
      if (onProgress) onProgress({ fase: 'verificando', filesDone: checked, filesTotal: totalFiles, bytesDone: bytesChecked, archivo: p });
    }
    // Carpetas vacías y sobrantes (archivos o carpetas que no estaban en el registro).
    const emptyDirs = new Set((record.carpetasVacias || []).filter(safeRel));
    for (const d of emptyDirs) {
      const dst = await fsp.lstat(relToPath(root, d)).catch(() => null);
      if (!dst || !dst.isDirectory()) problems.push({ ruta: d, problema: 'falta' });
    }
    try {
      const live = await walk(root, { checkProtected: false });
      const dirsKnown = new Set();
      for (const rel of [...expected, ...emptyDirs]) {
        const parts = rel.split('/');
        for (let i = 1; i <= parts.length; i++) dirsKnown.add(parts.slice(0, i).join('/'));
      }
      for (const e of live.entries) {
        if (e.type === 'file' && !expected.has(e.rel)) problems.push({ ruta: e.rel, problema: 'sobrante' });
        else if (e.type === 'dir' && !dirsKnown.has(e.rel)) problems.push({ ruta: e.rel, problema: 'sobrante' });
      }
      if (live.unreadable.length) problems.push({ ruta: live.unreadable[0].ruta, problema: 'ilegible' });
    } catch {
      /* si no se puede leer la carpeta, ya se informó cada archivo como faltante */
    }
    const real = problems.filter((x) => !x.aviso);
    const estado = real.length > 0 ? 'problemas' : checked === 0 ? 'sin-archivos' : 'ok';
    return {
      estado,
      modo: mode,
      verificados: checked,
      problemas: problems,
      motivo: estado === 'sin-archivos' ? 'No había archivos que comprobar en esa copia (el registro no trae ninguno).' : null,
    };
  }

  return { preflight, run, quitarCopiado, eliminarDefinitivamente, removePendingWork, verifyRecord, walk };
}

module.exports = { createTransferEngine, pickNames, WORK_RE, splitAbsolute, FatalTransferError, AbortedError, MAX_SOURCES };
