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
  largestFiles: 'byd:largest-files',
  largestFolders: 'byd:largest-folders',
  progress: 'byd:progress',
});

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

/** Los canales que no reciben datos deben llamarse sin argumentos. */
function validateNoArgs(args) {
  if (!Array.isArray(args) || args.length !== 0) throw new ValidationError('Este mensaje no admite argumentos');
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
  if (typeof sender.frameUrl !== 'string') return false;
  const clean = (u) => u.split('#')[0].split('?')[0];
  return clean(sender.frameUrl) === clean(expected.indexUrl);
}

/** ¿La URL es de la propia aplicación (archivo local) y no de la red? */
function isAppUrl(url, indexUrl) {
  return typeof url === 'string' && url.split('#')[0].split('?')[0] === indexUrl.split('#')[0].split('?')[0];
}

module.exports = {
  CHANNELS,
  MAX_COUNT,
  ValidationError,
  validateCount,
  validateAbsolutePath,
  validateNoArgs,
  isTrustedSender,
  isAppUrl,
};
