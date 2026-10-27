'use strict';

/**
 * Mide cuánto ocupa el árbol del escáner por nodo.
 * Uso: node --expose-gc scripts/medir-memoria.js [cantidadDeArchivos=50000]
 * Crea los archivos vacíos en una carpeta temporal y la borra al terminar.
 *
 * Reporta:
 *  - memoria viva del árbol (heapUsed antes/después, con recolección de basura)
 *  - tamaño al serializarlo (lo que costaría mandarlo a otro hilo)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v8 = require('node:v8');
const { scan } = require('../src/core/scanner');
const { annotateLastUsed } = require('../src/core/analysis');

async function main() {
  if (typeof global.gc !== 'function') {
    console.error('Ejecútalo con: node --expose-gc scripts/medir-memoria.js');
    process.exit(2);
  }
  const files = Number(process.argv[2]) || 50000;
  const perDir = 100;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-medir-'));
  try {
    for (let d = 0; d < Math.ceil(files / perDir); d++) {
      const dir = path.join(root, `carpeta-${String(d).padStart(4, '0')}`);
      fs.mkdirSync(dir);
      for (let f = 0; f < perDir && d * perDir + f < files; f++) {
        fs.writeFileSync(path.join(dir, `archivo-${String(f).padStart(3, '0')}.dat`), '');
      }
    }
    global.gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const { tree, stats } = await scan(root);
    const scanMs = Date.now() - t0;
    annotateLastUsed(tree);
    global.gc();
    const after = process.memoryUsage().heapUsed;
    const nodes = stats.files + stats.folders;
    const serialized = v8.serialize(tree).length;
    const out = {
      archivos: stats.files,
      carpetas: stats.folders,
      nodos: nodes,
      escaneoMs: scanMs,
      memoriaVivaBytes: after - before,
      bytesPorNodoEnMemoria: Math.round((after - before) / nodes),
      serializadoBytes: serialized,
      bytesPorNodoSerializado: Math.round(serialized / nodes),
    };
    console.log(JSON.stringify(out, null, 2));
    if (!tree) process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main();
