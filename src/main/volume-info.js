'use strict';

/**
 * Información de volúmenes con el sistema (Windows: PowerShell).
 *
 * ÚNICO módulo del proyecto autorizado a usar child_process (excepción acotada):
 *  - solo `execFile` (nunca una shell);
 *  - ruta ABSOLUTA a powershell.exe;
 *  - argumentos fijos; lo único variable es una letra de unidad ya validada (/^[A-Z]$/);
 *  - windowsHide, tiempo máximo de 8 s y salida validada estrictamente (volume.js).
 * Si algo falla, devuelve "desconocido" y respalda el espacio libre con fs.statfs.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { parseVolumeJson, validateDriveLetter, unknownVolume } = require('../core/volume');

const TIMEOUT_MS = 8000;

function powershellPath(env = process.env) {
  const root = typeof env.SystemRoot === 'string' && path.win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : 'C:\\Windows';
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Comando exacto que se ejecuta para una letra (ya validada). Exportado para poder probarlo. */
function buildCommand(letter, env = process.env) {
  validateDriveLetter(letter);
  return {
    file: powershellPath(env),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-Volume -DriveLetter ${letter} | Select-Object DriveType,FileSystem,Size,SizeRemaining | ConvertTo-Json -Compress`,
    ],
  };
}

/** Ejecución real: execFile, sin shell, oculta y con tiempo máximo. */
function defaultRun(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, shell: false, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout });
    });
  });
}

/** Respaldo: tamaño y espacio libre con fs.statfs (sin tipo de unidad ni formato). */
async function statfsInfo(root, statfs = fs.promises.statfs) {
  const info = unknownVolume();
  try {
    if (typeof statfs !== 'function') return info;
    const s = await statfs(root);
    const bsize = Number(s.bsize);
    info.freeBytes = Number(s.bavail) * bsize;
    info.sizeBytes = Number(s.blocks) * bsize;
    if (!Number.isFinite(info.freeBytes) || !Number.isFinite(info.sizeBytes)) return unknownVolume();
  } catch {
    return unknownVolume();
  }
  return info;
}

/**
 * @param {string} letter Letra de unidad (A–Z, mayúscula). Se valida ANTES de ejecutar nada.
 * @param {object} [options]
 * @param {(file: string, args: string[]) => Promise<{stdout: string}>} [options.run]
 * @param {string} [options.platform]
 * @param {Function} [options.statfs]
 * @param {string} [options.rootPath] Carpeta raíz para el respaldo con statfs.
 */
async function getVolumeInfo(letter, { run = defaultRun, platform = process.platform, statfs, rootPath, env } = {}) {
  validateDriveLetter(letter);
  const root = rootPath || `${letter}:\\`;
  if (platform !== 'win32') return rootPath ? statfsInfo(root, statfs) : unknownVolume();

  const { file, args } = buildCommand(letter, env);
  let parsed = unknownVolume();
  try {
    const out = await run(file, args);
    parsed = parseVolumeJson(out && out.stdout);
  } catch {
    parsed = unknownVolume();
  }
  if (parsed.freeBytes === null || parsed.sizeBytes === null) {
    const backup = await statfsInfo(root, statfs);
    if (parsed.freeBytes === null) parsed.freeBytes = backup.freeBytes;
    if (parsed.sizeBytes === null) parsed.sizeBytes = backup.sizeBytes;
  }
  return parsed;
}

/** Información del volumen que contiene una ruta (letra de Windows; en otros sistemas, solo statfs). */
async function volumeInfoForPath(p, options = {}) {
  const m = /^([A-Za-z]):[\\/]/.exec(String(p));
  if ((options.platform || process.platform) === 'win32' && m) return getVolumeInfo(m[1].toUpperCase(), options);
  return statfsInfo(p, options.statfs);
}

module.exports = { getVolumeInfo, volumeInfoForPath, buildCommand, powershellPath, TIMEOUT_MS };
