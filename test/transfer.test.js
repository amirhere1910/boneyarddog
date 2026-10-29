'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../test-support/transfer-helpers');
const { fs, path, tmpDir, write, sha, snapshot, makeSource, spyFs, makeEngine, makeDest, NTFS_FIXED, DESTRUCTIVE, isInside, DAY } = H;

const copyOpts = (src, dest, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full', ...extra });
const moveOpts = (src, dest, disposal, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal, ...extra });
const codes = (list) => list.map((b) => b.code);

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
  assert.equal(copy, path.join(fs.realpathSync(dest), path.basename(src)), 'queda <destino>\\<nombre de la carpeta>, sin unidad, ruta larga ni carpeta de fecha');
  assert.deepEqual(fs.readdirSync(dest), [path.basename(src)], 'y NADA más en el destino (ningún archivo de BoneYardDog)');
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
  assert.deepEqual(phases, ['preparando', 'copiando', 'verificando', 'terminado']);
  const copying = events.filter((e) => e.fase === 'copiando').map((e) => e.bytesDone);
  assert.ok(copying.every((v, i) => i === 0 || v >= copying[i - 1]), 'el progreso no retrocede');
  const last = events[events.length - 1];
  assert.equal(last.totalFiles, 6);
  assert.equal(last.overallFilesDone, 6);
  assert.ok(events.some((e) => typeof e.bytesPerSecond === 'number'));

  // En modo copiar no se elimina ni renombra NADA del origen (solo la sonda y el cambio de nombre en el destino).
  const destructive = calls.filter((c) => DESTRUCTIVE.has(c.name));
  assert.ok(destructive.every((c) => !isInside(String(c.args[0]), src)), JSON.stringify(destructive.map((c) => [c.name, c.args[0]])));
  assert.deepEqual(
    destructive.map((c) => [c.name, c.name === 'rename' ? `${path.basename(c.args[0])} -> ${path.basename(c.args[1])}` : path.basename(c.args[0]).startsWith('.byd-sonda-')]),
    [['unlink', true], ['rename', `${path.basename(src)}.copiando -> ${path.basename(src)}`]],
    'solo se quitó la sonda de escritura y se cambió el nombre de la carpeta provisional',
  );
  assert.ok(fs.readdirSync(dest).every((n) => !n.startsWith('.byd-sonda')), 'la sonda no queda en el destino');
});

test('el registro (en el PC) tiene lo necesario para verificar, y en el destino no hay NINGÚN archivo de BoneYardDog', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, registry } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  // Destino limpio: solo la carpeta, y dentro exactamente lo del origen.
  assert.deepEqual(fs.readdirSync(dest), [path.basename(src)]);
  assert.deepEqual(Object.keys(snapshot(dest)).filter((k) => /ESTADO|MANIFIESTO|LEEME|BoneYardDog|\.byd/i.test(k)), []);
  // Registro.
  assert.match(c.registroId, /^[0-9a-f]{16}$/);
  const rec = await registry.get(c.registroId);
  assert.equal(rec.version, 1);
  assert.equal(rec.nombre, path.basename(src));
  assert.equal(rec.origen, src);
  assert.equal(rec.destino, c.destino);
  assert.equal(rec.modo, 'copy');
  assert.equal(rec.verificacion, 'full');
  assert.equal(rec.sistemaDeArchivos, 'NTFS');
  assert.equal(rec.fecha, new Date(2026, 9, 27, 14, 5).toISOString());
  assert.deepEqual(rec.original, { accion: 'sin-tocar', motivo: 'copiar no retira nada' });
  assert.deepEqual(rec.archivos.map((a) => a.ruta), ['a.txt', 'canción.txt', 'cero.bin', 'sub/hondo/x.bin', 'sub/y.txt']);
  for (const a of rec.archivos) {
    const file = path.join(src, ...a.ruta.split('/'));
    assert.equal(a.tamano, fs.statSync(file).size);
    assert.equal(a.sha256, sha(file), a.ruta);
    assert.ok(Math.abs(a.mtimeMs - fs.statSync(file).mtimeMs) < 1);
  }
  assert.deepEqual([...rec.carpetasVacias].sort(), ['sub', 'sub/hondo', 'vacia']);
  assert.equal(rec.totalBytes, pf.plan.totals.bytes);
  // Y verifica bien más tarde, con ese registro.
  const v = await engine.verifyRecord(rec, { mode: 'full' });
  assert.equal(v.estado, 'ok');
  assert.equal(v.verificados, 5);
  assert.deepEqual(v.problemas, []);
});

test('NUNCA sobrescribe: si el archivo ya existe en el destino, es un error de ese archivo y su contenido queda intacto', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    after: (name, args) => {
      // Justo después de crear la carpeta contenedora, aparece un archivo ajeno con el mismo nombre que otro del plan.
      if (name === 'mkdir' && path.basename(args[0]) === `${path.basename(src)}.copiando`) fs.writeFileSync(path.join(args[0], 'a.txt'), 'NO TOCAR: es del usuario');
    },
  });
  const { engine } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'con-errores');
  assert.ok(c.errores.some((e) => e.ruta === 'a.txt' && e.codigo === 'EEXIST'), JSON.stringify(c.errores));
  const work = path.join(dest, `${path.basename(src)}.copiando`);
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'NO TOCAR: es del usuario', 'su contenido sigue intacto (ni se sobrescribió ni se borró)');
  assert.equal(fs.existsSync(c.destino), false, 'la carpeta final NO existe: nunca parece una copia buena');
  assert.equal(c.limpieza.limpia, false, 'la limpieza respetó lo ajeno y lo dice');
  assert.deepEqual(c.limpieza.pendientes, [work]);
  assert.match(c.motivo, /quedó la carpeta/);
  assert.equal(r.estado, 'con-errores');
});

test('si el destino ya tiene algo con ese nombre se usa «(2)», «(3)»… y se avisa; lo existente no se toca', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const name = path.basename(src);
  fs.mkdirSync(path.join(dest, name));
  fs.writeFileSync(path.join(dest, name, 'viejo.txt'), 'lo que ya había');
  fs.mkdirSync(path.join(dest, `${name} (2)`));
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  assert.deepEqual(pf.blockers, []);
  const w = pf.warnings.find((x) => x.code === 'renombrado-por-nombre-existente');
  assert.ok(w, 'avisa');
  assert.match(w.message, new RegExp(`Se guardará como «${name} \\(3\\)» porque ya existe algo con ese nombre`));
  assert.equal(pf.plan.sources[0].finalName, `${name} (3)`);
  const r = await engine.run(pf.plan);
  assert.equal(r.estado, 'completo');
  assert.equal(r.carpetas[0].destino, path.join(fs.realpathSync(dest), `${name} (3)`));
  assert.equal(fs.readFileSync(path.join(dest, name, 'viejo.txt'), 'utf8'), 'lo que ya había');
  assert.deepEqual(fs.readdirSync(path.join(dest, `${name} (2)`)), []);
  assert.deepEqual(snapshot(path.join(dest, `${name} (3)`)), snapshot(src));
});

test('dos orígenes con el mismo nombre: la segunda se guarda como «(2)» y la revisión lo dice', async (t) => {
  const base = tmpDir(t);
  const a = path.join(base, 'uno', 'Fotos');
  const b = path.join(base, 'dos', 'Fotos');
  write(path.join(a, 'a.txt'), 'de uno');
  write(path.join(b, 'b.txt'), 'de dos');
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight({ sources: [a, b], destinationRoot: dest, mode: 'copy', verify: 'full' });
  assert.deepEqual(pf.blockers, []);
  assert.deepEqual(pf.plan.sources.map((x) => x.finalName), ['Fotos', 'Fotos (2)']);
  assert.match(pf.warnings.find((x) => x.code === 'renombrado-por-nombre-existente').message, /«Fotos \(2\)» porque otra carpeta elegida se llama igual/);
  const r = await engine.run(pf.plan);
  assert.equal(r.estado, 'completo');
  assert.deepEqual(fs.readdirSync(dest).sort(), ['Fotos', 'Fotos (2)']);
  assert.equal(fs.readFileSync(path.join(dest, 'Fotos', 'a.txt'), 'utf8'), 'de uno');
  assert.equal(fs.readFileSync(path.join(dest, 'Fotos (2)', 'b.txt'), 'utf8'), 'de dos');
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
  assert.equal(c.limpieza.limpia, true, 'la copia dañada se quitó sola');
  assert.deepEqual(fs.readdirSync(dest), [], 'en el destino no queda nada: ni copia dañada ni carpeta provisional');
  assert.equal(c.registroId, null, 'una copia dañada no se registra como buena');
});

test('la verificación RÁPIDA no detecta esa corrupción (por eso se rotula así y no permite retirar el original)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  // Después de que la copia termina y se fijan las fechas, se altera un byte conservando tamaño y fecha.
  const flip = (name, args) => {
    if (name === 'utimes' && args[0].includes('.copiando') && args[0].endsWith('a.txt')) {
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
  const recq = await quick.registry.get(rq.carpetas[0].registroId);
  assert.equal(recq.verificacion, 'quick');
  assert.ok(recq.archivos.every((a) => a.sha256 === null));
  const vq = await quick.engine.verifyRecord(recq, { mode: 'full' });
  assert.equal(vq.estado, 'ok', 'ni verifyRecord puede detectarla: el registro rápido no tiene huellas');
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
      if (name === 'utimes' && args[0].includes('.copiando') && args[0].endsWith('a.txt')) fs.appendFileSync(args[0], 'de más');
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
  await assert.rejects(() => engine.run({ version: 2, mode: 'move', verify: 'quick', sources: [], totals: { files: 0, bytes: 0 } }), /verificación completa/);
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
  assert.deepEqual(fs.readdirSync(dest), [], 'no se deja una copia a medias: la app quitó lo que creó');
  assert.equal(c.limpieza.limpia, true);
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

test('cancelación a mitad: originales intactos, el destino queda limpio solo y sin copias a medias', async (t) => {
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
  assert.deepEqual(fs.readdirSync(dest), [], 'cancelar deja el destino LIMPIO: ni copia a medias ni carpeta provisional');
  assert.equal(r.carpetas[0].limpieza.limpia, true);
  assert.match(r.carpetas[0].motivo, /Cancelada por el usuario\. Se quitó la copia incompleta\. Los originales no se tocaron\./);
  assert.equal(r.carpetas[0].registroId, null, 'una copia cancelada no se registra');
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
  // La copia incompleta se quitó sola (no queda nada que parezca una copia buena).
  assert.deepEqual(fs.readdirSync(dest), []);
  assert.equal(c.limpieza.limpia, true);
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
  const { engine, trashed, registry } = makeEngine(base);
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
  assert.deepEqual((await registry.get(c.registroId)).original, { accion: 'papelera', motivo: null }, 'el registro anota qué se hizo con el original');
  assert.deepEqual(fs.readdirSync(dest), [path.basename(src)]);
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

test('"papelera": si puede no caber o el origen no tiene Papelera, es un AVISO (papelera-no-cabe, con los bytes) y no un impedimento', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const bytesProbe = (await makeEngine(base).engine.preflight(copyOpts(src, dest))).plan.totals.bytes;
  const dst = { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 5e11 };

  // Puede no caber: lo que se envía es más del 5 % del disco de origen.
  const pequeno = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: bytesProbe * 10, freeBytes: 1 }) });
  const pf = await pequeno.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf.blockers, [], 'no bloquea: la interfaz decide');
  assert.ok(pf.plan);
  const w = pf.warnings.find((x) => x.code === 'papelera-no-cabe');
  assert.equal(w.veredicto, 'puede-no-caber');
  assert.equal(w.bytes, bytesProbe);
  assert.equal(w.carpetas, 1);
  assert.match(w.message, /5 %/);
  assert.equal(pf.plan.recycleVerdict, 'puede-no-caber');
  // acceptRecycleRisk ya no existe: pasarlo no cambia nada.
  const pf2 = await pequeno.engine.preflight(moveOpts(src, dest, 'papelera', { acceptRecycleRisk: true }));
  assert.deepEqual(pf2.warnings.map((x) => x.code), pf.warnings.map((x) => x.code));

  // Origen extraíble: no tiene Papelera.
  const usb = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 64e9, freeBytes: 1 }) });
  const pf3 = await usb.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf3.blockers, []);
  assert.equal(pf3.warnings.find((x) => x.code === 'papelera-no-cabe').veredicto, 'sin-papelera');

  // Sin datos del origen: aviso aparte, sin afirmar nada.
  const unk = makeEngine(base, { volumeInfo: async (p) => (p === dest ? dst : { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null }) });
  const pf4 = await unk.engine.preflight(moveOpts(src, dest, 'papelera'));
  assert.deepEqual(pf4.blockers, []);
  assert.ok(codes(pf4.warnings).includes('papelera-desconocida'));
  assert.ok(!codes(pf4.warnings).includes('papelera-no-cabe'));

  // Un tamaño pequeño no avisa.
  assert.ok(!codes((await makeEngine(base).engine.preflight(moveOpts(src, dest, 'papelera'))).warnings).includes('papelera-no-cabe'));

  // Sin función de Papelera inyectada, sí es un impedimento.
  const noTrash = makeEngine(base, { trash: null });
  assert.ok(codes((await noTrash.engine.preflight(moveOpts(src, dest, 'papelera'))).blockers).includes('sin-funcion-papelera'));
});

test('la disposición "cuarentena" ya no existe: es un impedimento', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'cuarentena'));
  assert.ok(codes(pf.blockers).includes('disposicion-invalida'));
  assert.equal(pf.plan, null);
  assert.deepEqual(fs.readdirSync(dest), []);
});

// ============================================================ borrado definitivo del original

const delOpts = (src, dest, extra = {}) => moveOpts(src, dest, 'borrar', { confirmPermanentDelete: true, ...extra });

/** Busca un archivo por nombre dentro de un árbol (para alterar la copia desde un gancho de prueba). */
function findFile(root, name) {
  let found = null;
  (function walkDir(dir) {
    for (const n of fs.readdirSync(dir)) {
      const full = path.join(dir, n);
      if (fs.lstatSync(full).isDirectory()) walkDir(full);
      else if (n === name) found = full;
    }
  })(root);
  return found;
}

test('borrado definitivo, caso feliz: original ausente, copia idéntica, sin pasar por la Papelera y registrado', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, trashed, registry } = makeEngine(base);
  const pf = await engine.preflight(delOpts(src, dest));
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.plan.disposal, 'borrar');
  assert.equal(pf.plan.confirmPermanentDelete, true);
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'original-borrado-definitivamente');
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(snapshot(c.destino), before, 'la copia tiene todo, idéntico');
  assert.deepEqual(trashed, [], 'no pasó por la Papelera');
  assert.equal(r.estado, 'completo');
  assert.deepEqual((await registry.get(c.registroId)).original, { accion: 'borrado-definitivo', motivo: null });
});

test('borrado definitivo: sin confirmPermanentDelete el preflight lo bloquea, y un plan sin la confirmación no borra', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine } = makeEngine(base);
  for (const falsa of [undefined, false, 'true', 1, 'sí']) {
    const pf = await engine.preflight(moveOpts(src, dest, 'borrar', { confirmPermanentDelete: falsa }));
    assert.ok(codes(pf.blockers).includes('borrado-sin-confirmar'), String(falsa));
    assert.equal(pf.plan, null);
  }
  assert.deepEqual(fs.readdirSync(dest), [], 'no se escribió nada');
  // Aunque alguien fabrique el plan a mano, el motor mismo lo comprueba.
  const pf = await engine.preflight(delOpts(src, dest));
  for (const falsa of [false, undefined, 'true', 1, null]) {
    const plan = JSON.parse(JSON.stringify(pf.plan));
    plan.confirmPermanentDelete = falsa;
    const r = await engine.run(plan);
    assert.equal(r.carpetas[0].resultado, 'original-sin-tocar', String(falsa));
    assert.equal(r.carpetas[0].motivoCodigo, 'sin-confirmacion');
    assert.deepEqual(snapshot(src), before);
  }
  // En modo copiar, confirmPermanentDelete no activa nada.
  const cp = await engine.preflight(copyOpts(src, dest, { disposal: 'borrar', confirmPermanentDelete: true }));
  assert.equal(cp.plan.disposal, 'ninguna');
  assert.equal(cp.plan.confirmPermanentDelete, false);
});

test('borrado definitivo: si el ORIGEN cambió después de verificar, no se borra', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(delOpts(src, dest));
  const r = await engine.run(pf.plan, { hooks: { afterVerify: async () => write(path.join(src, 'nuevo-importante.txt'), 'llegó después') } });
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'origen-cambio');
  assert.equal(fs.readFileSync(path.join(src, 'nuevo-importante.txt'), 'utf8'), 'llegó después');
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
});

for (const [nombre, alterar] of [
  ['un archivo desapareció', (f) => fs.unlinkSync(f)],
  ['un archivo cambió de tamaño', (f) => fs.appendFileSync(f, 'extra')],
  ['un archivo cambió de fecha', (f) => fs.utimesSync(f, new Date(2001, 1, 1), new Date(2001, 1, 1))],
  ['un archivo pasó a ser una carpeta', (f) => { fs.unlinkSync(f); fs.mkdirSync(f); }],
]) {
  test(`borrado definitivo: si la COPIA perdió integridad (${nombre}), no se borra el original`, async (t) => {
    const base = tmpDir(t);
    const src = makeSource(base);
    const dest = makeDest(base);
    const before = snapshot(src);
    const { engine } = makeEngine(base);
    const pf = await engine.preflight(delOpts(src, dest));
    const r = await engine.run(pf.plan, { hooks: { afterVerify: async () => alterar(findFile(dest, 'a.txt')) } });
    assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
    assert.equal(r.carpetas[0].motivoCodigo, 'copia-incompleta');
    assert.match(r.carpetas[0].motivo, /copia/);
    assert.deepEqual(snapshot(src), before, 'el original sigue entero');
  });
}

test('borrado definitivo: si la carpeta de la copia pasó a ser un enlace hacia el ORIGEN, no se borra (la "copia" sería el propio original)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(delOpts(src, dest));
  let ok = true;
  const r = await engine.run(pf.plan, {
    hooks: {
      afterVerify: async () => {
        const copia = path.dirname(findFile(dest, 'a.txt'));
        fs.renameSync(copia, `${copia}-movida`);
        try {
          fs.symlinkSync(src, copia, 'dir');
        } catch {
          ok = false;
          fs.renameSync(`${copia}-movida`, copia);
        }
      },
    },
  });
  if (!ok) {
    t.skip('No se pueden crear enlaces simbólicos aquí');
    return;
  }
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'copia-incompleta');
  assert.deepEqual(snapshot(src), before);
});

test('borrado definitivo: con enlaces en la carpeta no se borra (se copia, pero el original se queda)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const externo = path.join(base, 'externo');
  write(path.join(externo, 'secreto.txt'), 'ajeno');
  try {
    fs.symlinkSync(externo, path.join(src, 'enlace-a-carpeta'), 'dir');
  } catch (err) {
    t.skip(`No se pueden crear enlaces simbólicos aquí (${err.code})`);
    return;
  }
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(delOpts(src, dest));
  assert.deepEqual(pf.blockers, []);
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'con-enlaces');
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
  assert.ok(fs.existsSync(path.join(externo, 'secreto.txt')), 'lo ajeno no se tocó');
});

test('borrado definitivo: una carpeta que pasó a estar protegida no se borra', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  let protectedNow = false;
  const { engine } = makeEngine(base, { isProtected: (p) => protectedNow && p === src });
  const pf = await engine.preflight(delOpts(src, dest));
  protectedNow = true;
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'protegida');
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
});

test('borrado definitivo: si el origen se desvía por un enlace justo antes de borrar, no se borra nada', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const respaldo = `${src}-respaldo`;
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(delOpts(src, dest));
  let ok = true;
  const r = await engine.run(pf.plan, {
    hooks: {
      afterVerify: async () => {
        fs.renameSync(src, respaldo);
        try {
          fs.symlinkSync(respaldo, src, 'dir');
        } catch {
          ok = false;
          fs.renameSync(respaldo, src);
        }
      },
    },
  });
  if (!ok) {
    t.skip('No se pueden crear enlaces simbólicos aquí');
    return;
  }
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'origen-cambio');
  assert.ok(fs.existsSync(path.join(respaldo, 'a.txt')));
});

test('borrado definitivo: la copia con verificación rápida no basta (hace falta la completa)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const rapida = await engine.preflight(delOpts(src, dest, { verify: 'quick' }));
  assert.ok(codes(rapida.blockers).includes('mover-requiere-verificacion-completa'));
  // Un plan fabricado a mano con verificación rápida: el motor se niega a ejecutarlo.
  const pf = await engine.preflight(delOpts(src, dest));
  await assert.rejects(engine.run({ ...pf.plan, verify: 'quick' }), /verificación completa/);
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
});

test('borrado definitivo PARCIAL (fallo a mitad): informa exactamente qué se borró y qué no, y no reintenta', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { fs: sfs, calls } = spyFs({
    before: (name, args) => {
      if (name === 'rm') {
        fs.rmSync(path.join(args[0], 'sub'), { recursive: true }); // se alcanza a borrar esto…
        throw Object.assign(new Error('EBUSY: recurso ocupado'), { code: 'EBUSY' }); // …y entonces falla
      }
    },
  });
  const { engine, registry } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight(delOpts(src, dest));
  const planned = pf.plan.sources[0].entries.map((e) => e.rel).sort();
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'borrado-parcial');
  assert.equal(calls.filter((x) => x.name === 'rm').length, 1, 'no reintenta');
  assert.deepEqual([...c.borradoParcial.borrados].sort(), ['sub', 'sub/hondo', 'sub/hondo/x.bin', 'sub/y.txt']);
  assert.deepEqual([...c.borradoParcial.restantes].sort(), ['a.txt', 'canción.txt', 'cero.bin', 'vacia']);
  assert.deepEqual([...c.borradoParcial.borrados, ...c.borradoParcial.restantes].sort(), planned, 'cada elemento está en una lista u otra');
  assert.match(c.borradoParcial.error, /EBUSY/);
  assert.match(c.motivo, /No se reintentó/);
  // Lo que quedó está realmente ahí, y la copia está completa.
  assert.ok(fs.existsSync(path.join(src, 'a.txt')));
  assert.equal(fs.existsSync(path.join(src, 'sub')), false);
  assert.equal(snapshot(c.destino)['sub/hondo/x.bin'].type, 'file');
  assert.equal(r.estado, 'con-errores');
  assert.equal((await registry.get(c.registroId)).original.accion, 'borrado-parcial');
  // No se puede quitar la copia: es lo único que queda de lo borrado.
  await assert.rejects(engine.quitarCopiado(r), /ya se retiró/);
});

test('borrado definitivo: no sigue enlaces dentro del árbol que se borra (una vez que se borra, lo ajeno queda)', async (t) => {
  // Con enlaces el motor se niega antes de borrar; esta prueba confirma que el borrado en sí usa rm sin seguir enlaces.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'transfer.js'), 'utf8');
  assert.match(source, /async function deleteTree\(sourcePath\) \{\s*await fsp\.rm\(sourcePath, \{ recursive: true, force: false \}\);\s*\}/);
});

// ----------------------------------------------------------- Papelera que falla + eliminarDefinitivamente

async function papeleraFalla(t, { bigBytes = false, extra = {} } = {}) {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const attempts = [];
  const { engine, registry } = makeEngine(base, {
    trash: async (p) => {
      attempts.push(p);
      throw new Error('Windows rechazó enviar a la Papelera (E_ABORT)');
    },
    ...extra,
  });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  return { base, src, dest, before, engine, r, attempts, registry };
}

test('la Papelera que falla deja el original, con el código papelera-fallo y el mensaje original; y permite el borrado posterior', async (t) => {
  const { src, before, engine, r, attempts, dest, registry } = await papeleraFalla(t);
  const c = r.carpetas[0];
  assert.equal(c.resultado, 'original-sin-tocar');
  assert.equal(c.motivoCodigo, 'papelera-fallo');
  assert.match(c.motivo, /Windows rechazó enviar a la Papelera \(E_ABORT\)/);
  assert.equal(c.errorPapelera, 'Windows rechazó enviar a la Papelera (E_ABORT)');
  assert.equal(c.verificada, true);
  assert.deepEqual(attempts, [src]);
  assert.deepEqual(snapshot(src), before);
  // Sin confirmación no se hace nada.
  await assert.rejects(engine.eliminarDefinitivamente(r, [0], { confirm: false }), /confirmación/);
  await assert.rejects(engine.eliminarDefinitivamente(r, [0]), /confirmación/);
  assert.deepEqual(snapshot(src), before);
  // Con confirmación, el borrado definitivo ocurre.
  const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
  assert.equal(out.carpetas[0].resultado, 'original-borrado-definitivamente');
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(snapshot(r.carpetas[0].destino), before, 'la copia sigue idéntica');
  assert.equal(r.carpetas[0].resultado, 'original-borrado-definitivamente', 'el resultado se actualizó');
  assert.deepEqual((await registry.get(r.carpetas[0].registroId)).original, { accion: 'borrado-definitivo', motivo: null });
  // Una carpeta ya borrada no se puede borrar otra vez.
  await assert.rejects(engine.eliminarDefinitivamente(r, [0], { confirm: true }), /no se puede borrar así/);
  assert.ok(dest);
});

test('eliminarDefinitivamente rechaza índices inválidos y carpetas que no fallaron por la Papelera, sin tocar nada', async (t) => {
  const { src, before, engine, r } = await papeleraFalla(t);
  for (const malo of [[], [1], [-1], [1.5], ['0'], [0, 0], null, undefined, 'x', [null], [NaN], [0, 7]]) {
    await assert.rejects(engine.eliminarDefinitivamente(r, malo, { confirm: true }), Error, JSON.stringify(malo));
    assert.deepEqual(snapshot(src), before, JSON.stringify(malo));
  }
  await assert.rejects(engine.eliminarDefinitivamente({}, [0], { confirm: true }), /Resultado no válido/);
  await assert.rejects(engine.eliminarDefinitivamente(null, [0], { confirm: true }), /Resultado no válido/);
  await assert.rejects(engine.eliminarDefinitivamente({ ...r }, [0], { confirm: true }), /Resultado no válido/, 'una copia sin el estado interno del motor no sirve');

  // Una carpeta cuyo original se dejó a propósito ("ninguna") no es candidata.
  const base = tmpDir(t);
  const s2 = makeSource(base);
  const d2 = makeDest(base);
  const e2 = makeEngine(base).engine;
  const r2 = await e2.run((await e2.preflight(moveOpts(s2, d2, 'ninguna'))).plan);
  await assert.rejects(e2.eliminarDefinitivamente(r2, [0], { confirm: true }), /no se puede borrar así/);
  // Ni una copia (modo copiar).
  const r3 = await e2.run((await e2.preflight(copyOpts(s2, d2))).plan);
  await assert.rejects(e2.eliminarDefinitivamente(r3, [0], { confirm: true }), /no se puede borrar así/);
  assert.ok(fs.existsSync(path.join(s2, 'a.txt')));
});

test('eliminarDefinitivamente vuelve a comprobar TODO: origen cambiado, copia incompleta, enlaces, protegida o sin verificar', async (t) => {
  // Origen cambiado después del resultado.
  {
    const { src, engine, r } = await papeleraFalla(t);
    write(path.join(src, 'llegó-después.txt'), 'nuevo');
    const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
    assert.equal(out.carpetas[0].resultado, 'original-sin-tocar');
    assert.match(out.carpetas[0].motivo, /cambió/);
    assert.ok(fs.existsSync(path.join(src, 'llegó-después.txt')));
  }
  // Copia incompleta.
  {
    const { src, dest, engine, r, before } = await papeleraFalla(t);
    fs.unlinkSync(findFile(dest, 'a.txt'));
    const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
    assert.equal(out.carpetas[0].resultado, 'original-sin-tocar');
    assert.match(out.carpetas[0].motivo, /copia/);
    assert.deepEqual(snapshot(src), before);
  }
  // Enlace nuevo en el origen.
  {
    const { src, base, engine, r, before } = await papeleraFalla(t);
    try {
      fs.symlinkSync(path.join(base, 'destino'), path.join(src, 'trampa'), 'dir');
      const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
      assert.equal(out.carpetas[0].resultado, 'original-sin-tocar');
      assert.ok(fs.existsSync(path.join(src, 'a.txt')));
      assert.notDeepEqual(snapshot(src), before);
    } catch (err) {
      if (!/EPERM|EACCES|ENOSYS/.test(String(err.code))) throw err;
    }
  }
  // Pasó a estar protegida.
  {
    const flag = { on: false };
    const { src, engine, r } = await papeleraFalla(t, { extra: { isProtected: (p) => flag.on && path.basename(p) === 'Datos ñandú 🐕 con espacios' } });
    flag.on = true;
    const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
    assert.equal(out.carpetas[0].resultado, 'original-sin-tocar');
    assert.match(out.carpetas[0].motivo, /protegida/);
    assert.ok(fs.existsSync(path.join(src, 'a.txt')));
  }
  // Marcada como no verificada (un resultado manipulado).
  {
    const { src, engine, r, before } = await papeleraFalla(t);
    r.carpetas[0].verificada = false;
    const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
    assert.equal(out.carpetas[0].resultado, 'original-sin-tocar');
    assert.match(out.carpetas[0].motivo, /verificada/);
    assert.deepEqual(snapshot(src), before);
  }
});

test('"papelera-no-cabe": si la estimación decía que no cabía y la Papelera falla, el borrado posterior también es posible', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const probe = (await makeEngine(base).engine.preflight(copyOpts(src, dest))).plan.totals.bytes;
  const { engine } = makeEngine(base, {
    volumeInfo: async (p) => (p === dest ? { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 5e11 } : { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: probe * 10, freeBytes: 1 }),
    trash: async () => {
      throw new Error('no cabe');
    },
  });
  const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].motivoCodigo, 'papelera-no-cabe');
  const out = await engine.eliminarDefinitivamente(r, [0], { confirm: true });
  assert.equal(out.carpetas[0].resultado, 'original-borrado-definitivamente');
  assert.equal(fs.existsSync(src), false);
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
  assert.match(r.carpetas[0].motivo, /protegida por el sistema \(se volvió a comprobar antes de retirarla\)/, 'lo decide la guarda explícita de protección');
  assert.deepEqual(trashed, []);
});

// ============================================================ quitarCopiado y verifyBatch

test('quitarCopiado: quita SOLO lo que creó esta operación y deja lo ajeno', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  write(path.join(dest, 'foto-del-usuario.jpg'), 'mis fotos');
  const before = snapshot(src);
  const { engine, registry } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan);
  const c = r.carpetas[0];
  // Un archivo ajeno que aparece DENTRO de la copia: no es nuestro.
  write(path.join(c.destino, 'sub', 'ajeno.txt'), 'no lo creó BoneYardDog');

  const report = await engine.quitarCopiado(r);
  assert.ok(report.quitados > 0);
  assert.equal(fs.readFileSync(path.join(dest, 'foto-del-usuario.jpg'), 'utf8'), 'mis fotos');
  assert.equal(fs.readFileSync(path.join(c.destino, 'sub', 'ajeno.txt'), 'utf8'), 'no lo creó BoneYardDog', 'lo ajeno se queda');
  assert.ok(report.omitidos.some((o) => o.motivo === 'no-esta-vacia'));
  assert.equal(fs.existsSync(path.join(c.destino, 'a.txt')), false, 'lo propio se quitó');
  assert.deepEqual(snapshot(src), before, 'el origen intacto');
  assert.notEqual(c.resultado, 'copia-quitada', 'sigue como estaba porque no se pudo quitar todo');
  assert.ok(await registry.get(c.registroId), 'si no se quitó todo, el registro se conserva');
});

test('quitarCopiado: una copia completa y limpia se quita por entero, y su registro también', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { engine, registry } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const c = r.carpetas[0];
  const report = await engine.quitarCopiado(r);
  assert.deepEqual(report.omitidos, []);
  assert.equal(c.resultado, 'copia-quitada');
  assert.deepEqual(fs.readdirSync(dest), [], 'no queda ni la carpeta');
  assert.deepEqual(snapshot(src), before);
  assert.equal(await registry.get(c.registroId), null);
});

test('quitarCopiado: no sigue enlaces y no sale de la carpeta copiada', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const externo = path.join(base, 'externo');
  write(path.join(externo, 'importante.txt'), 'importante');
  write(path.join(dest, 'foto.jpg'), 'foto');
  const { engine } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const c = r.carpetas[0];
  // Un enlace colocado DENTRO de la copia, hacia fuera: la limpieza no lo sigue.
  let linked = true;
  try {
    fs.symlinkSync(externo, path.join(c.destino, 'enlace'), 'dir');
  } catch {
    linked = false;
  }
  // Lista de lo creado manipulada: entradas que intentan salir de la copia o pasar por el enlace.
  const ctx = r._interno.ctxs[0];
  ctx.created.push({ rel: '../foto.jpg', type: 'file' }, { rel: '../../otro', type: 'dir' });
  if (linked) ctx.created.push({ rel: 'enlace/importante.txt', type: 'file' }, { rel: 'enlace', type: 'dir' });
  const report = await engine.quitarCopiado(r);
  assert.equal(fs.readFileSync(path.join(externo, 'importante.txt'), 'utf8'), 'importante', 'ni siquiera a través de una carpeta-enlace dentro de la copia');
  assert.equal(fs.readFileSync(path.join(dest, 'foto.jpg'), 'utf8'), 'foto', 'lo de fuera de la copia no se toca');
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

test('verifyRecord: copia íntegra, luego detecta un archivo alterado, uno faltante y uno sobrante', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, registry } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const copy = r.carpetas[0].destino;
  const rec = await registry.get(r.carpetas[0].registroId);

  const ok = await engine.verifyRecord(rec);
  assert.equal(ok.estado, 'ok');
  assert.equal(ok.verificados, 5);
  assert.deepEqual(ok.problemas, []);

  // Alterado (mismo tamaño y fecha): solo la huella lo delata.
  const altered = path.join(copy, 'a.txt');
  const st = fs.statSync(altered);
  fs.writeFileSync(altered, 'HOLA MUNDO');
  fs.utimesSync(altered, st.atime, st.mtime);
  fs.unlinkSync(path.join(copy, 'sub', 'y.txt'));
  write(path.join(copy, 'sobrante.txt'), 'extra');
  const bad = await engine.verifyRecord(rec);
  assert.equal(bad.estado, 'problemas');
  const byFile = Object.fromEntries(bad.problemas.map((p) => [p.ruta.split('/').slice(-1)[0], p.problema]));
  assert.equal(byFile['a.txt'], 'huella');
  assert.equal(byFile['y.txt'], 'falta');
  assert.equal(byFile['sobrante.txt'], 'sobrante');

  // El modo rápido (tamaño y fecha) no ve la alteración de a.txt pero sí lo que falta.
  const quick = await engine.verifyRecord(rec, { mode: 'quick' });
  assert.ok(!quick.problemas.some((p) => p.ruta.endsWith('a.txt')));
  assert.ok(quick.problemas.some((p) => p.problema === 'falta'));
});

test('verifyRecord: NUNCA dice «bien» si no revisó ningún archivo, y distingue disco desconectado y carpeta distinta', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, registry } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const rec = await registry.get(r.carpetas[0].registroId);

  // Un registro sin archivos (copia interrumpida, registro vacío): NO es «bien».
  const vacio = await engine.verifyRecord({ ...rec, archivos: [], carpetasVacias: [] });
  assert.equal(vacio.verificados, 0);
  assert.notEqual(vacio.estado, 'ok');
  assert.equal(vacio.estado, 'problemas', 'la carpeta tiene archivos que el registro no conoce: sobrantes');
  const vacioDeVerdad = path.join(dest, 'vacia-de-verdad');
  fs.mkdirSync(vacioDeVerdad);
  const sinArchivos = await engine.verifyRecord({ ...rec, destino: vacioDeVerdad, archivos: [], carpetasVacias: [] });
  assert.equal(sinArchivos.estado, 'sin-archivos');
  assert.match(sinArchivos.motivo, /No había archivos que comprobar/);

  // Disco desconectado / carpeta que ya no está.
  const gone = await engine.verifyRecord({ ...rec, destino: path.join(dest, 'no-esta') });
  assert.equal(gone.estado, 'no-disponible');
  assert.match(gone.motivo, /No encuentro esa carpeta: conecta el disco/);
  assert.equal(gone.verificados, 0);
  // Es un archivo en vez de una carpeta.
  fs.writeFileSync(path.join(dest, 'archivo.txt'), 'x');
  assert.equal((await engine.verifyRecord({ ...rec, destino: path.join(dest, 'archivo.txt') })).estado, 'distinta');
  // Registro mal formado.
  await assert.rejects(() => engine.verifyRecord(null), /no es válido/);
  await assert.rejects(() => engine.verifyRecord({ destino: 5, archivos: [] }), /no es válido/);
});

test('verifyRecord: rutas del registro que intentan salir de la copia no se siguen', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, registry } = makeEngine(base);
  const r = await engine.run((await engine.preflight(copyOpts(src, dest))).plan);
  const rec = await registry.get(r.carpetas[0].registroId);
  write(path.join(base, 'secreto-fuera.txt'), 'fuera de la copia');
  const forged = { ...rec, archivos: [...rec.archivos, { ruta: '../../../../secreto-fuera.txt', tamano: 1, mtimeMs: 0, sha256: 'x'.repeat(64) }, { ruta: '/etc/passwd', tamano: 1, mtimeMs: 0, sha256: null }, { ruta: 'C:\\Windows\\win.ini', tamano: 1, mtimeMs: 0, sha256: null }] };
  const res = await engine.verifyRecord(forged);
  assert.equal(res.estado, 'problemas');
  assert.equal(res.problemas.filter((p) => p.problema === 'ruta-no-valida').length, 3, 'ninguna ruta peligrosa se sigue');
});

// ============================================= la regla de oro, revisada en el código fuente

test('REGLA DE ORO (código fuente): las únicas eliminaciones están en las funciones permitidas, y solo tras verificar', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'transfer.js'), 'utf8');
  const lines = source.split('\n');
  const enclosing = (index) => {
    for (let i = index; i >= 0; i--) {
      const m = /^\s{2}(?:async )?function (\w+)\(/.exec(lines[i]);
      if (m) return m[1];
    }
    return null;
  };
  const allowed = { removeOwn: ['unlink'], removeCreatedEntry: ['unlink', 'rmdir'], trashOriginal: ['trash'], deleteTree: ['rm'], removePendingWork: ['rm'], renameToFinal: ['rename'], preflight: ['unlink'] };
  const found = [];
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comentarios
    for (const m of line.matchAll(/\b(?:fsp|fs|promises)\.(unlink|rm|rmdir|rename|truncate|rmSync|unlinkSync|renameSync|rmdirSync|cp|cpSync)\(|\bawait trash\(/g)) {
      found.push({ fn: enclosing(i), kind: m[1] || 'trash', line: i + 1 });
    }
  });
  assert.ok(found.length >= 5, 'la revisión encontró las llamadas esperadas');
  for (const f of found) assert.ok((allowed[f.fn] || []).includes(f.kind), `${f.kind} en ${f.fn} (línea ${f.line}) no está permitido`);
  // El ÚNICO cambio de nombre es la carpeta provisional → su nombre final, y nunca toca el origen (sin cuarentena).
  const renames = found.filter((f) => f.kind === 'rename');
  assert.equal(renames.length, 1);
  assert.match(lines[renames[0].line - 1], /fsp\.rename\(workPath, finalPath\)/);
  assert.doesNotMatch(source, /\.renameSync/);
  // …y renameToFinal comprueba antes que el nombre final NO existe (nunca sobrescribe).
  assert.match(source, /async function renameToFinal\(workPath, finalPath\) \{\s*const exists = await fsp\.lstat\(finalPath\)[\s\S]*?if \(exists\) return \{ ok: false[\s\S]*?fsp\.rename\(workPath, finalPath\)/);
  // Solo se llama tras copiar Y verificar todo (sin errores) y en `run`.
  const renameCall = source.indexOf('await renameToFinal(workPath, finalPath)');
  assert.ok(renameCall > 0);
  assert.ok(source.lastIndexOf('if (errores.length > 0) {', renameCall) > source.lastIndexOf('const live = await walk(workPath', renameCall), 'el renombrado va después de la comparación final y solo si no hay errores');
  // preflight solo puede borrar su propia sonda.
  const probeLines = found.filter((f) => f.fn === 'preflight');
  assert.equal(probeLines.length, 1);
  assert.match(lines[probeLines[0].line - 1], /unlink\(probePath\)/);
  // Solo dos borrados recursivos, ambos con force:false (no siguen enlaces ni callan si algo falta): el del ORIGEN (tras todas las
  // comprobaciones) y el de una carpeta «….copiando» de una sesión anterior que el diario de la app anotó.
  const rms = found.filter((f) => f.kind === 'rm');
  assert.deepEqual(rms.map((f) => f.fn).sort(), ['deleteTree', 'removePendingWork']);
  assert.match(lines[rms.find((f) => f.fn === 'deleteTree').line - 1], /fsp\.rm\(sourcePath, \{ recursive: true, force: false \}\)/);
  assert.match(lines[rms.find((f) => f.fn === 'removePendingWork').line - 1], /fsp\.rm\(ruta, \{ recursive: true, force: false \}\)/);
  const pending = source.slice(source.indexOf('async function removePendingWork'), source.indexOf("await fsp.rm(ruta,"));
  for (const needle of ['WORK_RE.test(nodePath.basename(ruta))', 'entry.ruta !== ruta', 'isSymbolicLink()', 'realpath(entry.raiz)', 'isProtectedDest(ruta)']) assert.ok(pending.includes(needle), `removePendingWork debe comprobar ${needle}`);
  assert.doesNotMatch(source, /\brimraf\b|force:\s*true|rmSync|fs-extra|trash-cli/);
  // Cada eliminación de lo propio pasa por una comprobación "dentro de mi carpeta".
  assert.match(source, /async function removeOwn[\s\S]*?strictlyInside\(filePath, batchFolder\)/);
  assert.match(source, /async function removeCreatedEntry[\s\S]*?strictlyInside\(p, container\)/);

  // El borrado definitivo: deleteTree solo se llama desde permanentlyDelete, DESPUÉS de todas las comprobaciones.
  const calls = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\bawait deleteTree\(/.test(l));
  assert.equal(calls.length, 1);
  assert.equal(enclosing(calls[0].i), 'permanentlyDelete');
  const fn = source.slice(source.indexOf('async function permanentlyDelete'), source.indexOf('await deleteTree('));
  const order = ['confirm !== true', "verified !== true || verify !== 'full'", 'folder.links.length', 'isProtected(folder.source)', 'sourceChangeReason(folder)', 'copyProblem(folder, destBase, destRoot, fsName)'];
  let at = -1;
  for (const needle of order) {
    const idx = fn.indexOf(needle);
    assert.ok(idx > at, `permanentlyDelete debe comprobar «${needle}» antes de borrar, y en este orden`);
    at = idx;
  }
  // permanentlyDelete solo se invoca desde run y eliminarDefinitivamente.
  for (const { l, i } of lines.map((l, i) => ({ l, i }))) {
    if (/\bawait permanentlyDelete\(/.test(l)) assert.ok(['runBody', 'eliminarDefinitivamente'].includes(enclosing(i)), `permanentlyDelete llamada desde ${enclosing(i)}`);
  }

  // La Papelera: una sola llamada, desde run, después de verificar y de volver a comprobar el origen.
  const trashCalls = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\bawait trashOriginal\(/.test(l));
  assert.equal(trashCalls.length, 1);
  assert.equal(enclosing(trashCalls[0].i), 'runBody');
  const dispose = source.indexOf('await trashOriginal(folder.source)');
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
  assert.ok(r.carpetas[0].destino.startsWith(fs.realpathSync(real) + path.sep), 'se escribió en la carpeta real');
  assert.deepEqual(snapshot(r.carpetas[0].destino), before);
  assert.equal(r.destinoRaiz, fs.realpathSync(real));
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

// ====================================== destino: la raíz de una unidad es válida (Fase 5, Parte 1)

test('destino: la raíz de una unidad y sus carpetas valen; C:\\ (sistema), Windows, Users, usuario y $Recycle.Bin se bloquean con un mensaje que dice por qué', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const sys = { SystemDrive: 'C:' };
  // Con las reglas reales y rutas de otra unidad: el motor solo bloquea lo que corresponde.
  const { engine } = makeEngine(base, { env: sys, isProtected: undefined });
  for (const bad of ['C:\\', 'C:\\Windows\\x', 'C:\\Users\\amir', 'D:\\$Recycle.Bin']) {
    const pf = await engine.preflight(copyOpts(src, bad));
    const b = pf.blockers.find((x) => x.code === 'destino-protegido');
    assert.ok(b, bad);
    assert.ok(b.message.includes(bad.replace(/\\$/, '')) || b.message.startsWith('C:\\'), `${bad}: ${b.message}`);
    assert.doesNotMatch(b.message, /^El destino está en una carpeta protegida del sistema\.$/);
    assert.equal(pf.plan, null);
  }
  // La raíz (simulada con la carpeta de pruebas como «unidad») y subcarpetas no se bloquean por protección.
  const protectedOnlyC = makeEngine(base, { env: sys, isProtectedDestination: (p) => /^C:\\/i.test(p) && !/^C:\\Copias/i.test(p) });
  const pf = await protectedOnlyC.engine.preflight(copyOpts(src, dest));
  assert.ok(!codes(pf.blockers).includes('destino-protegido'));
});

test('destino: un enlace hacia una zona protegida se bloquea con la ruta real en el mensaje', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const prot = path.join(base, 'zona-protegida');
  fs.mkdirSync(prot);
  const enlace = path.join(base, 'atajo');
  if (!linkOrSkip(t, prot, enlace)) return;
  const { engine } = makeEngine(base, { isProtectedDestination: (p) => p === prot || p.startsWith(prot + path.sep) });
  const pf = await engine.preflight(copyOpts(src, enlace));
  const b = pf.blockers.find((x) => x.code === 'destino-protegido');
  assert.ok(b);
  assert.equal(b.rutaReal, prot);
  assert.ok(b.message.includes(enlace) && b.message.includes(prot), b.message);
});
