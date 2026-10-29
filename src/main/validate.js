'use strict';

/**
 * Validación de los mensajes que llegan de la interfaz (IPC).
 * Lógica PURA: sin Electron ni disco, para probarla con `node --test`.
 * Regla: la interfaz no es de confianza; todo se revisa en el proceso principal.
 */

const path = require('node:path');

const MAX_COUNT = 1000;
const MAX_PATH_LENGTH = 32767; // máximo de Windows
const CHANNELS = Object.freeze({
  chooseFolder: 'byd:choose-folder',
  startScan: 'byd:start-scan',
  cancelScan: 'byd:cancel-scan',
  getSettings: 'byd:get-settings',
  saveSettings: 'byd:save-settings',
  staleFolders: 'byd:stale-folders',
  excludePath: 'byd:exclude-path',
  includePath: 'byd:include-path',
  listDrives: 'byd:list-drives',
  chooseDrive: 'byd:choose-drive',
  reveal: 'byd:reveal',
  treemap: 'byd:treemap',
  details: 'byd:details',
  summarizeSelection: 'byd:summarize-selection',
  progress: 'byd:progress',
  // Copiar y transferir (Fase 3B). El destino NUNCA viaja desde la interfaz: sale del diálogo del sistema
  // o de una unidad que el principal detecta, y se guarda en el principal.
  chooseDestination: 'byd:choose-destination',
  chooseDestinationDrive: 'byd:choose-destination-drive',
  listDestinationDrives: 'byd:list-destination-drives',
  transferPreflight: 'byd:transfer-preflight',
  transferRun: 'byd:transfer-run',
  transferCancel: 'byd:transfer-cancel',
  transferProgress: 'byd:transfer-progress',
  transferDeleteFromResult: 'byd:transfer-delete-from-result',
  transferRemoveCopy: 'byd:transfer-remove-copy',
  // Copias anteriores: el registro vive en el PC; la interfaz solo manda el id de una copia (16 hex), nunca una ruta.
  copiesList: 'byd:copies-list',
  copiesVerify: 'byd:copies-verify',
  copiesRemove: 'byd:copies-remove',
  pendingList: 'byd:pending-list',
  pendingClean: 'byd:pending-clean',
  // Datos de prueba (Fase 4): la ruta (Documentos\\BoneYardDog-Prueba) la fija SOLO el proceso principal.
  testDataStatus: 'byd:test-data-status',
  testDataCreate: 'byd:test-data-create',
  testDataCancel: 'byd:test-data-cancel',
  testDataDelete: 'byd:test-data-delete',
  testDataUse: 'byd:test-data-use',
  testDataProgress: 'byd:test-data-progress',
  appInfo: 'byd:app-info',
});

const MAX_TRANSFER_SOURCES = 500;
const TRANSFER_KEYS = ['mode', 'verify', 'disposal', 'confirmPermanentDelete', 'sources'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Entero entre 1 y max (por defecto 1000). */
function validateCount(n, max = MAX_COUNT) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`La cantidad debe ser un entero entre 1 y ${max}`);
  }
  return n;
}

/**
 * Ruta absoluta como texto: sin caracteres nulos, de largo razonable y
 * absoluta ("C:\\..." en Windows, "/..." en otros sistemas). Rechaza rutas
 * relativas y rutas "con partes ..".
 */
function validateAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) throw new ValidationError('La ruta debe ser un texto no vacío');
  if (p.length > MAX_PATH_LENGTH) throw new ValidationError('La ruta es demasiado larga');
  if (p.includes('\0')) throw new ValidationError('La ruta contiene caracteres nulos');
  if (!path.isAbsolute(p)) throw new ValidationError('La ruta debe ser absoluta');
  if (p.split(/[\\/]+/).includes('..')) throw new ValidationError('La ruta no puede contener ".."');
  return p;
}

/** Opciones del mapa: solo minBytes (0–10 TB) y maxCells (10–200); todo opcional. */
function validateTreemapOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new ValidationError('Las opciones del mapa deben ser un objeto');
  const out = {};
  for (const key of Object.keys(options)) {
    if (key === 'minBytes') {
      const v = options.minBytes;
      if (!Number.isInteger(v) || v < 0 || v > 10 * 1024 ** 4) throw new ValidationError('minBytes debe ser un entero entre 0 y 10 TB');
      out.minBytes = v;
    } else if (key === 'maxCells') {
      const v = options.maxCells;
      if (!Number.isInteger(v) || v < 10 || v > 200) throw new ValidationError('maxCells debe ser un entero entre 10 y 200');
      out.maxCells = v;
    } else {
      throw new ValidationError(`Opción del mapa desconocida: ${key}`);
    }
  }
  return out;
}

/** Lista de rutas absolutas (hasta `max`). Las repetidas no se quitan: el servicio las informa. */
function validatePathList(list, max = 500) {
  if (!Array.isArray(list) || list.length > max) throw new ValidationError(`Debe ser una lista de hasta ${max} rutas`);
  for (const p of list) validateAbsolutePath(p);
  return list;
}

/** Una sola letra de unidad (A–Z). Devuelve la letra en mayúscula. */
function validateDriveLetter(l) {
  if (typeof l !== 'string' || !/^[A-Za-z]$/.test(l)) throw new ValidationError('La unidad debe ser una sola letra (A–Z)');
  return l.toUpperCase();
}

// ------------------------------------------------------------------ copiar y transferir

/**
 * Ruta de DESTINO que el principal recibió del diálogo del sistema (nunca de la interfaz):
 * absoluta, sin \0 ni "..", y local. Las rutas de red (\\servidor\recurso) no se admiten como destino;
 * en Windows tiene que empezar por una letra de unidad.
 */
function validateDestinationPath(p, { platform = process.platform } = {}) {
  if (typeof p !== 'string' || p.length === 0) throw new ValidationError('La ruta debe ser un texto no vacío');
  if (p.length > MAX_PATH_LENGTH) throw new ValidationError('La ruta es demasiado larga');
  if (p.includes('\0')) throw new ValidationError('La ruta contiene caracteres nulos');
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(p)) throw new ValidationError('La ruta debe ser absoluta');
  if (p.split(/[\\/]+/).includes('..')) throw new ValidationError('La ruta no puede contener ".."');
  if (/^[\\/]{2}/.test(p) && !/^[\\/]{2}[?.][\\/][A-Za-z]:[\\/]/.test(p)) throw new ValidationError('No se admiten rutas de red como destino: elige una unidad con letra');
  if (platform === 'win32' && !/^(?:[\\/]{2}[?.][\\/])?[A-Za-z]:[\\/]/.test(p)) throw new ValidationError('El destino debe estar en una unidad con letra (por ejemplo D:\\)');
  return p;
}

/** Identificador de plan o de resultado: 16 caracteres hexadecimales que generó el servicio. */
function validateOpaqueId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new ValidationError('Identificador no válido');
  return id;
}

/** Lista de posiciones (enteros >= 0, sin repetir). El límite superior real lo comprueba el servicio con el resultado. */
function validateIndexList(list, max = MAX_TRANSFER_SOURCES) {
  if (!Array.isArray(list) || list.length < 1 || list.length > max) throw new ValidationError(`Debe ser una lista de 1 a ${max} posiciones`);
  const seen = new Set();
  for (const i of list) {
    if (!Number.isInteger(i) || i < 0 || i >= max) throw new ValidationError('Cada posición debe ser un entero entre 0 y ' + (max - 1));
    if (seen.has(i)) throw new ValidationError('Hay posiciones repetidas');
    seen.add(i);
  }
  return list;
}

/** Un booleano de verdad (no "true", ni 1). */
function validateBoolean(b) {
  if (typeof b !== 'boolean') throw new ValidationError('Se esperaba verdadero o falso');
  return b;
}

/**
 * Petición de revisión previa. SIN destino: el principal usa el que el usuario eligió. Solo estas claves.
 * @returns {{mode: string, verify: string, disposal: string, confirmPermanentDelete: boolean, sources: string[]}}
 */
function validateTransferPreflight(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new ValidationError('La petición debe ser un objeto');
  for (const key of Object.keys(options)) if (!TRANSFER_KEYS.includes(key)) throw new ValidationError(`Dato no admitido: ${key}`);
  const { mode, verify = 'full', disposal = 'ninguna', confirmPermanentDelete = false, sources } = options;
  if (mode !== 'copy' && mode !== 'move') throw new ValidationError('El modo debe ser «copy» o «move»');
  if (verify !== 'full' && verify !== 'quick') throw new ValidationError('La verificación debe ser «full» o «quick»');
  if (!['papelera', 'borrar', 'ninguna'].includes(disposal)) throw new ValidationError('Qué hacer con el original: «papelera», «borrar» o «ninguna»');
  validateBoolean(confirmPermanentDelete);
  if (mode === 'copy' && disposal !== 'ninguna') throw new ValidationError('Copiar no retira el original');
  if (mode === 'move' && verify !== 'full') throw new ValidationError('Transferir exige la verificación completa');
  if (confirmPermanentDelete && !(mode === 'move' && disposal === 'borrar')) throw new ValidationError('La confirmación solo vale para el borrado definitivo');
  if (!Array.isArray(sources) || sources.length < 1) throw new ValidationError('Hay que indicar al menos una carpeta');
  validatePathList(sources, MAX_TRANSFER_SOURCES);
  return { mode, verify, disposal, confirmPermanentDelete, sources };
}

/** Borrado definitivo desde un resultado: (runId, posiciones, confirmación explícita). */
function validateDeleteFromResult(runId, indices, confirm) {
  validateOpaqueId(runId);
  validateIndexList(indices);
  if (confirm !== true) throw new ValidationError('Falta la confirmación del borrado definitivo');
  return { runId, indices };
}

/** Opciones de «verificar una copia anterior»: solo { mode: 'full' | 'quick' } (por defecto, completa). */
function validateVerifyOptions(options) {
  if (options === undefined) return { mode: 'full' };
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new ValidationError('Las opciones deben ser un objeto');
  for (const key of Object.keys(options)) if (key !== 'mode') throw new ValidationError(`Dato no admitido: ${key}`);
  const mode = options.mode === undefined ? 'full' : options.mode;
  if (mode !== 'full' && mode !== 'quick') throw new ValidationError('La verificación debe ser «full» o «quick»');
  return { mode };
}

/**
 * Borrar los datos de prueba: { confirm: true, removeCopies?: boolean }. Sin ninguna ruta: el principal sabe
 * cuál es la carpeta. `removeCopies` (por defecto false) pide quitar también las copias de esta sesión.
 */
function validateTestDataDelete(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new ValidationError('Las opciones deben ser un objeto');
  for (const key of Object.keys(options)) if (key !== 'confirm' && key !== 'removeCopies') throw new ValidationError(`Dato no admitido: ${key}`);
  if (options.confirm !== true) throw new ValidationError('Falta la confirmación para borrar los datos de prueba');
  const removeCopies = options.removeCopies === undefined ? false : validateBoolean(options.removeCopies);
  return { confirm: true, removeCopies };
}

/** Los canales que no reciben datos deben llamarse sin argumentos. */
function validateNoArgs(args) {
  if (!Array.isArray(args) || args.length !== 0) throw new ValidationError('Este mensaje no admite argumentos');
}

/**
 * ¿Son la misma página (archivo local)? Ignora #fragmento y ?consulta, la
 * codificación de caracteres (%20) y, en rutas con letra de unidad
 * (file:///C:/...), las mayúsculas, porque Windows no las distingue.
 */
function sameFileUrl(a, b) {
  const normalize = (u) => {
    if (typeof u !== 'string') return null;
    let url;
    try {
      url = new URL(u);
    } catch {
      return null;
    }
    if (url.protocol !== 'file:') return null;
    let p;
    try {
      p = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    return /^\/[a-zA-Z]:\//.test(p) ? p.toLowerCase() : p;
  };
  const x = normalize(a);
  return x !== null && x === normalize(b);
}

/**
 * ¿El mensaje viene de NUESTRA ventana y de NUESTRA página?
 * @param {{senderId:number, frameUrl:string, isMainFrame:boolean}} sender
 * @param {{webContentsId:number, indexUrl:string}} expected
 */
function isTrustedSender(sender, expected) {
  if (!sender || !expected) return false;
  if (sender.senderId !== expected.webContentsId) return false;
  if (sender.isMainFrame !== true) return false;
  return sameFileUrl(sender.frameUrl, expected.indexUrl);
}

module.exports = {
  CHANNELS,
  MAX_COUNT,
  ValidationError,
  validateCount,
  validateAbsolutePath,
  validateDriveLetter,
  validateTreemapOptions,
  validatePathList,
  validateNoArgs,
  MAX_TRANSFER_SOURCES,
  validateDestinationPath,
  validateOpaqueId,
  validateIndexList,
  validateBoolean,
  validateTransferPreflight,
  validateDeleteFromResult,
  validateVerifyOptions,
  validateTestDataDelete,
  isTrustedSender,
  sameFileUrl,
};
