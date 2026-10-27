'use strict';

/**
 * Información de un volumen (disco/unidad): parte PURA, sin acceso al sistema.
 * Interpreta la salida de PowerShell (`Get-Volume ... | ConvertTo-Json -Compress`) y valida la
 * letra de unidad. Todo lo raro se traduce a "desconocido": nunca lanza al interpretar.
 */

const MAX_TEXT = 4096;
const EXPECTED_KEYS = ['DriveType', 'FileSystem', 'Size', 'SizeRemaining'];

function unknownVolume() {
  return { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null };
}

/** Una sola letra MAYÚSCULA A–Z. Lanza TypeError si no lo es (antes de ejecutar nada). */
function validateDriveLetter(letter) {
  if (typeof letter !== 'string' || !/^[A-Z]$/.test(letter)) {
    throw new TypeError('La unidad debe ser una sola letra mayúscula (A–Z)');
  }
  return letter;
}

const DRIVE_TYPE_BY_NUMBER = { 2: 'removable', 3: 'fixed', 4: 'network', 5: 'cdrom' };
const DRIVE_TYPE_BY_NAME = { removable: 'removable', fixed: 'fixed', remote: 'network', network: 'network', 'cd-rom': 'cdrom', cdrom: 'cdrom' };

function mapDriveType(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return DRIVE_TYPE_BY_NUMBER[v] || 'unknown';
  if (typeof v === 'string') return DRIVE_TYPE_BY_NAME[v.trim().toLowerCase()] || 'unknown';
  return 'unknown';
}

function mapFileSystem(v) {
  if (typeof v !== 'string') return 'desconocido';
  const t = v.trim().toLowerCase();
  if (t === '') return 'desconocido';
  if (t === 'ntfs') return 'NTFS';
  if (t === 'exfat') return 'exFAT';
  if (t === 'fat32') return 'FAT32';
  if (t === 'fat') return 'FAT';
  if (t === 'refs') return 'ReFS';
  return 'otro';
}

function mapBytes(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? Math.floor(v) : null;
}

/**
 * @param {string} text Salida de PowerShell.
 * @returns {{driveType: string, fileSystem: string, sizeBytes: number|null, freeBytes: number|null}}
 */
function parseVolumeJson(text) {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT) return unknownVolume();
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return unknownVolume();
    const keys = Object.keys(data);
    // Solo el JSON esperado: cualquier clave extra (o faltante) se trata como salida inválida.
    if (keys.length !== EXPECTED_KEYS.length || !EXPECTED_KEYS.every((k) => keys.includes(k))) return unknownVolume();
    return {
      driveType: mapDriveType(data.DriveType),
      fileSystem: mapFileSystem(data.FileSystem),
      sizeBytes: mapBytes(data.Size),
      freeBytes: mapBytes(data.SizeRemaining),
    };
  } catch {
    return unknownVolume();
  }
}

module.exports = { parseVolumeJson, validateDriveLetter, unknownVolume, EXPECTED_KEYS };
