'use strict';

/**
 * Configuración del usuario (settings.json en la carpeta de datos de la app).
 *
 * Todo es validación pura + lectura/escritura de un archivo, sin Electron,
 * para probarlo con `node --test`. Reglas:
 *  - Esquema fijo (ver DEFAULTS). Los cambios llegan como "parche" parcial y se
 *    validan por completo antes de guardar; una clave desconocida se rechaza.
 *  - Escritura atómica: se escribe un archivo temporal y se renombra, así un
 *    corte a mitad no deja el archivo a medias.
 *  - Si el archivo falta, está corrupto o es de una versión desconocida, se
 *    usan los valores por defecto sin romper nada. Un campo suelto inválido
 *    vuelve a su valor por defecto y el resto se conserva.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ValidationError, validateAbsolutePath } = require('./validate');

const VERSION = 1;
const MAX_EXCLUDED = 500;
const MAX_BYTES = 10 * 1024 ** 4; // 10 TB

const DEFAULTS = Object.freeze({
  version: VERSION,
  staleDays: 90,
  minSizeBytes: 500 * 1024 * 1024, // 500 MB
  useAccessTime: false,
  useCreationTime: true,
  excludedPaths: Object.freeze([]),
});

const FIELDS = {
  staleDays: (v) => {
    if (!Number.isInteger(v) || v < 7 || v > 3650) throw new ValidationError('staleDays debe ser un entero entre 7 y 3650');
    return v;
  },
  minSizeBytes: (v) => {
    if (!Number.isInteger(v) || v < 0 || v > MAX_BYTES) throw new ValidationError('minSizeBytes debe ser un entero entre 0 y 10 TB');
    return v;
  },
  useAccessTime: (v) => {
    if (typeof v !== 'boolean') throw new ValidationError('useAccessTime debe ser verdadero o falso');
    return v;
  },
  useCreationTime: (v) => {
    if (typeof v !== 'boolean') throw new ValidationError('useCreationTime debe ser verdadero o falso');
    return v;
  },
  excludedPaths: (v) => {
    if (!Array.isArray(v) || v.length > MAX_EXCLUDED) throw new ValidationError(`excludedPaths debe ser una lista de hasta ${MAX_EXCLUDED} rutas`);
    const seen = new Set();
    const out = [];
    for (const p of v) {
      validateAbsolutePath(p);
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  },
};

function defaults() {
  return { ...DEFAULTS, excludedPaths: [] };
}

/** Valida un parche parcial. Devuelve solo los campos permitidos y normalizados. */
function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('La configuración debe ser un objeto');
  const out = {};
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(FIELDS, key)) throw new ValidationError(`Opción de configuración desconocida: ${key}`);
    out[key] = FIELDS[key](patch[key]);
  }
  return out;
}

/** Convierte lo leído del disco en una configuración válida (nunca lanza). */
function normalizeLoaded(raw) {
  const result = defaults();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== VERSION) return result;
  for (const key of Object.keys(FIELDS)) {
    if (!(key in raw)) continue;
    try {
      result[key] = FIELDS[key](raw[key]);
    } catch {
      /* campo inválido: se queda el valor por defecto */
    }
  }
  return result;
}

class SettingsStore {
  /** @param {string} file Ruta completa de settings.json */
  constructor(file) {
    this.file = file;
    this.current = this._read();
  }

  _read() {
    try {
      return normalizeLoaded(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return defaults();
    }
  }

  get() {
    return { ...this.current, excludedPaths: [...this.current.excludedPaths] };
  }

  /** Aplica un parche validado y lo guarda de forma atómica. Devuelve la configuración nueva. */
  update(patch) {
    const next = { ...this.current, ...validatePatch(patch) };
    this._write(next);
    this.current = next;
    return this.get();
  }

  _write(settings) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ya no está */
      }
      throw err;
    }
  }
}

module.exports = { DEFAULTS, VERSION, MAX_EXCLUDED, defaults, validatePatch, normalizeLoaded, SettingsStore };
