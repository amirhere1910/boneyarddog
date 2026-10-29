'use strict';

/**
 * Registro de diagnóstico: un archivo de texto (`diagnostico.log`, en la carpeta de datos de la app, NO en el destino) con marcas de
 * tiempo de cada etapa del motor: ruta, tamaño, etapa, cuánto tardó, errores del sistema con su código, velocidad. Sirve para saber
 * por qué una copia se queda esperando (disco, USB, antivirus). NO incluye contenido de archivos; SÍ incluye rutas.
 * Rotación: cuando pasa de `maxBytes` (1 MB), el archivo viejo pasa a `.1` y se empieza otro. Nunca lanza: si no se puede escribir,
 * la copia sigue igual (y se cuenta cuántas líneas se perdieron).
 */

const nodePath = require('node:path');

const MAX_BYTES = 1024 * 1024;
const MAX_LINE = 4000;

function createDiagnostic({ fs = require('node:fs'), file, maxBytes = MAX_BYTES, now = () => Date.now() } = {}) {
  const fsp = fs.promises;
  let size = null; // tamaño conocido del archivo actual
  let lost = 0;
  let queue = Promise.resolve();

  const clean = (v) => {
    if (typeof v === 'string') return v.length > 500 ? `${v.slice(0, 500)}…` : v;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.slice(0, 20).map(clean);
    if (typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, clean(x)]));
    return String(v);
  };

  async function write(line) {
    if (!file) return;
    try {
      if (size === null) size = await fsp.stat(file).then((s) => s.size, () => 0);
      if (size + Buffer.byteLength(line) > maxBytes) {
        await fsp.mkdir(nodePath.dirname(file), { recursive: true });
        await fsp.rename(file, `${file}.1`).catch(() => {});
        size = 0;
      }
      await fsp.mkdir(nodePath.dirname(file), { recursive: true });
      await fsp.appendFile(file, line);
      size += Buffer.byteLength(line);
    } catch {
      lost++;
    }
  }

  /** Anota un evento: `evento` es una palabra corta y `datos` un objeto con números y textos (rutas, códigos…). */
  function log(evento, datos = {}) {
    let text;
    try {
      text = `${new Date(now()).toISOString()} ${String(evento)} ${JSON.stringify(clean(datos))}`;
    } catch {
      text = `${new Date(now()).toISOString()} ${String(evento)} {}`;
    }
    const line = `${text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text}\n`;
    queue = queue.then(() => write(line));
    return queue;
  }

  /** Espera a que se escriba todo lo pendiente (para las pruebas y para cerrar). */
  const flush = () => queue;

  /** Texto completo del registro (el viejo y el actual) para «Guardar registro de diagnóstico…». */
  async function readAll() {
    await flush();
    const parts = [];
    for (const f of [`${file}.1`, file]) {
      try {
        parts.push(await fsp.readFile(f, 'utf8'));
      } catch {
        /* no existe todavía */
      }
    }
    return parts.join('');
  }

  return { log, flush, readAll, lostLines: () => lost, file };
}

module.exports = { createDiagnostic, MAX_BYTES };
