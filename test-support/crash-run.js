'use strict';

// Se usa SOLO desde las pruebas: copia una carpeta y «se cae» (process.exit) después de N archivos, como un cierre
// forzado o un corte de luz. Uso: node crash-run.js <origen> <destino> <N>
const fs = require('node:fs');
const path = require('node:path');
const { createTransferEngine } = require('../src/core/transfer');

const [src, dest, n] = process.argv.slice(2);
const engine = createTransferEngine({ volumeInfo: async () => ({ driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 5e11 }), trash: null, isProtected: () => false, isProtectedDestination: () => false });
(async () => {
  const pf = await engine.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  if (!pf.plan) {
    console.error(JSON.stringify(pf.blockers));
    process.exit(2);
  }
  let seen = 0;
  await engine.run(pf.plan, {
    hooks: {
      beforeFile: () => {
        if (++seen > Number(n)) process.exit(9); // sin limpiar nada: el proceso muere
      },
    },
  });
  fs.writeFileSync(path.join(dest, '..', 'termino-sin-caerse.txt'), 'no debía terminar');
})();
