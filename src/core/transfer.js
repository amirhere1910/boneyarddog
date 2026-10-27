'use strict';

/**
 * Motor de copia y transferencia de carpetas a otro disco.
 *
 * REGLA DE ORO: este código NUNCA elimina nada del origen salvo mediante la función de
 * disposición (la Papelera inyectada, o `fs.rename` a cuarentena), y solo tras verificar
 * TODO. La única otra eliminación permitida es quitar archivos y carpetas que ESTA operación
 * creó en el destino (lista registrada, dentro de su carpeta de lote). Las únicas llamadas a
 * unlink/rmdir/rename de todo el archivo están en `removeOwn`, `removeCreatedEntry` y
 * `disposeOriginal`; hay una prueba que lo revisa en el código fuente.
 *
 * Todo se hace con módulos de Node. Las dependencias se inyectan (`fs`, `volumeInfo`, `trash`,
 * `now`, `env`, `volumeRoot`, `isProtected`) para poder probar cada caso sin tocar discos reales.
 *
 * Estructura en el destino:
 *   <destino>\BoneYardDog\<AAAA-MM-DD_HHMM>\<letra de unidad>\<ruta relativa original>
 * con ESTADO.json, MANIFIESTO.json y LEEME.txt dentro de la carpeta de lote. Nunca sobrescribe:
 * los archivos se abren con 'wx' y las carpetas se crean sin `recursive` (si algo existe, es un
 * error de ese elemento).
 */

const nodePath = require('node:path');
const crypto = require('node:crypto');
const { isProtectedPath } = require('./protected');
const { unknownVolume } = require('./volume');
const R = require('./transfer-rules');

const CHUNK = 1024 * 1024;
const MAX_SOURCES = 500;
const BATCH_DIR = 'BoneYardDog';
const QUARANTINE_DIR = 'BoneYardDog-Cuarentena';
const SIDE_FILES = new Set(['ESTADO.json', 'MANIFIESTO.json', 'LEEME.txt']);
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

const pad = (n) => String(n).padStart(2, '0');

function batchName(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
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

function leemeBatch({ fecha, modo, verificacion, destino }) {
  return [
    'BONEYARDDOG — COPIA DE CARPETAS',
    '',
    `Esta carpeta la creó BoneYardDog el ${fecha}.`,
    `Contiene copias de carpetas de tu equipo (modo: ${modo === 'move' ? 'transferir (copiar y retirar el original)' : 'copiar'}).`,
    `Verificación: ${verificacion === 'full' ? 'completa (se comparó el contenido de cada archivo con una huella SHA-256)' : 'RÁPIDA (solo tamaño y fecha: NO comprueba el contenido)'}.`,
    '',
    'QUÉ HAY AQUÍ',
    '  · Una carpeta por cada unidad de origen (C, D, …) y dentro la ruta original de cada carpeta.',
    '  · ESTADO.json: cómo terminó la operación (completo, con errores o cancelado).',
    '  · MANIFIESTO.json: la lista de archivos con tamaño, fecha y huella, y qué se hizo con cada original.',
    '',
    'CÓMO RESTAURAR',
    '  Copia de vuelta la carpeta que necesites al lugar que quieras, con el Explorador de Windows.',
    '',
    'CÓMO VERIFICAR',
    '  Abre BoneYardDog y usa «Verificar un lote». Compara de nuevo cada archivo con el MANIFIESTO.',
    '  Conviene hacerlo después de expulsar y volver a conectar el disco.',
    '',
    `Ubicación: ${destino}`,
    '',
  ].join('\r\n');
}

function leemeQuarantine({ fecha, lote }) {
  return [
    'BONEYARDDOG — CUARENTENA',
    '',
    `El ${fecha} BoneYardDog movió aquí (lote ${lote}) carpetas que ya se habían copiado y verificado en otro disco.`,
    'No se borró nada: solo se cambiaron de lugar. Si ya comprobaste que la copia está bien,',
    'puedes eliminar esta carpeta desde el Explorador de Windows (clic derecho > Eliminar).',
    'Si necesitas recuperar algo, muévelo de vuelta a su ubicación original (la ruta está dentro de este lote).',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------- el motor

function createTransferEngine(deps = {}) {
  const fs = deps.fs || require('node:fs');
  const fsp = fs.promises;
  const volumeInfo = deps.volumeInfo || (async () => unknownVolume());
  const trash = deps.trash || null;
  const now = deps.now || (() => Date.now());
  const isProtected = deps.isProtected || isProtectedPath;
  const env = deps.env || process.env;
  const appVersion = deps.appVersion || '0.0.0';

  /** Raíz del volumen de una ruta: la unidad en Windows; en otros sistemas, el ancestro más alto con el mismo `dev`. */
  const volumeRoot =
    deps.volumeRoot ||
    (async (p) => {
      if (/^[A-Za-z]:[\\/]/.test(p)) return `${p[0].toUpperCase()}:\\`;
      let current = p;
      const dev = (await fsp.stat(p)).dev;
      for (;;) {
        const parent = nodePath.dirname(current);
        if (parent === current) return current;
        let st;
        try {
          st = await fsp.stat(parent);
        } catch {
          return current;
        }
        if (st.dev !== dev) return current;
        current = parent;
      }
    });

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
  async function removeOwn(filePath, batchFolder) {
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

  /** Disposición del original: Papelera inyectada, o rename a cuarentena. Solo se llama tras verificar todo. */
  async function disposeOriginal(kind, sourcePath, quarantinePath) {
    if (kind === 'papelera') {
      await trash(sourcePath);
      return;
    }
    if (kind === 'cuarentena') {
      await fsp.rename(sourcePath, quarantinePath);
      return;
    }
    throw new Error(`Disposición desconocida: ${kind}`);
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
    const { sources, destinationRoot, mode, verify = 'full', disposal = 'ninguna', acceptRecycleRisk = false } = options;
    const result = (plan, destination = null, disposalInfo = null) => ({ blockers, warnings, plan: blockers.length ? null : plan, destination, disposal: disposalInfo });

    if (mode !== 'copy' && mode !== 'move') block('modo-invalido', 'El modo debe ser «copiar» o «transferir (mover)».');
    if (verify !== 'full' && verify !== 'quick') block('verificacion-invalida', 'La verificación debe ser «completa» o «rápida».');
    if (mode === 'move' && !['papelera', 'cuarentena', 'ninguna'].includes(disposal)) block('disposicion-invalida', 'Qué hacer con el original debe ser Papelera, cuarentena o dejarlo.');
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

    // Origen protegido: se vuelve a comprobar AHORA (no solo al listar).
    for (const s of srcList) {
      if (isProtected(s)) block('origen-protegido', `«${s}» está protegido por el sistema y no se puede copiar ni mover.`, { ruta: s });
    }
    // Orígenes repetidos o anidados.
    for (let i = 0; i < srcList.length; i++) {
      for (let j = 0; j < srcList.length; j++) {
        if (i !== j && R.isInside(srcList[i], srcList[j]) && !(R.isInside(srcList[j], srcList[i]) && j < i)) {
          block('origen-anidado', `«${srcList[i]}» está dentro de otra carpeta de origen («${srcList[j]}»).`, { ruta: srcList[i] });
        }
      }
    }
    if (isProtected(destinationRoot)) block('destino-protegido', 'El destino está en una carpeta protegida del sistema.', { ruta: destinationRoot });
    for (const s of srcList) {
      if (R.isInside(destinationRoot, s)) block('destino-dentro-del-origen', `El destino está dentro de la carpeta de origen «${s}» (o es la misma).`, { ruta: s });
    }

    // Destino: carpeta existente y escribible (sonda propia).
    let destStat = null;
    try {
      destStat = await fsp.stat(destinationRoot);
    } catch {
      block('destino-no-existe', 'La carpeta de destino no existe o no está disponible (¿el disco está conectado?).');
    }
    if (destStat && !destStat.isDirectory()) block('destino-no-es-carpeta', 'El destino no es una carpeta.');
    if (blockers.length) return result(null);

    const probeName = `.byd-sonda-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const probePath = nodePath.join(destinationRoot, probeName);
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
    for (const s of srcList) {
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
      const w = await walk(s);
      if (w.protectedHits.length) {
        block('origen-contiene-protegidos', `«${s}» contiene elementos protegidos del sistema.`, { ruta: s, ejemplos: w.protectedHits.slice(0, 5) });
      }
      walks.push({ st, ...w });
    }
    if (blockers.length) return result(null);

    // Información del destino (formato, espacio).
    let info = unknownVolume();
    try {
      info = (await volumeInfo(destinationRoot)) || unknownVolume();
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
    const name0 = batchName(now());
    const batchPlanned = nodePath.join(destinationRoot, BATCH_DIR, name0);
    const planSources = srcList.map((s, i) => {
      const w = walks[i];
      const { drive, parts } = splitAbsolute(s);
      const destBase = nodePath.join(batchPlanned, drive, ...parts);
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
        const destPath = relToPath(destBase, e.rel);
        if (R.checkPathLength(destPath).warning) longPaths.push(destPath);
      }
      for (const [parent, names] of byParent) {
        for (const name of names) {
          const problems = R.checkName(name, fsName, { siblings: names });
          if (problems.length) badNames.push({ ruta: relToPath(s, parent), nombre: name, problemas: problems.map((p) => p.message) });
        }
        if (limits.maxEntriesPerFolder !== null && names.length > limits.maxEntriesPerFolder) manyEntries.push({ ruta: relToPath(s, parent), entradas: names.length });
      }
      for (const part of parts) {
        const problems = R.checkName(part, fsName);
        if (problems.length) badNames.push({ ruta: s, nombre: part, problemas: problems.map((p) => p.message) });
      }
      files += sFiles;
      dirs += sDirs + 1;
      bytes += sBytes;
      return {
        index: i,
        source: s,
        driveFolder: drive,
        destParts: [drive, ...parts],
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
    const dests = await Promise.all(srcList.map(async (s) => ({ s, dev: (await fsp.stat(s)).dev })));
    const destDev = destStat.dev;
    const sameDisk = dests.filter((d) => d.dev === destDev || R.sameVolume(d.s, destinationRoot));
    if (sameDisk.length) warn('mismo-disco', 'El origen y el destino están en el mismo disco: no liberarás espacio con esto.', { origenes: sameDisk.map((d) => d.s) });
    if (longPaths.length) warn('ruta-larga', 'Algunas rutas de destino superan 240 caracteres; el Explorador de Windows puede fallar con ellas (límite 260).', { ejemplos: longPaths.slice(0, 5), cantidad: longPaths.length });
    if (manyEntries.length) warn('carpeta-con-muchas-entradas', `En ${fsName} las carpetas con muchas entradas (unas ${limits.maxEntriesPerFolder}) se vuelven lentas o fallan.`, { carpetas: manyEntries.slice(0, 20) });
    if (fsName === 'desconocido' || fsName === 'otro') warn('formato-desconocido', 'No se pudo saber el formato del destino; se aplican reglas cautelosas.');
    if (warnBig.length) warn('archivo-de-4gb-o-mas', 'Hay archivos de 4 GB o más y no se sabe si el destino los admite.', { archivos: warnBig.slice(0, 20) });
    for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const od = env[key];
      if (typeof od === 'string' && od !== '') {
        const inOd = srcList.filter((s) => R.isInside(s, od));
        if (inOd.length) warn('onedrive', 'Esta carpeta está dentro de OneDrive: los archivos que están solo en la nube se descargarían al copiarlos.', { origenes: inOd });
        break;
      }
    }

    // Disposición del original.
    const disposalInfo = { elegida: mode === 'move' ? disposal : 'ninguna', papelera: null };
    if (mode === 'move' && disposal === 'papelera') {
      let srcInfo = unknownVolume();
      try {
        srcInfo = (await volumeInfo(srcList[0])) || unknownVolume();
      } catch {
        srcInfo = unknownVolume();
      }
      const verdict = R.recycleVerdict({ bytes, source: { driveType: srcInfo.driveType, sizeBytes: srcInfo.sizeBytes } });
      disposalInfo.papelera = verdict;
      if (typeof trash !== 'function') block('sin-funcion-papelera', 'No hay forma de enviar a la Papelera en este entorno.');
      else if (verdict.verdict !== 'probablemente-cabe' && !acceptRecycleRisk) {
        block('papelera-no-recomendada', verdict.reason, { veredicto: verdict.verdict });
      } else if (verdict.verdict !== 'probablemente-cabe') {
        warn('papelera-riesgo-aceptado', verdict.reason, { veredicto: verdict.verdict });
      }
    }

    const plan = {
      version: 1,
      mode,
      verify,
      disposal: disposalInfo.elegida,
      destinationRoot,
      batchName: name0,
      fileSystem: fsName,
      sources: planSources,
      totals: { files, dirs, bytes },
    };
    return result(plan, { fileSystem: fsName, driveType: info.driveType, freeBytes: info.freeBytes, sizeBytes: info.sizeBytes, requiredBytes: required }, disposalInfo);
  }

  // -------------------------------------------------------------------------- run

  /**
   * Ejecuta un plan de `preflight`. NUNCA sobrescribe. Devuelve el resultado completo (ver README del motor).
   * @param {object} plan
   * @param {{onProgress?: Function, signal?: AbortSignal, progressIntervalMs?: number}} [opts]
   */
  async function run(plan, { onProgress, signal, progressIntervalMs = 200, hooks = {} } = {}) {
    // `hooks` existe SOLO para pruebas (simular que algo cambia en un momento exacto).
    if (!plan || plan.version !== 1 || !Array.isArray(plan.sources) || !['copy', 'move'].includes(plan.mode) || !['full', 'quick'].includes(plan.verify)) {
      throw new Error('Plan no válido: hay que usar el que devuelve preflight()');
    }
    if (plan.mode === 'move' && plan.verify !== 'full') throw new Error('Para retirar el original hace falta la verificación completa');
    const startedAt = now();
    const created = []; // todo lo que ESTA operación creó: { path, type }
    const fsName = plan.fileSystem || 'desconocido';
    const results = [];
    let fatal = null;
    let cancelled = false;
    let batchFolder = null;
    const totalBytes = plan.totals.bytes;
    const totalFiles = plan.totals.files;
    let overallBytes = 0;
    let overallFiles = 0;
    let lastEmit = 0;
    const speedStart = Date.now();

    const throwIfAborted = () => {
      if (signal && signal.aborted) throw new AbortedError();
    };

    function emit(extra, force) {
      if (!onProgress) return;
      const t = Date.now();
      if (!force && t - lastEmit < progressIntervalMs) return;
      lastEmit = t;
      const elapsed = Math.max(1, t - speedStart) / 1000;
      const bps = overallBytes / elapsed;
      const remaining = Math.max(0, totalBytes * (plan.mode === 'move' || plan.verify === 'full' ? 2 : 1) - overallBytes);
      onProgress({
        bytesPerSecond: Math.round(bps),
        etaSeconds: bps > 0 ? Math.round(remaining / bps) : null,
        overallBytesDone: overallBytes,
        overallFilesDone: overallFiles,
        totalBytes,
        totalFiles,
        ...extra,
      });
    }

    // ---- lote
    const batchParent = nodePath.join(plan.destinationRoot, BATCH_DIR);
    await fsp.mkdir(batchParent, { recursive: true }).catch((err) => {
      throw new FatalTransferError(`No se pudo crear la carpeta de BoneYardDog en el destino (${err.code || err.message})`, err.code);
    });
    let unique = plan.batchName;
    for (let n = 2; ; n++) {
      try {
        await fsp.mkdir(nodePath.join(batchParent, unique));
        break;
      } catch (err) {
        if (err.code === 'EEXIST') {
          unique = `${plan.batchName}-${n}`;
          continue;
        }
        throw new FatalTransferError(`No se pudo crear la carpeta del lote (${err.code || err.message})`, err.code);
      }
    }
    batchFolder = nodePath.join(batchParent, unique);
    created.push({ path: batchParent, type: 'dir', shared: true }, { path: batchFolder, type: 'dir' });

    async function writeSide(name, content) {
      const p = nodePath.join(batchFolder, name);
      try {
        const existed = created.some((c) => c.path === p);
        await fsp.writeFile(p, content, { flag: 'w' }); // archivo propio de esta operación
        if (!existed) created.push({ path: p, type: 'file' });
      } catch (err) {
        throw new FatalTransferError(`No se pudo escribir ${name} en el destino (${err.code || err.message})`, err.code);
      }
    }

    const stamp = new Date(startedAt).toISOString();
    const manifest = {
      version: 1,
      app: { nombre: 'BoneYardDog', version: appVersion },
      fecha: stamp,
      modo: plan.mode,
      verificacion: plan.verify,
      avisoVerificacion: plan.verify === 'quick' ? 'Verificación RÁPIDA: solo comprueba tamaño y fecha, NO el contenido.' : null,
      destino: plan.destinationRoot,
      lote: unique,
      sistemaDeArchivos: fsName,
      carpetas: [],
    };
    const estado = { version: 1, estado: 'en-curso', modo: plan.mode, verificacion: plan.verify, inicio: stamp, fin: null, carpetas: [] };
    await writeSide('LEEME.txt', leemeBatch({ fecha: stamp, modo: plan.mode, verificacion: plan.verify, destino: batchFolder }));
    await writeSide('ESTADO.json', JSON.stringify(estado, null, 2));
    await writeSide('MANIFIESTO.json', JSON.stringify(manifest, null, 2));

    const saveProgress = async () => {
      estado.carpetas = results.map((r) => ({ origen: r.origen, resultado: r.resultado }));
      manifest.carpetas = results.map((r) => r.manifest);
      await writeSide('ESTADO.json', JSON.stringify(estado, null, 2));
      await writeSide('MANIFIESTO.json', JSON.stringify(manifest, null, 2));
    };

    // ---- copia de un archivo
    async function copyOne(srcPath, destPath, entry, ctx) {
      const before = await fsp.lstat(srcPath).catch((err) => {
        throw Object.assign(new Error('origen no legible'), { code: err.code, side: 'source' });
      });
      if (before.size !== entry.size || before.mtimeMs !== entry.mtimeMs) {
        throw Object.assign(new Error('El archivo cambió desde que se planificó la copia'), { code: 'CAMBIO_ANTES', side: 'source', custom: true });
      }
      let sha = null;
      let destCreated = false;
      try {
        if (plan.verify === 'quick') {
          try {
            await fsp.copyFile(srcPath, destPath, fs.constants.COPYFILE_EXCL);
          } catch (err) {
            // copyFile no dice de qué lado falló: por el código se distingue el destino del origen.
            throw Object.assign(err, { side: ['EEXIST', 'ENOSPC', 'EROFS'].includes(err.code) ? 'dest' : 'source' });
          }
          destCreated = true;
          created.push({ path: destPath, type: 'file' });
          const h = await fsp.open(destPath, 'r+');
          try {
            await h.sync();
          } finally {
            await h.close();
          }
          overallBytes += entry.size;
          ctx.bytes += entry.size;
        } else {
          let src;
          let dst;
          try {
            src = await fsp.open(srcPath, 'r').catch((err) => {
              throw Object.assign(err, { side: 'source' });
            });
            dst = await fsp.open(destPath, 'wx').catch((err) => {
              throw Object.assign(err, { side: 'dest' });
            });
            destCreated = true;
            created.push({ path: destPath, type: 'file' });
            const hash = crypto.createHash('sha256');
            const buf = Buffer.allocUnsafe(CHUNK);
            let pos = 0;
            for (;;) {
              throwIfAborted();
              const { bytesRead } = await src.read(buf, 0, buf.length, pos).catch((err) => {
                throw Object.assign(err, { side: 'source' });
              });
              if (bytesRead === 0) break;
              hash.update(buf.subarray(0, bytesRead));
              let off = 0;
              while (off < bytesRead) {
                const { bytesWritten } = await dst.write(buf, off, bytesRead - off, null).catch((err) => {
                  throw Object.assign(err, { side: 'dest' });
                });
                off += bytesWritten;
              }
              pos += bytesRead;
              overallBytes += bytesRead;
              ctx.bytes += bytesRead;
              emit({ fase: 'copiando', carpeta: ctx.origen, carpetaIndice: ctx.index, archivo: srcPath, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
            }
            await dst.sync().catch((err) => {
              throw Object.assign(err, { side: 'dest' });
            });
            sha = hash.digest('hex');
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
        return sha;
      } catch (err) {
        if (destCreated) await removeOwn(destPath, batchFolder).catch(() => {}); // lo que quedó a medias lo creamos nosotros
        throw err;
      }
    }

    // ---- verificación de un archivo ya copiado
    async function hashFile(p) {
      const h = await fsp.open(p, 'r');
      try {
        const hash = crypto.createHash('sha256');
        const buf = Buffer.allocUnsafe(CHUNK);
        let pos = 0;
        for (;;) {
          throwIfAborted();
          const { bytesRead } = await h.read(buf, 0, buf.length, pos);
          if (bytesRead === 0) break;
          hash.update(buf.subarray(0, bytesRead));
          pos += bytesRead;
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
          resultado: 'cancelada',
          motivo: fatal ? `Se detuvo toda la operación: ${fatal.message}` : 'Cancelada por el usuario antes de empezar esta carpeta',
          manifest: { origen: folder.source, destino: folder.destParts.join('/'), resultado: 'cancelada', archivos: [], carpetasVacias: [], errores: [], original: { accion: 'sin-tocar', motivo: 'la operación no llegó a esta carpeta' } },
        });
        continue;
      }
      const destBase = nodePath.join(batchFolder, ...folder.destParts);
      const ctx = { origen: folder.source, index: folder.index, bytes: 0, files: 0, totalBytes: folder.bytes, totalFiles: folder.files };
      const errores = [];
      const archivos = [];
      const fileHashes = new Map();
      const result = {
        origen: folder.source,
        destino: destBase,
        resultado: 'copiada-verificada',
        motivo: null,
        verificada: false,
        verificacion: plan.verify,
        errores,
      };
      const man = {
        origen: folder.source,
        destino: folder.destParts.join('/'),
        resultado: null,
        archivos,
        carpetasVacias: [],
        enlacesOmitidos: folder.links.map((l) => l.ruta),
        ilegibles: folder.unreadable,
        especiales: folder.special.map((x) => x.ruta),
        errores,
        original: { accion: 'sin-tocar', motivo: null },
      };
      result.manifest = man;
      const addError = (rel, err, fallback) => {
        const c = err && err.custom ? { message: err.message, code: err.code } : classify(err, err && err.side);
        errores.push({ ruta: rel, codigo: c.code, mensaje: fallback || c.message });
        return c;
      };

      try {
        // Contenedor y carpetas.
        throwIfAborted();
        for (let i = 1; i <= folder.destParts.length; i++) {
          const p = nodePath.join(batchFolder, ...folder.destParts.slice(0, i));
          if (created.some((c) => c.path === p)) continue;
          try {
            await fsp.mkdir(p);
            created.push({ path: p, type: 'dir' });
          } catch (err) {
            throw Object.assign(err, { side: 'dest' });
          }
        }
        const dirEntries = folder.entries.filter((e) => e.type === 'dir');
        for (const d of dirEntries) {
          throwIfAborted();
          const p = relToPath(destBase, d.rel);
          try {
            await fsp.mkdir(p);
            created.push({ path: p, type: 'dir' });
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
          const destPath = relToPath(destBase, e.rel);
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
            ctx.files++;
            overallFiles++;
          }
        }

        // Verificación.
        if (errores.length === 0) {
          for (const e of fileEntries) {
            throwIfAborted();
            const destPath = relToPath(destBase, e.rel);
            const srcRec = archivos.find((a) => a.ruta === e.rel);
            emit({ fase: 'verificando', carpeta: folder.source, carpetaIndice: folder.index, archivo: destPath, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles });
            try {
              const st = await fsp.lstat(destPath);
              if (!st.isFile() || st.size !== e.size) {
                errores.push({ ruta: e.rel, codigo: 'TAMANO', mensaje: `El tamaño en el destino (${st.size}) no coincide con el original (${e.size})` });
                continue;
              }
              if (plan.verify === 'full') {
                const { sha, bytes } = await hashFile(destPath);
                overallBytes += bytes;
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

        // Carpetas: fechas (de las hojas hacia la raíz) y comparación de contenido del destino con el plan.
        for (const d of [...dirEntries].sort((a, b) => b.rel.split('/').length - a.rel.split('/').length)) {
          try {
            await fsp.utimes(relToPath(destBase, d.rel), d.mtimeMs / 1000, d.mtimeMs / 1000);
          } catch {
            /* la fecha de una carpeta no es crítica */
          }
        }
        try {
          await fsp.utimes(destBase, folder.mtimeMs / 1000, folder.mtimeMs / 1000);
        } catch {
          /* idem */
        }
        {
          const live = await walk(destBase, { checkProtected: false });
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
        man.carpetasVacias = folder.entries.filter((e) => e.type === 'dir').map((e) => e.rel);

        if (errores.length > 0) {
          result.resultado = 'con-errores';
          result.motivo = `${errores.length} problema(s): el original no se toca`;
        } else {
          result.verificada = true;
        }
      } catch (err) {
        if (err instanceof AbortedError) {
          cancelled = true;
          result.resultado = 'cancelada';
          result.motivo = 'Cancelada por el usuario';
        } else {
          const c = err && err.fatalInfo ? err.fatalInfo : classify(err, err && err.side);
          if (c.fatal) {
            fatal = { message: c.message, code: c.code };
            result.resultado = 'con-errores';
            result.motivo = `Se detuvo toda la operación: ${c.message}`;
            errores.push({ ruta: '', codigo: c.code, mensaje: c.message });
          } else {
            result.resultado = 'con-errores';
            result.motivo = c.message;
            errores.push({ ruta: '', codigo: c.code, mensaje: c.message });
          }
        }
      }

      // ---- retirar el original (solo modo "mover", solo tras verificar TODO)
      man.original = { accion: 'sin-tocar', motivo: result.resultado === 'copiada-verificada' ? 'copiar no retira nada' : 'la copia no quedó verificada' };
      if (plan.mode === 'move' && result.resultado === 'copiada-verificada' && result.verificada) {
        emit({ fase: 'retirando original', carpeta: folder.source, carpetaIndice: folder.index, archivo: folder.source, bytesDone: ctx.bytes, bytesTotal: ctx.totalBytes, filesDone: ctx.files, filesTotal: ctx.totalFiles }, true);
        const keep = (motivo) => {
          result.resultado = 'original-sin-tocar';
          result.motivo = motivo;
          man.original = { accion: 'sin-tocar', motivo };
        };
        if (plan.disposal === 'ninguna') {
          keep('Pedido: dejar el original donde está');
        } else if (signal && signal.aborted) {
          cancelled = true;
          keep('Cancelada antes de retirar el original');
        } else if (isProtected(folder.source)) {
          keep('La carpeta está protegida por el sistema (se volvió a comprobar antes de retirarla)');
        } else if (folder.links.length || folder.unreadable.length || folder.special.length) {
          keep('Contiene enlaces o elementos que no se copiaron: se deja el original para no perderlos');
        } else {
          if (hooks.afterVerify) await hooks.afterVerify({ folder }); // solo pruebas
          // El origen debe seguir EXACTAMENTE como se planificó.
          let changed = null;
          try {
            const again = await walk(folder.source, { checkProtected: false });
            if (again.links.length || again.unreadable.length || again.special.length) changed = 'aparecieron enlaces o elementos ilegibles';
            else if (again.entries.length !== folder.entries.length) changed = 'cambió la cantidad de archivos o carpetas';
            else {
              for (let i = 0; i < again.entries.length; i++) {
                const a = again.entries[i];
                const b = folder.entries[i];
                if (a.rel !== b.rel || a.type !== b.type || a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
                  changed = `cambió «${a.rel}»`;
                  break;
                }
              }
            }
          } catch (err) {
            changed = `no se pudo volver a leer el origen (${err.code || err.message})`;
          }
          if (changed) {
            keep(`El origen cambió desde que se planificó (${changed}): no se toca`);
          } else {
            try {
              if (plan.disposal === 'papelera') {
                if (typeof trash !== 'function') throw new Error('No hay función de Papelera');
                await disposeOriginal('papelera', folder.source);
                const stillThere = await fsp.lstat(folder.source).then(() => true, () => false);
                if (stillThere) keep('La Papelera no retiró la carpeta: el original sigue donde estaba');
                else {
                  result.resultado = 'original-enviado-a-papelera';
                  man.original = { accion: 'papelera', motivo: null };
                }
              } else {
                const qRoot = await volumeRoot(folder.source);
                const { parts } = splitAbsolute(folder.source);
                const qBatch = nodePath.join(qRoot, QUARANTINE_DIR, unique);
                const qDest = nodePath.join(qBatch, ...parts);
                const exists = await fsp.lstat(qDest).then(() => true, () => false);
                if (exists) throw new Error('Ya existe algo en la cuarentena con esa ruta');
                await fsp.mkdir(nodePath.dirname(qDest), { recursive: true });
                const leemeQ = nodePath.join(qBatch, 'LEEME.txt');
                const hasLeeme = await fsp.lstat(leemeQ).then(() => true, () => false);
                if (!hasLeeme) await fsp.writeFile(leemeQ, leemeQuarantine({ fecha: stamp, lote: unique }), { flag: 'wx' });
                await disposeOriginal('cuarentena', folder.source, qDest);
                result.resultado = 'original-en-cuarentena';
                man.original = { accion: 'cuarentena', destino: qDest, motivo: null };
              }
            } catch (err) {
              keep(`No se pudo retirar el original (${(err && err.message) || err}): sigue donde estaba`);
            }
          }
        }
      }
      man.resultado = result.resultado;
      results.push(result);
      try {
        await saveProgress();
      } catch (err) {
        fatal = fatal || { message: err.message, code: err.code };
      }
    }

    // ---- cierre
    const anyError = results.some((r) => r.resultado === 'con-errores');
    estado.estado = cancelled ? 'cancelado' : fatal || anyError ? 'con-errores' : 'completo';
    estado.fin = new Date(now()).toISOString();
    if (fatal) estado.abortada = fatal;
    try {
      await saveProgress();
    } catch {
      /* el resultado en memoria sigue siendo válido */
    }
    emit({ fase: 'terminado', bytesDone: overallBytes, bytesTotal: totalBytes, filesDone: overallFiles, filesTotal: totalFiles }, true);

    return {
      estado: estado.estado,
      abortada: fatal,
      verificacion: plan.verify,
      avisoVerificacion: plan.verify === 'quick' ? 'Verificación RÁPIDA: solo comprueba tamaño y fecha, NO el contenido.' : null,
      batchFolder,
      lote: unique,
      carpetas: results.map(({ manifest: _m, ...rest }) => rest),
      created,
      totales: { archivos: overallFiles, bytes: totalBytes },
    };
  }

  // -------------------------------------------------------------- quitarCopiado

  /**
   * Quita SOLO lo que esta operación creó (lista registrada) y solo dentro de su carpeta de lote.
   * Se niega si algún original ya se retiró: en ese caso la copia es lo único que queda.
   */
  async function quitarCopiado(resultado) {
    if (!resultado || typeof resultado.batchFolder !== 'string' || !Array.isArray(resultado.created)) throw new Error('Resultado no válido');
    const disposed = (resultado.carpetas || []).filter((c) => c.resultado === 'original-enviado-a-papelera' || c.resultado === 'original-en-cuarentena');
    if (disposed.length) throw new Error('No se puede quitar la copia: ya se retiró algún original y la copia es lo único que queda');
    const batch = resultado.batchFolder;
    const report = { quitados: 0, omitidos: [] };
    const entries = resultado.created.filter((c) => c && typeof c.path === 'string' && !c.shared && c.path !== batch);
    // Archivos primero; carpetas de la más profunda a la más superficial.
    const files = entries.filter((c) => c.type === 'file');
    const dirs = entries.filter((c) => c.type === 'dir').sort((a, b) => b.path.length - a.path.length);
    for (const e of [...files, ...dirs, { path: batch, type: 'dir' }]) {
      const r = await removeCreatedEntry(e, batch === e.path ? nodePath.dirname(batch) : batch);
      if (r === 'quitado') report.quitados++;
      else report.omitidos.push({ ruta: e.path, motivo: r });
    }
    return report;
  }

  // ----------------------------------------------------------------- verifyBatch

  /** Vuelve a comprobar un lote ya copiado, leyendo MANIFIESTO.json. */
  async function verifyBatch(batchFolder, { mode = 'full', onProgress, signal } = {}) {
    if (typeof batchFolder !== 'string' || !R.normalizePath(batchFolder)) throw new Error('Carpeta de lote no válida');
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(nodePath.join(batchFolder, 'MANIFIESTO.json'), 'utf8'));
    } catch (err) {
      throw new Error(`No se pudo leer MANIFIESTO.json (${err.code || err.message})`);
    }
    if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.carpetas)) throw new Error('MANIFIESTO.json no tiene el formato esperado');
    const fsName = manifest.sistemaDeArchivos || 'desconocido';
    const problems = [];
    let checked = 0;
    let bytesChecked = 0;
    const totalFiles = manifest.carpetas.reduce((s, c) => s + (c.archivos ? c.archivos.length : 0), 0);
    const safeRel = (rel) => typeof rel === 'string' && rel !== '' && !rel.split('/').some((p) => p === '..' || p === '' || p === '.') && !/^[A-Za-z]:|^[\\/]/.test(rel) && !rel.includes('\\') && !rel.includes('\0');
    for (const carpeta of manifest.carpetas) {
      if (!carpeta.archivos || carpeta.resultado === 'cancelada') continue;
      const parts = typeof carpeta.destino === 'string' ? carpeta.destino.split('/') : [];
      if (parts.length === 0 || parts.some((p) => p === '..' || p === '' || p === '.' || /^[A-Za-z]:$/.test(p) || p.includes('\\') || p.includes('\0'))) {
        problems.push({ ruta: String(carpeta.destino), problema: 'ruta-no-valida' });
        continue;
      }
      const base = nodePath.join(batchFolder, ...parts);
      const expected = new Set();
      for (const a of carpeta.archivos) {
        if (signal && signal.aborted) throw new AbortedError();
        if (!safeRel(a.ruta)) {
          problems.push({ ruta: String(a.ruta), problema: 'ruta-no-valida' });
          continue;
        }
        expected.add(a.ruta);
        const p = relToPath(base, a.ruta);
        checked++;
        try {
          const st = await fsp.lstat(p);
          if (!st.isFile()) problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: 'no-es-archivo' });
          else if (st.size !== a.tamano) problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: 'tamano', esperado: a.tamano, encontrado: st.size });
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
              }
              bytesChecked += pos;
              if (hash.digest('hex') !== a.sha256) problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: 'huella' });
            } finally {
              await h.close().catch(() => {});
            }
          } else if (!R.mtimeClose(st.mtimeMs, a.mtimeMs, fsName)) {
            problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: 'fecha' });
          } else if (mode === 'full' && !a.sha256) {
            problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: 'sin-huella-en-el-manifiesto', aviso: true });
          }
        } catch (err) {
          if (err instanceof AbortedError) throw err;
          problems.push({ ruta: `${carpeta.destino}/${a.ruta}`, problema: err.code === 'ENOENT' ? 'falta' : `error-${err.code || 'desconocido'}` });
        }
        if (onProgress) onProgress({ fase: 'verificando', filesDone: checked, filesTotal: totalFiles, bytesDone: bytesChecked, archivo: p });
      }
      // Sobrantes dentro de la carpeta.
      try {
        const live = await walk(base, { checkProtected: false });
        for (const e of live.entries) if (e.type === 'file' && !expected.has(e.rel)) problems.push({ ruta: `${carpeta.destino}/${e.rel}`, problema: 'sobrante' });
      } catch {
        /* si no se puede leer la carpeta, ya se informó cada archivo como faltante */
      }
    }
    const real = problems.filter((p) => !p.aviso);
    return { ok: real.length === 0, verificados: checked, problemas: problems, modo: mode };
  }

  return { preflight, run, quitarCopiado, verifyBatch, walk };
}

module.exports = { createTransferEngine, batchName, splitAbsolute, FatalTransferError, AbortedError, BATCH_DIR, QUARANTINE_DIR, MAX_SOURCES, SIDE_FILES };
