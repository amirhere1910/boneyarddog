'use strict';
// TEMPORAL: reproduce paso a paso la prueba que tumba el proceso en Windows.
const H = require('../test-support/transfer-helpers');
const { fs, path, makeSource, makeEngine, makeDest } = H;
const os = require('node:os');
const L = (m) => fs.writeSync(2, `[dbg] ${m}\n`);
(async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dbg-'));
  const src = makeSource(base);
  const dest = makeDest(base);
  const otro = path.join(base, 'respaldo-en-otro-sitio');
  const name = path.basename(src);
  const { engine } = makeEngine(base);
  L('preflight');
  const pf = await engine.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'borrar', confirmPermanentDelete: true });
  L(`plan ${Boolean(pf.plan)} ${JSON.stringify(pf.blockers.map((b) => b.code))}`);
  const r = await engine.run(pf.plan, {
    hooks: {
      afterVerify: async () => {
        L('hook: cpSync');
        fs.cpSync(path.join(dest, name), otro, { recursive: true, preserveTimestamps: true });
        L('hook: rmSync');
        fs.rmSync(path.join(dest, name), { recursive: true });
        L('hook: symlink');
        try {
          fs.symlinkSync(otro, path.join(dest, name), 'dir');
          L('hook: symlink ok');
        } catch (e) {
          L(`hook: symlink falla ${e.code}`);
        }
      },
    },
  });
  L(`run listo ${r.carpetas[0].resultado} ${r.carpetas[0].motivoCodigo}`);
})().catch((e) => L(`error ${e && e.stack}`));
