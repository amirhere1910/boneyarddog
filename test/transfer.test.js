'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/transfer-helpers');
const { fs, path, tmpDir, write, sha, snapshot, makeSource, spyFs, makeEngine, makeDest, NTFS_FIXED, DESTRUCTIVE, isInside, DAY } = H;

const copyOpts = (src, dest, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full', ...extra });
const moveOpts = (src, dest, disposal, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal, ...extra });
const codes = (list) => list.map((b) => b.code);
/** Partes de una ruta sin la unidad ("D:" en Windows): así se arma la ruta dentro de la cuarentena. */
const withoutDrive = (p) => p.slice(path.parse(p).root.length).split(path.sep).filter(Boolean);

/** Escritor de destino que altera el primer byte del primer bloque que escribe. */
function corruptingWrites({ only } = {}) {
  let flipped = false;
  return (handle, args) => {
    if (args[1] !== 'wx' || args[0].includes('.byd-sonda') || (only && !only(args[0]))) return handle;
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'write') {
          return async (buf, off, len, pos) => {
            const copy = Buffer.from(buf.subarray(off, off + len));
            if (!flipped && copy.length > 0) {
              copy[0] ^= 0xff;
              flipped = true;
            }
            return target.write(copy, 0, copy.length, pos);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
}

/** Escritor de destino que falla con un código de error en la primera escritura (de un archivo, si se indica). */
function failingWrites(code, { only } = {}) {
  let done = false;
  return (handle, args) => {
    if (args[1] !== 'wx' || args[0].includes('.byd-sonda') || (only && !only(args[0]))) return handle;
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === 'write') {
          return async (...a) => {
            if (!done) {
              done = true;
              throw Object.assign(new Error(`${code}: simulado`), { code });
            }
            return target.write(...a);
          };
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  };
}

// ============================================================================ copia

test('copia feliz: anidadas, tildes, ñ, emoji, 0 bytes, 64 MB, carpetas vacías y fechas conservadas', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base, { big: true });
  const dest = makeDest(base);
  const before = snapshot(src);
  const { fs: sfs, calls } = spyFs();
  const { engine } = makeEngine(base, { fs: sfs });

  const pf = await engine.preflight(copyOpts(src, dest));
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.plan.totals.files, 6);
  assert.equal(pf.plan.totals.bytes, 10 + Buffer.byteLength('acción: ñandú, tildes, emoji 🐕') + 0 + 5000 + 70000 + 64 * 1024 * 1024);

  const events = [];
  const r = await engine.run(pf.plan, { onProgress: (e) => events.push(e), progressIntervalMs: 0 });
  assert.equal(r.estado, 'completo');
  assert.equal(r.carpetas[0].resultado, 'copiada-verificada');
  assert.equal(r.carpetas[0].verificada, true);
  assert.deepEqual(r.carpetas[0].errores, []);

  const copy = r.carpetas[0].destino;
  assert.ok(copy.includes(path.join('BoneYardDog', '2026-10-27_1405')), copy);
  assert.deepEqual(snapshot(copy), before, 'mismos nombres, tamaños y contenido (incluye vacía y 0 bytes)');
  assert.deepEqual(snapshot(src), before, 'el origen no cambió');

  // Fechas de archivos y de carpetas.
  const near = (a, b) => Math.abs(a - b) <= 2;
  for (const rel of Object.keys(before)) {
    const o = fs.statSync(path.join(src, ...rel.split('/'))).mtimeMs;
    const c = fs.statSync(path.join(copy, ...rel.split('/'))).mtimeMs;
    assert.ok(near(o, c), `${rel}: ${o} vs ${c}`);
  }
  assert.ok(near(fs.statSync(src).mtimeMs, fs.statSync(copy).mtimeMs), 'la carpeta raíz también');

  // Progreso por fases.
  const phases = [...new Set(events.map((e) => e.fase))];
  assert.deepEqual(phases, ['copiando', 'verificando', 'terminado']);
  const copying = events.filter((e) => e.fase === 'copiando').map((e) => e.bytesDone);
  assert.ok(copying.every((v, i) => i === 0 || v >= copying[i - 1]), 'el progreso no retrocede');
  const last = events[events.length - 1];
  assert.equal(last.totalFiles, 6);
  assert.equal(last.overallFilesDone, 6);
  assert.ok(events.some((e) => typeof e.bytesPerSecond === 'number'));

  // En modo copiar no se elimina ni renombra NADA del origen (y solo la sonda propia del destino).
  const destructive = calls.filter((c) => DESTRUCTIVE.has(c.name));
  assert.ok(destructive.every((c) => !isInside(String(c.args[0]), src)), JSON.stringify(destructive.map((c) => [c.name, c.args[0]])));
  assert.deepEqual(destructive.map((c) => [c.name, path.basename(c.args[0]).startsWith('.byd-sonda-')]), [['unlink', true]], 'solo se quitó la sonda de escritura');
  assert.ok(fs.readdirSync(dest).every((n) => !n.startsWith('.byd-sonda')), 'la sonda no queda en el destino');
});

test('ESTADO.json, MANIFIESTO.json y LEEME.txt: contenido correcto', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs, calls } = spyFs();
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);

  const estadoWrites = calls.filter((c) => c.name === 'writeFile' && c.args[0].endsWith('ESTADO.json')).map((c) => JSON.parse(c.args[1]).estado);
  assert.equal(estadoWrites[0], 'en-curso', 'se escribe al empezar');
  assert.equal(estadoWrites[estadoWrites.length - 1], 'completo');
  const estado = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'ESTADO.json'), 'utf8'));
  assert.equal(estado.estado, 'completo');
  assert.equal(estado.carpetas[0].resultado, 'copiada-verificada');

  const m = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(m.version, 1);
  assert.equal(m.app.nombre, 'BoneYardDog');
  assert.equal(m.app.version, '0.0.0-prueba');
  assert.equal(m.modo, 'copy');
  assert.equal(m.verificacion, 'full');
  assert.equal(m.avisoVerificacion, null);
  assert.equal(m.lote, '2026-10-27_1405');
  assert.equal(m.sistemaDeArchivos, 'NTFS');
  const c = m.carpetas[0];
  assert.equal(c.origen, src);
  assert.equal(c.resultado, 'copiada-verificada');
  assert.deepEqual(c.original, { accion: 'sin-tocar', motivo: 'copiar no retira nada' });
  assert.deepEqual(c.archivos.map((a) => a.ruta), ['a.txt', 'canción.txt', 'cero.bin', 'sub/hondo/x.bin', 'sub/y.txt']);
  for (const a of c.archivos) {
    const file = path.join(src, ...a.ruta.split('/'));
    assert.equal(a.tamano, fs.statSync(file).size);
    assert.equal(a.sha256, sha(file), a.ruta);
    assert.ok(Math.abs(a.mtimeMs - fs.statSync(file).mtimeMs) < 1);
  }
  assert.deepEqual(c.carpetasVacias.sort(), ['sub', 'sub/hondo', 'vacia']);
  assert.deepEqual(c.errores, []);
  assert.equal(c.destino.startsWith(process.platform === 'win32' ? `${src[0].toUpperCase()}/` : 'raiz/'), true, 'la carpeta de la unidad: su letra en Windows, "raiz" en otros sistemas');

  const leeme = fs.readFileSync(path.join(r.batchFolder, 'LEEME.txt'), 'utf8');
  for (const frase of ['BONEYARDDOG', 'CÓMO RESTAURAR', 'CÓMO VERIFICAR', 'SHA-256', 'MANIFIESTO.json', 'ESTADO.json']) assert.ok(leeme.includes(frase), frase);
});

test('NUNCA sobrescribe: si el archivo ya existe en el destino, es un error de ese archivo y su contenido queda intacto', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    after: (name, args) => {
      // Justo después de crear la carpeta contenedora, aparece un archivo ajeno con el mismo nombre que otro del plan.
      if (name === 'mkdir' && path.basename(args[0]) === path.basename(src)) fs.writeFileSync(path.join(args[0], 'a.txt'), 'NO TOCAR: es del usuario');
    },
  });
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'con-errores');
  assert.ok(c.errores.some((e) => e.ruta === 'a.txt' && e.codigo === 'EEXIST'), JSON.stringify(c.errores));
  assert.equal(fs.readFileSync(path.join(c.destino, 'a.txt'), 'utf8'), 'NO TOCAR: es del usuario', 'su contenido sigue intacto (ni se sobrescribió ni se borró)');
  assert.equal(r.estado, 'con-errores');
});

test('una carpeta de destino que ya existe tampoco se pisa (el lote nuevo toma otro nombre)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  fs.mkdirSync(path.join(dest, 'BoneYardDog', '2026-10-27_1405'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'BoneYardDog', '2026-10-27_1405', 'viejo.txt'), 'lote anterior');
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  assert.equal(r.lote, '2026-10-27_1405-2');
  assert.equal(fs.readFileSync(path.join(dest, 'BoneYardDog', '2026-10-27_1405', 'viejo.txt'), 'utf8'), 'lote anterior');
  assert.equal(r.estado, 'completo');
});

// ================================================================== verificación

test('CORRUPCIÓN: un byte alterado al escribir => la verificación completa falla y el original NO se retira', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { fs: sfs } = spyFs({ wrapHandle: corruptingWrites() });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'con-errores');
  assert.equal(c.verificada, false);
  assert.ok(c.errores.some((e) => e.codigo === 'HUELLA' && e.ruta === 'a.txt'), JSON.stringify(c.errores));
  assert.deepEqual(trashed, [], 'la Papelera no se llamó');
  assert.deepEqual(snapshot(src), before, 'el original está intacto');
  assert.equal(r.estado, 'con-errores');
  const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(man.carpetas[0].original.accion, 'sin-tocar');
});

test('la verificación RÁPIDA no detecta esa corrupción (por eso se rotula así y no permite retirar el original)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  // Después de que la copia termina y se fijan las fechas, se altera un byte conservando tamaño y fecha.
  const flip = (name, args) => {
    if (name === 'utimes' && args[0].includes(`${path.sep}BoneYardDog${path.sep}`) && args[0].endsWith('a.txt')) {
      const st = fs.statSync(args[0]);
      const b = fs.readFileSync(args[0]);
      b[0] ^= 0xff;
      fs.writeFileSync(args[0], b);
      fs.utimesSync(args[0], st.atime, st.mtime);
    }
  };

  const quick = makeEngine(base, { fs: spyFs({ after: flip }).fs });
  const pq = await quick.engine.preflight(copyOpts(src, dest, { verify: 'quick' }));
  const rq = await quick.engine.run(pq.plan);
  assert.equal(rq.carpetas[0].resultado, 'copiada-verificada', 'QUICK no detecta la corrupción (es su límite documentado)');
  assert.match(rq.avisoVerificacion, /NO el contenido/);
  const mq = JSON.parse(fs.readFileSync(path.join(rq.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.match(mq.avisoVerificacion, /RÁPIDA/);
  assert.ok(mq.carpetas[0].archivos.every((a) => a.sha256 === null));
  assert.match(fs.readFileSync(path.join(rq.batchFolder, 'LEEME.txt'), 'utf8'), /NO comprueba el contenido/);
  const vq = await quick.engine.verifyBatch(rq.batchFolder, { mode: 'full' });
  assert.equal(vq.ok, true, 'ni verifyBatch puede detectarla: el manifiesto rápido no tiene huellas');
  assert.ok(vq.problemas.every((p) => p.aviso), 'solo avisa que no hay huellas');

  // Con la verificación completa, la MISMA alteración sí se detecta.
  const dest2 = path.join(base, 'destino2');
  fs.mkdirSync(dest2);
  const full = makeEngine(base, { fs: spyFs({ after: flip }).fs });
  const pf = await full.engine.preflight(copyOpts(src, dest2, { verify: 'full' }));
  const rf = await full.engine.run(pf.plan);
  assert.equal(rf.carpetas[0].resultado, 'con-errores');
  assert.ok(rf.carpetas[0].errores.some((e) => e.codigo === 'HUELLA'));
});

test('quick: detecta tamaño o fecha distintos', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    after: (name, args) => {
      if (name === 'utimes' && args[0].includes(`${path.sep}BoneYardDog${path.sep}`) && args[0].endsWith('a.txt')) fs.appendFileSync(args[0], 'de más');
    },
  });
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(copyOpts(src, dest, { verify: 'quick' }));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'con-errores');
  assert.ok(r.carpetas[0].errores.some((e) => e.codigo === 'TAMANO' && e.ruta === 'a.txt'), JSON.stringify(r.carpetas[0].errores));
});

test('mover exige verificación completa (con la rápida es un impedimento)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera', { verify: 'quick' }));
  assert.ok(codes(pf.blockers).includes('mover-requiere-verificacion-completa'));
  assert.equal(pf.plan, null);
  await assert.rejects(() => engine.run({ version: 1, mode: 'move', verify: 'quick', sources: [], totals: { files: 0, bytes: 0 } }), /verificación completa/);
});

// =============================================================== cambios del origen

test('el origen cambia DURANTE la copia: el archivo falla, no queda a medias y el original no se retira', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  let touched = false;
  const { fs: sfs } = spyFs({
    wrapHandle: (handle, args) => {
      if (args[1] !== 'r' || !args[0].endsWith('y.txt')) return handle;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'read') {
            return async (...a) => {
              const out = await target.read(...a);
              if (!touched) {
                touched = true;
                fs.appendFileSync(args[0], 'AGREGADO mientras se copiaba');
              }
              return out;
            };
          }
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'con-errores');
  assert.ok(c.errores.some((e) => e.ruta === 'sub/y.txt' && e.codigo === 'CAMBIO_DURANTE'), JSON.stringify(c.errores));
  assert.equal(fs.existsSync(path.join(c.destino, 'sub', 'y.txt')), false, 'no se deja una copia a medias');
  assert.deepEqual(trashed, []);
  assert.ok(fs.existsSync(src));
});

test('el origen cambia entre la planificación y la copia: el archivo no se copia', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan, { hooks: { beforeFile: ({ srcPath }) => srcPath.endsWith('a.txt') && fs.appendFileSync(srcPath, ' cambió') } });
  assert.equal(r.carpetas[0].resultado, 'con-errores');
  assert.ok(r.carpetas[0].errores.some((e) => e.codigo === 'CAMBIO_ANTES' && e.ruta === 'a.txt'));
  assert.deepEqual(trashed, []);
});

test('el origen cambia DESPUÉS de copiar y antes de retirar: NO se retira', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan, { hooks: { afterVerify: () => write(path.join(src, 'nuevo-archivo.txt'), 'apareció después') } });
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'original-sin-tocar');
  assert.match(c.motivo, /cambió desde que se planificó/);
  assert.deepEqual(trashed, [], 'la Papelera no se llamó');
  assert.equal(fs.readFileSync(path.join(src, 'nuevo-archivo.txt'), 'utf8'), 'apareció después', 'el original, con lo nuevo, sigue ahí');
  assert.equal(c.verificada, true, 'la copia sí quedó verificada');
});

test('un archivo modificado (misma cantidad de archivos) después de copiar también impide retirar', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan, { hooks: { afterVerify: () => write(path.join(src, 'a.txt'), 'hola mundo!') } });
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.deepEqual(trashed, []);
});

// ================================================================ cancelación y fallos

test('cancelación a mitad: originales intactos, ESTADO "cancelado" y sin restos de archivos a medias', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base, { big: true });
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const controller = new AbortController();
  const r = await engine.run(pf.plan, {
    signal: controller.signal,
    progressIntervalMs: 0,
    onProgress: (e) => {
      if (e.fase === 'copiando' && e.archivo.endsWith('grande.bin') && e.bytesDone > 0) controller.abort();
    },
  });
  assert.equal(r.estado, 'cancelado');
  assert.equal(r.carpetas[0].resultado, 'cancelada');
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
  const estado = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'ESTADO.json'), 'utf8'));
  assert.equal(estado.estado, 'cancelado');
  assert.equal(fs.existsSync(path.join(r.carpetas[0].destino, 'grande.bin')), false, 'el archivo a medias se quitó (lo creó esta operación)');
});

test('cancelar antes de empezar una carpeta la deja "cancelada" y sin tocar', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const controller = new AbortController();
  controller.abort();
  const r = await engine.run(pf.plan, { signal: controller.signal });
  assert.equal(r.estado, 'cancelado');
  assert.equal(r.carpetas[0].resultado, 'cancelada');
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
});

test('disco lleno simulado (ENOSPC): se detiene todo con un mensaje claro y nada se retira', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const second = path.join(base, 'origen2', 'Segunda');
  write(path.join(second, 'z.txt'), 'zeta');
  const before = snapshot(src);
  const { fs: sfs } = spyFs({ wrapHandle: failingWrites('ENOSPC', { only: (p) => p.endsWith('y.txt') }) });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight({ sources: [src, second], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  assert.deepEqual(pf.blockers, []);
  const r = await engine.run(pf.plan);
  assert.equal(r.estado, 'con-errores');
  assert.equal(r.abortada.message, 'Sin espacio en el destino');
  assert.equal(r.carpetas[0].resultado, 'con-errores');
  assert.match(r.carpetas[0].motivo, /Sin espacio en el destino/);
  assert.equal(r.carpetas[1].resultado, 'cancelada', 'las demás carpetas ni se intentan');
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
  assert.ok(fs.existsSync(path.join(second, 'z.txt')));
});

for (const code of ['ENODEV', 'EIO', 'ENXIO', 'UNKNOWN']) {
  test(`el disco desaparece a mitad (${code} al escribir): aborta TODO sin tocar originales`, async (t) => {
    const base = tmpDir(t);
    const src = makeSource(base);
    const dest = makeDest(base);
    const second = path.join(base, 'origen2', 'Segunda');
    write(path.join(second, 'z.txt'), 'zeta');
    const before = snapshot(src);
    const { fs: sfs } = spyFs({ wrapHandle: failingWrites(code) });
    const { engine, trashed } = makeEngine(base, { fs: sfs });
    const pf = await engine.preflight({ sources: [src, second], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
    const r = await engine.run(pf.plan);
    assert.equal(r.estado, 'con-errores');
    assert.ok(r.abortada, 'la operación se marca como abortada');
    assert.match(r.abortada.message, /desconectó|falló/);
    assert.deepEqual(r.carpetas.map((c) => c.resultado), ['con-errores', 'cancelada']);
    assert.deepEqual(trashed, []);
    assert.deepEqual(snapshot(src), before);
    assert.ok(fs.existsSync(path.join(second, 'z.txt')));
  });
}

test('un fallo de lectura de E/S en el ORIGEN (EIO) también aborta toda la operación', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    wrapHandle: (handle, args) => {
      if (args[1] !== 'r') return handle;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'read') return async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
          const v = target[prop];
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  assert.ok(r.abortada);
  assert.deepEqual(trashed, []);
});

test('archivo bloqueado o sin permiso: error de ESE archivo (la carpeta queda "con errores") y no hay reintentos silenciosos', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  let attempts = 0;
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (name === 'open' && args[1] === 'r' && args[0].endsWith('canción.txt')) {
        attempts++;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'con-errores');
  assert.equal(r.abortada, null);
  assert.equal(attempts, 1, 'se intentó UNA vez');
  assert.ok(c.errores.some((e) => e.ruta === 'canción.txt' && e.codigo === 'EACCES' && /Sin permiso para leer/.test(e.mensaje)));
  assert.deepEqual(trashed, []);
  // Lo demás sí se copió.
  assert.ok(fs.existsSync(path.join(c.destino, 'a.txt')));
});

// ==================================================================== preflight

test('preflight: FAT32 con un archivo de 4 GiB o más => impedimento y NO se escribe nada en el destino', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const grande = path.join(src, 'pelicula.mkv');
  fs.writeFileSync(grande, '');
  fs.truncateSync(grande, 4 * 1024 ** 3); // archivo disperso: no ocupa disco
  const dest = makeDest(base);
  const { engine } = makeEngine(base, { volumeInfo: async () => ({ driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 64e9, freeBytes: 60e9 }) });
  const pf = await engine.preflight(copyOpts(src, dest));
  assert.ok(codes(pf.blockers).includes('archivo-demasiado-grande'));
  assert.equal(pf.plan, null, 'sin plan: no se puede ejecutar');
  const b = pf.blockers.find((x) => x.code === 'archivo-demasiado-grande');
  assert.equal(b.archivos[0].ruta, grande);
  assert.match(b.message, /exFAT o NTFS/);
  assert.deepEqual(fs.readdirSync(dest), [], 'no se creó nada en el destino');
  await assert.rejects(() => engine.run(pf.plan), /Plan no válido/);
});

test('preflight: el límite exacto de FAT32 (4 294 967 295 bytes) sí cabe; un byte más no', async (t) => {
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'f');
  fs.mkdirSync(src, { recursive: true });
  const fat32 = { volumeInfo: async () => ({ driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 64e12, freeBytes: 60e12 }) };
  const dest = makeDest(base);
  const { engine } = makeEngine(base, fat32);
  fs.writeFileSync(path.join(src, 'justo.bin'), '');
  fs.truncateSync(path.join(src, 'justo.bin'), 4294967295);
  assert.deepEqual((await engine.preflight(copyOpts(src, dest))).blockers, []);
  fs.truncateSync(path.join(src, 'justo.bin'), 4294967296);
  assert.ok(codes((await engine.preflight(copyOpts(src, dest))).blockers).includes('archivo-demasiado-grande'));
  // exFAT y NTFS no tienen ese límite.
  for (const fileSystem of ['exFAT', 'NTFS']) {
    const e = makeEngine(base, { volumeInfo: async () => ({ driveType: 'fixed', fileSystem, sizeBytes: 64e12, freeBytes: 60e12 }) });
    assert.deepEqual((await e.engine.preflight(copyOpts(src, dest))).blockers, [], fileSystem);
  }
});

test('preflight: formato desconocido con un archivo de 4 GiB o más => aviso (no impedimento)', async (t) => {
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'f');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'x.bin'), '');
  fs.truncateSync(path.join(src, 'x.bin'), 4 * 1024 ** 3);
  const { engine } = makeEngine(base, { volumeInfo: async () => ({ driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: 60e12 }) });
  const pf = await engine.preflight(copyOpts(src, makeDest(base)));
  assert.deepEqual(pf.blockers, []);
  assert.ok(codes(pf.warnings).includes('archivo-de-4gb-o-mas'));
  assert.ok(codes(pf.warnings).includes('formato-desconocido'));
});

test('preflight: espacio libre menor que lo copiado más el margen => impedimento (borde exacto incluido)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const probe = await makeEngine(base).engine.preflight(copyOpts(src, dest));
  const bytes = probe.plan.totals.bytes;
  const required = bytes + 64 * 1024 * 1024;
  const withFree = (freeBytes) => makeEngine(base, { volumeInfo: async () => ({ ...NTFS_FIXED, freeBytes }) }).engine.preflight(copyOpts(src, dest));
  assert.deepEqual((await withFree(required)).blockers, [], 'justo el margen: alcanza');
  const short = await withFree(required - 1);
  assert.ok(codes(short.blockers).includes('sin-espacio'));
  const b = short.blockers.find((x) => x.code === 'sin-espacio');
  assert.equal(b.necesarioBytes, required);
  assert.equal(b.libreBytes, required - 1);
  // Espacio desconocido: aviso, no impedimento.
  const unknown = await makeEngine(base, { volumeInfo: async () => ({ ...NTFS_FIXED, freeBytes: null }) }).engine.preflight(copyOpts(src, dest));
  assert.deepEqual(unknown.blockers, []);
  assert.ok(codes(unknown.warnings).includes('espacio-desconocido'));
});

test('preflight: nombres que el destino no admite (reservados, caracteres, espacio/punto final, mayúsculas)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows no deja crear esos nombres de prueba (":" o nombres que solo difieren en mayúsculas); las reglas se prueban en transfer-rules.test.js');
    return;
  }
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'raros');
  write(path.join(src, 'CON.txt'), '1');
  write(path.join(src, 'a:b.txt'), '2');
  write(path.join(src, 'termina '), '3');
  write(path.join(src, 'punto.'), '4');
  write(path.join(src, 'Mayus.txt'), '5');
  write(path.join(src, 'mayus.txt'), '6');
  write(path.join(src, 'bien ñandú 🐕.txt'), '7');
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  assert.ok(codes(pf.blockers).includes('nombres-no-validos'));
  const nombres = pf.blockers.find((b) => b.code === 'nombres-no-validos').nombres.map((n) => n.nombre).sort();
  assert.deepEqual(nombres, ['CON.txt', 'Mayus.txt', 'a:b.txt', 'mayus.txt', 'punto.', 'termina '].sort());
  assert.equal(pf.plan, null);
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('preflight: el destino dentro del origen (o igual a él) se bloquea, también con "..", mayúsculas y barras mixtas', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const { engine } = makeEngine(base);
  const inside = path.join(src, 'sub');
  const variants = [src, inside, path.join(src, 'sub', 'hondo'), path.join(src, 'sub', '..', 'sub'), path.join(src, 'vacia') + path.sep];
  for (const d of variants) {
    const pf = await engine.preflight(copyOpts(src, d));
    assert.ok(codes(pf.blockers).includes('destino-dentro-del-origen'), d);
    assert.equal(pf.plan, null);
  }
  // Un destino hermano con nombre parecido NO está dentro.
  const hermano = `${src}2`;
  fs.mkdirSync(hermano);
  assert.deepEqual((await engine.preflight(copyOpts(src, hermano))).blockers, []);
});

test('preflight: destino que no existe, que no es carpeta, que es de red o relativo', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const { engine } = makeEngine(base);
  assert.ok(codes((await engine.preflight(copyOpts(src, path.join(base, 'no-existe')))).blockers).includes('destino-no-existe'));
  const archivo = path.join(base, 'archivo.txt');
  fs.writeFileSync(archivo, 'x');
  assert.ok(codes((await engine.preflight(copyOpts(src, archivo))).blockers).includes('destino-no-es-carpeta'));
  assert.ok(codes((await engine.preflight(copyOpts(src, '\\\\servidor\\recurso\\carpeta'))).blockers).includes('destino-red'));
  for (const mala of ['', 'relativa/carpeta', null, undefined, 5, '/tmp/a\0b']) {
    assert.ok(codes((await engine.preflight(copyOpts(src, mala))).blockers).includes('destino-no-valido'), String(mala));
  }
});

test('preflight: destino sin permiso de escritura (la sonda falla) => impedimento, y la sonda no queda', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (name === 'open' && args[0].includes('.byd-sonda')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(copyOpts(src, dest));
  assert.ok(codes(pf.blockers).includes('destino-no-escribible'));
  assert.deepEqual(fs.readdirSync(dest), []);
});

test('preflight: orígenes protegidos (se revalida AHORA), también los inexistentes y con trucos', async (t) => {
  const base = tmpDir(t);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  for (const prot of ['C:\\Windows', 'c:/WINDOWS/System32', 'D:\\BoneYardDog-Cuarentena', 'D:\\BoneYardDog-Cuarentena\\2026-10-27_1405\\x', 'C:\\Users\\amir\\AppData\\Roaming', 'C:\\Users\\amir', 'C:\\Program Files', 'C:\\Windows \\x', 'C:\\Temp\\..\\Windows']) {
    const pf = await engine.preflight(copyOpts(prot, dest));
    assert.ok(codes(pf.blockers).includes('origen-protegido'), prot);
    assert.equal(pf.plan, null, prot);
  }
  assert.deepEqual(fs.readdirSync(dest), [], 'nada se escribió');
  // Destino protegido.
  const src = makeSource(base);
  assert.ok(codes((await engine.preflight(copyOpts(src, 'C:\\Windows\\System32'))).blockers).includes('destino-protegido'));
});

test('preflight: un origen que contiene algo protegido en su interior se bloquea', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base, { isProtected: (p) => p.endsWith(`${path.sep}hondo`) });
  const pf = await engine.preflight(copyOpts(src, dest));
  assert.ok(codes(pf.blockers).includes('origen-contiene-protegidos'));
  assert.deepEqual(pf.blockers.find((b) => b.code === 'origen-contiene-protegidos').ejemplos, [path.join(src, 'sub', 'hondo')]);
});

test('preflight: orígenes inexistentes, archivos, enlaces, repetidos, anidados y demasiados', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  assert.ok(codes((await engine.preflight(copyOpts(path.join(base, 'no-existe'), dest))).blockers).includes('origen-no-existe'));
  assert.ok(codes((await engine.preflight(copyOpts(path.join(src, 'a.txt'), dest))).blockers).includes('origen-no-es-carpeta'));
  assert.ok(codes((await engine.preflight({ sources: [], destinationRoot: dest, mode: 'copy' })).blockers).includes('sin-origenes'));
  assert.ok(codes((await engine.preflight({ sources: Array.from({ length: 501 }, (_, i) => path.join(base, `c${i}`)), destinationRoot: dest, mode: 'copy' })).blockers).includes('demasiados-origenes'));
  assert.ok(codes((await engine.preflight({ sources: [src, path.join(src, 'sub')], destinationRoot: dest, mode: 'copy' })).blockers).includes('origen-anidado'));
  assert.ok(codes((await engine.preflight({ sources: [src, src], destinationRoot: dest, mode: 'copy' })).blockers).includes('origen-anidado'), 'repetido');
  for (const malo of [5, null, '', 'relativo', ['x']]) {
    assert.ok(codes((await engine.preflight({ sources: [malo], destinationRoot: dest, mode: 'copy' })).blockers).includes('origen-no-valido'), String(malo));
  }
  assert.ok(codes((await engine.preflight({ sources: [src], destinationRoot: dest, mode: 'borrar' })).blockers).includes('modo-invalido'));
  assert.ok(codes((await engine.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'nada' })).blockers).includes('verificacion-invalida'));
  assert.ok(codes((await engine.preflight({ sources: [src], destinationRoot: dest, mode: 'move', disposal: 'eliminar' })).blockers).includes('disposicion-invalida'));
  assert.deepEqual(fs.readdirSync(dest), []);
  try {
    fs.symlinkSync(src, path.join(base, 'enlace-raiz'), 'dir');
    assert.ok(codes((await engine.preflight(copyOpts(path.join(base, 'enlace-raiz'), dest))).blockers).includes('origen-es-enlace'));
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
  }
});

test('preflight: origen y destino en el mismo disco => aviso', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, makeDest(base)));
  assert.deepEqual(pf.blockers, []);
  assert.deepEqual(pf.warnings.find((w) => w.code === 'mismo-disco').origenes, [src]);
});

test('preflight: ruta de destino larga => aviso', async (t) => {
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'f');
  write(path.join(src, 'x'.repeat(100), 'y'.repeat(100), 'z'.repeat(60) + '.txt'), 'largo');
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, makeDest(base)));
  const w = pf.warnings.find((x) => x.code === 'ruta-larga');
  assert.ok(w, JSON.stringify(codes(pf.warnings)));
  assert.ok(w.ejemplos[0].length > 240);
});

test('preflight: carpetas con muchas entradas en FAT32 => aviso', async (t) => {
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'f');
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(src, `f${i}`), '');
  const { engine } = makeEngine(base, { volumeInfo: async () => ({ driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 64e9, freeBytes: 60e9 }) });
  const pf = await engine.preflight(copyOpts(src, makeDest(base)));
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.warnings.find((w) => w.code === 'carpeta-con-muchas-entradas').carpetas[0].entradas, 20001);
});

test('preflight: origen dentro de OneDrive => aviso (variables OneDrive, OneDriveConsumer y OneDriveCommercial)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const { engine } = makeEngine(base, { env: { [key]: path.join(base, 'origen') } });
    const pf = await engine.preflight(copyOpts(src, dest));
    assert.ok(codes(pf.warnings).includes('onedrive'), key);
    assert.match(pf.warnings.find((w) => w.code === 'onedrive').message, /solo en la nube/);
  }
  const none = await makeEngine(base, { env: { OneDrive: path.join(base, 'otra-cosa') } }).engine.preflight(copyOpts(src, dest));
  assert.ok(!codes(none.warnings).includes('onedrive'));
});

test('enlaces simbólicos: se omiten, se listan y no se siguen; el original no se retira', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const externo = path.join(base, 'externo');
  write(path.join(externo, 'secreto.txt'), 'NO debe copiarse');
  try {
    fs.symlinkSync(externo, path.join(src, 'enlace-a-carpeta'), 'dir');
    fs.symlinkSync(path.join(externo, 'secreto.txt'), path.join(src, 'enlace-a-archivo.txt'), 'file');
  } catch (err) {
    t.skip(`No se pueden crear enlaces simbólicos aquí (${err.code})`);
    return;
  }
  const dest = makeDest(base);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  const w = pf.warnings.find((x) => x.code === 'enlaces-no-se-copian');
  assert.deepEqual(w.enlaces.sort(), [path.join(src, 'enlace-a-archivo.txt'), path.join(src, 'enlace-a-carpeta')].sort());
  assert.ok(codes(pf.warnings).includes('original-no-se-retirara'));
  const r = await engine.run(pf.plan);
  const copy = r.carpetas[0].destino;
  assert.equal(fs.existsSync(path.join(copy, 'enlace-a-carpeta')), false);
  assert.equal(fs.existsSync(path.join(copy, 'enlace-a-archivo.txt')), false);
  assert.equal(fs.existsSync(path.join(copy, 'secreto.txt')), false, 'no se siguió el enlace');
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /Contiene enlaces o elementos que no se copiaron/, 'lo decide la guarda explícita, no solo la nueva lectura del origen');
  assert.deepEqual(trashed, []);
  assert.ok(fs.lstatSync(path.join(src, 'enlace-a-carpeta')).isSymbolicLink(), 'el enlace original sigue ahí');
  const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(man.carpetas[0].enlacesOmitidos.length, 2);
});

test('elementos ilegibles: se listan y el original no se retira (se perdería lo que no se copió)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (name === 'readdir' && args[0] === path.join(src, 'sub', 'hondo')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  const w = pf.warnings.find((x) => x.code === 'elementos-ilegibles');
  assert.equal(w.elementos[0].ruta, path.join(src, 'sub', 'hondo'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /Contiene enlaces o elementos que no se copiaron/);
  assert.deepEqual(trashed, []);
});

// ================================================================ qué hacer con el original

test('"papelera": con la Papelera simulada exitosa el original desaparece y la copia verificada existe', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.disposal.papelera.verdict, 'probablemente-cabe');
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'original-enviado-a-papelera');
  assert.deepEqual(trashed, [src]);
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(snapshot(c.destino), before, 'la copia tiene todo');
  assert.equal(r.estado, 'completo');
  const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.deepEqual(man.carpetas[0].original, { accion: 'papelera', motivo: null });
});

test('"papelera": si la Papelera falla, el original sigue intacto y se informa', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine } = makeEngine(base, {
    trash: async () => {
      throw new Error('La Papelera está llena');
    },
  });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /La Papelera está llena/);
  assert.match(r.carpetas[0].motivo, /sigue donde estaba/);
  assert.deepEqual(snapshot(src), before);
  assert.equal(r.carpetas[0].verificada, true, 'la copia sí está verificada');
});

test('"papelera": si dice que terminó pero el original sigue ahí, se informa y no se da por retirado', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base, { trash: async () => {} });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /no retiró/);
  assert.ok(fs.existsSync(src));
});

test('"papelera" se RECHAZA si puede no caber o si el origen no tiene Papelera, salvo acceptRecycleRisk', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const bytesProbe = (await makeEngine(base).engine.preflight(copyOpts(src, dest))).plan.totals.bytes;
  const dst = { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 5e11 };

  // Puede no caber: lo que se envía es más del 5 % del disco de origen.
  const pequeno = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: bytesProbe * 10, freeBytes: 1 }) });
  const rej = await pequeno.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.ok(codes(rej.blockers).includes('papelera-no-recomendada'));
  assert.equal(rej.blockers.find((b) => b.code === 'papelera-no-recomendada').veredicto, 'puede-no-caber');
  assert.match(rej.blockers.find((b) => b.code === 'papelera-no-recomendada').message, /5 %/);
  assert.equal(rej.plan, null);
  const acc = await pequeno.engine.preflight(moveOpts(src, dest, 'papelera', { acceptRecycleRisk: true }));
  assert.deepEqual(acc.blockers, []);
  assert.ok(codes(acc.warnings).includes('papelera-riesgo-aceptado'));

  // Origen extraíble: no tiene Papelera.
  const usb = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 64e9, freeBytes: 1 }) });
  const rej2 = await usb.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.equal(rej2.blockers.find((b) => b.code === 'papelera-no-recomendada').veredicto, 'sin-papelera');
  assert.equal(rej2.disposal.papelera.verdict, 'sin-papelera');

  // Sin datos del origen: tampoco se asume.
  const unk = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null }) });
  const rej3 = await unk.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.equal(rej3.blockers.find((b) => b.code === 'papelera-no-recomendada').veredicto, 'desconocido');

  // Sin función de Papelera inyectada.
  const noTrash = makeEngine(base, { trash: null });
  assert.ok(codes((await noTrash.engine.preflight(moveOpts(src, dest, 'papelera'))).blockers).includes('sin-funcion-papelera'));
});

test('"cuarentena": rename real en el volumen de origen; contenido idéntico, original ausente y LEEME explicativo', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, quarantine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'cuarentena'));
  assert.deepEqual(pf.blockers, []);
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'original-en-cuarentena');
  assert.deepEqual(trashed, [], 'no usa la Papelera');
  assert.equal(fs.existsSync(src), false, 'el original ya no está en su sitio');
  const qBatch = path.join(quarantine, 'BoneYardDog-Cuarentena', r.lote);
  const moved = path.join(qBatch, ...withoutDrive(src));
  assert.deepEqual(snapshot(moved), before, 'contenido idéntico en cuarentena');
  assert.deepEqual(snapshot(c.destino), before, 'y en la copia');
  const leeme = fs.readFileSync(path.join(qBatch, 'LEEME.txt'), 'utf8');
  assert.match(leeme, /CUARENTENA/);
  assert.match(leeme, /Explorador de Windows/);
  const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(man.carpetas[0].original.accion, 'cuarentena');
  assert.equal(man.carpetas[0].original.destino, moved);
});

test('"cuarentena": si el rename falla (otro volumen, bloqueada), el original sigue intacto', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { fs: sfs } = spyFs({
    before: (name) => {
      if (name === 'rename') throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    },
  });
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(moveOpts(src, dest, 'cuarentena'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /EXDEV/);
  assert.deepEqual(snapshot(src), before);
});

test('"cuarentena": no pisa nada que ya exista en la cuarentena (el original se queda donde estaba)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, quarantine } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'cuarentena'));
  const qDest = path.join(quarantine, 'BoneYardDog-Cuarentena', '2026-10-27_1405', ...withoutDrive(src));
  write(path.join(qDest, 'previo.txt'), 'ya estaba');
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /Ya existe algo en la cuarentena/);
  assert.equal(fs.readFileSync(path.join(qDest, 'previo.txt'), 'utf8'), 'ya estaba');
  assert.deepEqual(snapshot(src), before);
});

test('"ninguna": el original no se toca aunque todo esté verificado', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'ninguna'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /dejar el original/);
  assert.equal(r.carpetas[0].verificada, true);
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
});

test('cada carpeta es independiente: el fallo de una no afecta a las demás', async (t) => {
  const base = tmpDir(t);
  const bad = makeSource(base);
  const good = path.join(base, 'origen2', 'Buena');
  write(path.join(good, 'ok.txt'), 'todo bien');
  const third = path.join(base, 'origen3', 'Tercera');
  write(path.join(third, 'otra.txt'), 'también bien');
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (name === 'open' && args[1] === 'r' && args[0].endsWith('canción.txt')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight({ sources: [bad, good, third], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  assert.deepEqual(pf.blockers, []);
  const r = await engine.run(pf.plan);
  assert.deepEqual(r.carpetas.map((c) => c.resultado), ['con-errores', 'original-enviado-a-papelera', 'original-enviado-a-papelera']);
  assert.deepEqual(trashed.sort(), [good, third].sort());
  assert.ok(fs.existsSync(bad), 'la que falló conserva su original');
  assert.equal(r.estado, 'con-errores');
  assert.equal(fs.readFileSync(path.join(r.carpetas[1].destino, 'ok.txt'), 'utf8'), 'todo bien');
});

test('la protección se revalida justo antes de retirar el original', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  let protectedNow = false;
  const { engine, trashed } = makeEngine(base, { isProtected: (p) => protectedNow && p === src });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  protectedNow = true; // pasa a estar protegida entre la planificación y la retirada
  const r = await engine.run(pf.plan, { hooks: {} });
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /protegida/);
  assert.deepEqual(trashed, []);
});

// ============================================================ quitarCopiado y verifyBatch

test('quitarCopiado: quita SOLO lo que creó esta operación y deja lo ajeno', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  write(path.join(dest, 'foto-del-usuario.jpg'), 'mis fotos'); // ya estaba en el destino
  const before = snapshot(src);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  // Un archivo ajeno que aparece DENTRO del lote: no es nuestro.
  write(path.join(r.carpetas[0].destino, 'sub', 'ajeno.txt'), 'no lo creó BoneYardDog');

  const report = await engine.quitarCopiado(r);
  assert.ok(report.quitados > 0);
  assert.equal(fs.readFileSync(path.join(dest, 'foto-del-usuario.jpg'), 'utf8'), 'mis fotos');
  assert.equal(fs.readFileSync(path.join(r.carpetas[0].destino, 'sub', 'ajeno.txt'), 'utf8'), 'no lo creó BoneYardDog', 'lo ajeno se queda');
  assert.ok(report.omitidos.some((o) => o.motivo === 'no-esta-vacia'));
  assert.equal(fs.existsSync(path.join(r.carpetas[0].destino, 'a.txt')), false, 'lo propio se quitó');
  assert.deepEqual(snapshot(src), before, 'el origen intacto');
  assert.ok(fs.existsSync(path.join(dest, 'BoneYardDog')), 'la carpeta compartida BoneYardDog no se toca');
});

test('quitarCopiado: no sigue enlaces y no sale de su lote', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const externo = path.join(base, 'externo');
  write(path.join(externo, 'importante.txt'), 'importante');
  const { engine } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  // Registro manipulado: rutas fuera del lote y un enlace dentro del lote.
  const forged = { ...r, created: [...r.created, { path: path.join(externo, 'importante.txt'), type: 'file' }, { path: path.join(dest, 'foto.jpg'), type: 'file' }, { path: path.join(r.batchFolder, '..', '..', '..', 'otro'), type: 'dir' }] };
  write(path.join(dest, 'foto.jpg'), 'foto');
  try {
    fs.symlinkSync(externo, path.join(r.batchFolder, 'enlace'), 'dir');
    forged.created.push({ path: path.join(r.batchFolder, 'enlace'), type: 'dir' }, { path: path.join(r.batchFolder, 'enlace', 'importante.txt'), type: 'file' });
  } catch {
    /* sin enlaces en este sistema */
  }
  const report = await engine.quitarCopiado(forged);
  assert.equal(fs.readFileSync(path.join(externo, 'importante.txt'), 'utf8'), 'importante', 'ni siquiera a través de una carpeta-enlace dentro del lote');
  assert.equal(fs.readFileSync(path.join(dest, 'foto.jpg'), 'utf8'), 'foto');
  assert.ok(report.omitidos.some((o) => o.motivo === 'fuera-del-lote'));
});

test('quitarCopiado se NIEGA si ya se retiró algún original (la copia es lo único que queda)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const r = await engine.run((await engine.preflight(moveOpts(src, dest, 'papelera'))).plan);
  assert.equal(r.carpetas[0].resultado, 'original-enviado-a-papelera');
  await assert.rejects(() => engine.quitarCopiado(r), /lo único que queda/);
  assert.ok(fs.existsSync(path.join(r.carpetas[0].destino, 'a.txt')));
  await assert.rejects(() => engine.quitarCopiado(null), /no válido/);
  await assert.rejects(() => engine.quitarCopiado({}), /no válido/);
});

test('verifyBatch: lote íntegro, luego detecta un archivo alterado, uno faltante y uno sobrante', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const copy = r.carpetas[0].destino;

  const ok = await engine.verifyBatch(r.batchFolder);
  assert.equal(ok.ok, true);
  assert.equal(ok.verificados, 5);
  assert.deepEqual(ok.problemas, []);

  // Alterado (mismo tamaño y fecha): solo la huella lo delata.
  const altered = path.join(copy, 'a.txt');
  const st = fs.statSync(altered);
  fs.writeFileSync(altered, 'HOLA MUNDO');
  fs.utimesSync(altered, st.atime, st.mtime);
  fs.unlinkSync(path.join(copy, 'sub', 'y.txt'));
  write(path.join(copy, 'sobrante.txt'), 'extra');
  const bad = await engine.verifyBatch(r.batchFolder);
  assert.equal(bad.ok, false);
  const byFile = Object.fromEntries(bad.problemas.map((p) => [p.ruta.split('/').slice(-1)[0], p.problema]));
  assert.equal(byFile['a.txt'], 'huella');
  assert.equal(byFile['y.txt'], 'falta');
  assert.equal(byFile['sobrante.txt'], 'sobrante');

  // El modo rápido (tamaño y fecha) no ve la alteración de a.txt pero sí lo que falta.
  const quick = await engine.verifyBatch(r.batchFolder, { mode: 'quick' });
  assert.ok(!quick.problemas.some((p) => p.ruta.endsWith('a.txt')));
  assert.ok(quick.problemas.some((p) => p.problema === 'falta'));
});

test('verifyBatch: manifiesto ausente, dañado o con rutas que intentan salir del lote', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  await assert.rejects(() => engine.verifyBatch(path.join(base, 'no-hay-lote')), /No se pudo leer MANIFIESTO/);
  await assert.rejects(() => engine.verifyBatch(5), /no válida/);

  const file = path.join(r.batchFolder, 'MANIFIESTO.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '{ roto');
  await assert.rejects(() => engine.verifyBatch(r.batchFolder), /No se pudo leer MANIFIESTO/);
  fs.writeFileSync(file, JSON.stringify({ version: 9 }));
  await assert.rejects(() => engine.verifyBatch(r.batchFolder), /formato esperado/);

  write(path.join(base, 'secreto-fuera.txt'), 'fuera del lote');
  const m = JSON.parse(good);
  m.carpetas[0].archivos.push({ ruta: '../../../../secreto-fuera.txt', tamano: 1, mtimeMs: 0, sha256: 'x' }, { ruta: '/etc/passwd', tamano: 1, mtimeMs: 0, sha256: 'x' }, { ruta: 'C:\\Windows\\win.ini', tamano: 1, mtimeMs: 0, sha256: 'x' });
  m.carpetas.push({ origen: 'x', destino: '../../fuera', resultado: 'copiada-verificada', archivos: [{ ruta: 'a', tamano: 1, mtimeMs: 0, sha256: 'x' }] });
  fs.writeFileSync(file, JSON.stringify(m));
  const res = await engine.verifyBatch(r.batchFolder);
  assert.equal(res.ok, false);
  assert.equal(res.problemas.filter((p) => p.problema === 'ruta-no-valida').length, 4, 'ninguna ruta peligrosa se sigue');
});

// ============================================= la regla de oro, revisada en el código fuente

test('REGLA DE ORO (código fuente): las únicas eliminaciones están en las funciones permitidas y la Papelera solo se llama al retirar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'transfer.js'), 'utf8');
  const lines = source.split('\n');
  const enclosing = (index) => {
    for (let i = index; i >= 0; i--) {
      const m = /^\s{2}(?:async )?function (\w+)\(/.exec(lines[i]);
      if (m) return m[1];
    }
    return null;
  };
  const allowed = { removeOwn: ['unlink'], removeCreatedEntry: ['unlink', 'rmdir'], disposeOriginal: ['rename', 'trash'], preflight: ['unlink'] };
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comentarios
    for (const m of line.matchAll(/\b(?:fsp|fs|promises)\.(unlink|rm|rmdir|rename|truncate|rmSync|unlinkSync|renameSync|rmdirSync)\(|\bawait trash\(/g)) {
      found.push({ fn: enclosing(i), kind: m[1] || 'trash', line: i + 1 });
    }
  });
  assert.ok(found.length >= 5, 'la revisión encontró las llamadas esperadas');
  for (const f of found) assert.ok((allowed[f.fn] || []).includes(f.kind), `${f.kind} en ${f.fn} (línea ${f.line}) no está permitido`);
  // preflight solo puede borrar su propia sonda.
  const probeLines = found.filter((f) => f.fn === 'preflight');
  assert.equal(probeLines.length, 1);
  assert.match(lines[probeLines[0].line - 1], /unlink\(probePath\)/);
  // Nada de eliminación recursiva ni de módulos externos de borrado.
  assert.doesNotMatch(source, /\brimraf\b|recursive:\s*true,\s*force|\.rm\(|rmSync|fs-extra|trash-cli/);
  // Cada eliminación de lo propio pasa por una comprobación "dentro de mi lote".
  assert.match(source, /async function removeOwn[\s\S]*?strictlyInside\(filePath, batchFolder\)/);
  assert.match(source, /async function removeCreatedEntry[\s\S]*?strictlyInside\(p, container\)/);
  // La disposición solo se invoca después de verificar y de volver a comprobar el origen.
  const dispose = source.indexOf("await disposeOriginal('papelera'");
  assert.ok(source.lastIndexOf('result.verificada', dispose) > 0);
  assert.ok(source.lastIndexOf('if (changed) {', dispose) > 0);
  assert.ok(source.lastIndexOf("plan.mode === 'move' && result.resultado === 'copiada-verificada' && result.verificada", dispose) > 0);
});

test('el motor y las reglas solo usan módulos de Node (sin dependencias ni child_process)', () => {
  for (const file of ['transfer.js', 'transfer-rules.js', 'volume.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', file), 'utf8');
    const requires = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of requires) assert.ok(r.startsWith('node:') || r.startsWith('./'), `${file} requiere ${r}`);
    assert.doesNotMatch(source, /child_process/);
  }
});

// ================================================== rutas reales (enlaces en medio de la ruta)

function linkOrSkip(t, target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, 'dir');
    return true;
  } catch (err) {
    t.skip(`No se pueden crear enlaces simbólicos aquí (${err.code})`);
    return false;
  }
}

test('rutas reales: un origen alcanzado POR UN ENLACE hacia una carpeta protegida se bloquea (y no se escribe ni se retira nada)', async (t) => {
  const base = tmpDir(t);
  const prot = path.join(base, 'zona-protegida');
  const secreto = path.join(prot, 'Documentos');
  write(path.join(secreto, 'a.txt'), 'importante', 100);
  const enlace = path.join(base, 'atajo');
  if (!linkOrSkip(t, prot, enlace)) return;
  const dest = makeDest(base);
  const before = snapshot(prot);
  const { engine, trashed } = makeEngine(base, { isProtected: (p) => p === prot || p.startsWith(prot + path.sep) });
  // Sin el truco, la ruta protegida se bloquea (control).
  assert.ok(codes((await engine.preflight(moveOpts(secreto, dest, 'papelera'))).blockers).includes('origen-protegido'));
  // Con el enlace en medio, la ruta TEXTUAL parece inofensiva: debe bloquearse igual.
  const viaEnlace = path.join(enlace, 'Documentos');
  const pf = await engine.preflight(moveOpts(viaEnlace, dest, 'papelera'));
  const b = pf.blockers.find((x) => x.code === 'origen-protegido');
  assert.ok(b, 'bloqueado');
  assert.equal(b.rutaReal, secreto);
  assert.match(b.message, /enlace/);
  assert.equal(pf.plan, null);
  assert.deepEqual(fs.readdirSync(dest), [], 'no se escribió nada');
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(prot), before);
});

test('rutas reales: un DESTINO que es un enlace hacia el interior del origen se bloquea sin escribir nada', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dentro = path.join(src, 'sub');
  const enlace = path.join(base, 'destino-trampa');
  if (!linkOrSkip(t, dentro, enlace)) return;
  const before = snapshot(src);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, enlace));
  const b = pf.blockers.find((x) => x.code === 'destino-dentro-del-origen');
  assert.ok(b, 'bloqueado');
  assert.match(b.message, /enlace/);
  assert.equal(pf.plan, null);
  assert.deepEqual(snapshot(src), before, 'ni siquiera la sonda de escritura tocó el origen');
});

test('rutas reales: un destino que es un enlace hacia una carpeta protegida se bloquea', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const prot = path.join(base, 'zona-protegida');
  fs.mkdirSync(prot);
  const enlace = path.join(base, 'destino-trampa');
  if (!linkOrSkip(t, prot, enlace)) return;
  const { engine } = makeEngine(base, { isProtected: (p) => p === prot || p.startsWith(prot + path.sep) });
  const pf = await engine.preflight(copyOpts(src, enlace));
  assert.ok(codes(pf.blockers).includes('destino-protegido'));
  assert.deepEqual(fs.readdirSync(prot), []);
});

test('rutas reales: un enlace inofensivo en medio de la ruta se resuelve, se copia y el plan y el manifiesto guardan la ruta REAL', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const raizOrigen = path.join(base, 'origen');
  const enlaceO = path.join(base, 'atajo-origen');
  const real = makeDest(base);
  const enlaceD = path.join(base, 'atajo-destino');
  if (!linkOrSkip(t, raizOrigen, enlaceO) || !linkOrSkip(t, real, enlaceD)) return;
  const pedido = path.join(enlaceO, path.basename(src));
  const before = snapshot(src);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(pedido, enlaceD));
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.plan.sources[0].source, fs.realpathSync(src), 'el plan guarda la ruta real del origen');
  assert.equal(pf.plan.sources[0].requested, pedido);
  assert.equal(pf.plan.destinationRoot, fs.realpathSync(real), 'y la real del destino');
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'copiada-verificada');
  assert.equal(r.carpetas[0].origen, fs.realpathSync(src));
  assert.equal(r.carpetas[0].solicitado, pedido);
  assert.ok(r.batchFolder.startsWith(fs.realpathSync(real) + path.sep), 'se escribió en la carpeta real');
  assert.deepEqual(snapshot(r.carpetas[0].destino), before);
  const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
  assert.equal(man.carpetas[0].origen, fs.realpathSync(src));
  assert.equal(man.destino, fs.realpathSync(real));
});

test('rutas reales: dos orígenes que son la misma carpeta por caminos distintos cuentan como anidados', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const enlace = path.join(base, 'atajo-origen');
  if (!linkOrSkip(t, path.join(base, 'origen'), enlace)) return;
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight({ sources: [src, path.join(enlace, path.basename(src))], destinationRoot: dest, mode: 'copy', verify: 'full' });
  assert.ok(codes(pf.blockers).includes('origen-anidado'));
});

test('rutas reales: ANTES de retirar se vuelve a resolver la ruta real; si un enlace desvió el origen, no se toca', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const respaldo = `${src}-respaldo`;
  const { engine, trashed } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, []);
  let linked = true;
  // Entre verificar y retirar, la carpeta se reemplaza por un enlace hacia una carpeta IDÉNTICA: el recorrido en vivo no vería diferencia.
  const r = await engine.run(pf.plan, {
    hooks: {
      afterVerify: async () => {
        fs.renameSync(src, respaldo);
        try {
          fs.symlinkSync(respaldo, src, 'dir');
        } catch {
          linked = false;
          fs.renameSync(respaldo, src);
        }
      },
    },
  });
  if (!linked) {
    t.skip('No se pueden crear enlaces simbólicos aquí');
    return;
  }
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /ruta real cambió/);
  assert.deepEqual(trashed, [], 'la Papelera ni se llamó');
  assert.ok(fs.existsSync(respaldo));
});
