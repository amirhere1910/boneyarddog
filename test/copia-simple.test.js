'use strict';

// Copia simple (Fase 5): <destino>\<nombre>, sin archivos extra, a través de una carpeta provisional «.copiando».

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const H = require('../test-support/transfer-helpers');
const { fs, path, tmpDir, write, snapshot, makeSource, spyFs, makeEngine, makeDest, DESTRUCTIVE, isInside } = H;
const { pickNames, WORK_RE } = require('../src/core/transfer');

const copyOpts = (src, dest, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full', ...extra });
const moveOpts = (src, dest, disposal, extra = {}) => ({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal, ...extra });
const codes = (list) => list.map((b) => b.code);

// Copia un árbol conservando las fechas. (No se usa fs.cpSync: en Windows con Node 22 el proceso se cae de golpe, código 0xC0000409.)
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const n of fs.readdirSync(from)) {
    const a = path.join(from, n);
    const b = path.join(to, n);
    const st = fs.lstatSync(a);
    if (st.isDirectory()) copyTree(a, b);
    else {
      fs.copyFileSync(a, b);
      fs.utimesSync(b, st.atime, st.mtime);
    }
  }
  const d = fs.lstatSync(from);
  fs.utimesSync(to, d.atime, d.mtime);
}

test('pickNames: «Fotos», «Fotos (2)», «Fotos (3)»…, nunca repite y compara sin distinguir mayúsculas', () => {
  const taken = new Set();
  assert.deepEqual(pickNames('Fotos', taken), { finalName: 'Fotos', workName: 'Fotos.copiando', renamed: false });
  assert.deepEqual(pickNames('Fotos', taken), { finalName: 'Fotos (2)', workName: 'Fotos (2).copiando', renamed: true });
  assert.equal(pickNames('FOTOS', taken).finalName, 'FOTOS (3)', 'en Windows «FOTOS» y «Fotos» son lo mismo');
  const t2 = new Set(['x', 'x (2)', 'x.copiando']);
  assert.deepEqual(pickNames('x', t2), { finalName: 'x (3)', workName: 'x (3).copiando', renamed: true });
  const t3 = new Set(['y.copiando']); // una provisional vieja con el mismo nombre: la nueva toma otro número
  assert.equal(pickNames('y', t3).workName, 'y.copiando (2)');
  for (const ok of ['Fotos.copiando', 'Fotos (2).copiando', 'Fotos.copiando (2)', 'a.COPIANDO']) assert.ok(WORK_RE.test(ok), ok);
  for (const no of ['Fotos', 'Fotos.copiando.txt', 'copiando', 'Fotos.copia']) assert.equal(WORK_RE.test(no), false, no);
});

test('copia tal cual: «<destino>\\<carpeta>» idéntica, sin archivos extra, con fechas conservadas, y durante la copia solo existe «….copiando»', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const name = path.basename(src);
  const seen = [];
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  const r = await engine.run(pf.plan, { hooks: { beforeFile: () => seen.push(fs.readdirSync(dest).sort()) } });
  assert.ok(seen.length > 0);
  for (const listing of seen) assert.deepEqual(listing, [`${name}.copiando`], 'mientras se copia NO existe la carpeta final: una copia a medias nunca parece buena');
  assert.deepEqual(fs.readdirSync(dest), [name]);
  assert.deepEqual(snapshot(path.join(dest, name)), before);
  assert.equal(r.carpetas[0].resultado, 'copiada-verificada');
  assert.equal(r.carpetas[0].destino, path.join(fs.realpathSync(dest), name));
  assert.ok(Math.abs(fs.statSync(path.join(dest, name)).mtimeMs - fs.statSync(src).mtimeMs) <= 2, 'la fecha de la carpeta se conserva');
  assert.equal(fs.existsSync(path.join(dest, name, 'ESTADO.json')), false);
});

test('corte a mitad (proceso que muere tras N archivos): queda «X.copiando», NUNCA «X»', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const name = path.basename(src);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'test-support', 'crash-run.js'), src, dest, '2'], { encoding: 'utf8' });
  assert.equal(r.status, 9, r.stderr);
  assert.deepEqual(fs.readdirSync(dest), [`${name}.copiando`]);
  assert.equal(fs.existsSync(path.join(dest, name)), false);
  assert.ok(fs.readdirSync(path.join(dest, `${name}.copiando`)).length > 0, 'hay una copia parcial, pero con nombre de «copiando»');
  assert.equal(fs.existsSync(path.join(base, 'termino-sin-caerse.txt')), false);
  assert.ok(fs.existsSync(path.join(src, 'a.txt')), 'el original intacto');
});

test('el renombrado final NO sobrescribe: si «X» apareció mientras tanto (aunque sea una carpeta vacía), la copia queda verificada como «X.copiando»', async (t) => {
  for (const contenido of ['vacia', 'con-cosas']) {
    const base = tmpDir(t);
    const src = makeSource(base);
    const dest = makeDest(base);
    const name = path.basename(src);
    const { engine, trashed } = makeEngine(base);
    const pf = await engine.preflight(moveOpts(src, dest, 'papelera'));
    const r = await engine.run(pf.plan, {
      hooks: {
        beforeRename: ({ finalPath }) => {
          fs.mkdirSync(finalPath);
          if (contenido === 'con-cosas') fs.writeFileSync(path.join(finalPath, 'mio.txt'), 'del usuario');
        },
      },
    });
    const c = r.carpetas[0];
    assert.equal(c.resultado, 'con-errores', contenido);
    assert.equal(c.motivoCodigo, 'nombre-ocupado');
    assert.match(c.motivo, new RegExp(`«${name}» apareció en el destino mientras tanto y no se sobrescribe. Se dejó como «${name}\\.copiando»`));
    assert.deepEqual(trashed, [], 'el original NO se retiró');
    assert.ok(fs.existsSync(path.join(src, 'a.txt')));
    // Lo que apareció sigue como estaba (no se reemplazó) y la copia verificada se conserva aparte.
    assert.deepEqual(fs.readdirSync(path.join(dest, name)), contenido === 'vacia' ? [] : ['mio.txt']);
    assert.deepEqual(snapshot(path.join(dest, `${name}.copiando`)), snapshot(src));
    assert.deepEqual(c.limpieza.pendientes, [path.join(fs.realpathSync(dest), `${name}.copiando`)]);
  }
});

test('copiar o transferir con errores en una carpeta: se quita la copia incompleta y el original no se toca; las demás carpetas siguen', async (t) => {
  const base = tmpDir(t);
  const bueno = path.join(base, 'uno', 'Bueno');
  const malo = path.join(base, 'dos', 'Malo');
  write(path.join(bueno, 'ok.txt'), 'todo bien');
  write(path.join(malo, 'roto.txt'), 'este falla');
  write(path.join(malo, 'otro.txt'), 'este no');
  const dest = makeDest(base);
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (name === 'open' && args[1] === 'r' && args[0].endsWith('roto.txt')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  const { engine, trashed } = makeEngine(base, { fs: sfs });
  const pf = await engine.preflight({ sources: [bueno, malo], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  const r = await engine.run(pf.plan);
  assert.equal(r.carpetas[0].resultado, 'original-enviado-a-papelera');
  assert.equal(r.carpetas[1].resultado, 'con-errores');
  assert.equal(r.carpetas[1].limpieza.limpia, true);
  assert.deepEqual(trashed, [bueno]);
  assert.deepEqual(fs.readdirSync(dest), ['Bueno'], 'de «Malo» no queda nada en el destino');
  assert.ok(fs.existsSync(path.join(malo, 'roto.txt')));
});

test('ninguna eliminación fuera de la carpeta «.copiando» propia: espías sobre fs al cancelar y al fallar', async (t) => {
  for (const modo of ['cancelar', 'fallar']) {
    const base = tmpDir(t);
    const src = makeSource(base, { big: true });
    const dest = makeDest(base);
    write(path.join(dest, 'ajeno', 'dato.txt'), 'del usuario'); // algo ajeno en el destino: no se toca
    const work = `${path.basename(src)}.copiando`;
    const controller = new AbortController();
    const { fs: sfs, calls } = spyFs({
      before: (name, args) => {
        if (modo === 'fallar' && name === 'open' && args[1] === 'wx' && args[0].endsWith('y.txt')) throw Object.assign(new Error('EIO simulado'), { code: 'EACCES' });
      },
    });
    const { engine } = makeEngine(base, { fs: sfs });
    const pf = await engine.preflight(copyOpts(src, dest));
    const r = await engine.run(pf.plan, {
      signal: controller.signal,
      progressIntervalMs: 0,
      onProgress: (e) => {
        if (modo === 'cancelar' && e.fase === 'copiando' && e.archivo.endsWith('grande.bin') && e.bytesDone > 0) controller.abort();
      },
    });
    assert.notEqual(r.estado, 'completo');
    const destructive = calls.filter((c) => DESTRUCTIVE.has(c.name));
    assert.ok(destructive.length > 0);
    for (const c of destructive) {
      const target = String(c.args[0]);
      const probe = path.basename(target).startsWith('.byd-sonda-');
      assert.ok(probe || isInside(target, path.join(fs.realpathSync(dest), work)) || isInside(target, path.join(dest, work)), `${modo}: ${c.name} fuera de la carpeta provisional: ${target}`);
      assert.equal(isInside(target, src), false, `${modo}: tocó el origen`);
    }
    assert.deepEqual(fs.readdirSync(dest), ['ajeno'], `${modo}: el destino quedó como estaba`);
    assert.equal(fs.readFileSync(path.join(dest, 'ajeno', 'dato.txt'), 'utf8'), 'del usuario');
  }
});

test('desconexión del disco: se detiene, no toca el original y, si no puede limpiar, dice QUÉ carpeta quedó y qué hacer', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  let dead = false;
  const { fs: sfs } = spyFs({
    before: (name, args) => {
      if (dead && ['unlink', 'rmdir', 'readdir', 'lstat', 'realpath'].includes(name) && String(args[0]).startsWith(dest)) throw Object.assign(new Error('EIO: el disco ya no está'), { code: 'EIO' });
    },
    wrapHandle: (handle, args) => {
      if (args[1] !== 'wx' || String(args[0]).includes('.byd-sonda')) return handle;
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === 'write') {
            return async () => {
              dead = true;
              throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
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
  assert.equal(r.estado, 'con-errores');
  assert.ok(r.abortada);
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
  assert.equal(c.limpieza.limpia, false);
  const name = path.basename(src);
  assert.equal(c.motivo, `El disco se desconectó o dejó de responder. Los originales no se tocaron. Vuelve a conectarlo y revisa si quedó una carpeta «${name}.copiando» para borrarla.`);
  assert.deepEqual(c.limpieza.pendientes, [path.join(fs.realpathSync(dest), `${name}.copiando`)]);
});

test('registro y diario: se anota la carpeta provisional al crearla y se quita al terminar o limpiar', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { engine, registry } = makeEngine(base);
  const pf = await engine.preflight(copyOpts(src, dest));
  let durante = null;
  await engine.run(pf.plan, { hooks: { beforeFile: async () => (durante = durante || (await registry.listPending())) } });
  assert.equal(durante.length, 1);
  assert.equal(durante[0].ruta, path.join(fs.realpathSync(dest), `${path.basename(src)}.copiando`));
  assert.equal(durante[0].raiz, fs.realpathSync(dest));
  assert.deepEqual(await registry.listPending(), [], 'al terminar bien, el diario queda vacío');
});

test('removePendingWork: solo borra «….copiando» anotadas en el diario, reales, dentro de su raíz y no protegidas', async (t) => {
  const base = tmpDir(t);
  const dest = makeDest(base);
  const { engine } = makeEngine(base);
  const realDest = fs.realpathSync(dest);
  const mk = (n) => {
    const d = path.join(realDest, n);
    write(path.join(d, 'sub', 'x.bin'), 'datos');
    return d;
  };
  const work = mk('Fotos.copiando');
  const entry = { ruta: work, raiz: realDest, creada: 'hoy' };
  // Rechazos: nombre que no es provisional, entrada que no coincide, raíz distinta, enlace.
  const normal = mk('Fotos');
  await assert.rejects(engine.removePendingWork(normal, { ...entry, ruta: normal }), /no es una copia incompleta/);
  await assert.rejects(engine.removePendingWork(work, { ...entry, ruta: path.join(realDest, 'Otra.copiando') }), /no es una copia incompleta/);
  await assert.rejects(engine.removePendingWork(work, { ...entry, raiz: base }), /no está donde la anotó/);
  await assert.rejects(engine.removePendingWork(work, null), /no es una copia incompleta/);
  await assert.rejects(engine.removePendingWork(work, undefined), /no es una copia incompleta/);
  assert.ok(fs.existsSync(path.join(work, 'sub', 'x.bin')), 'nada se borró en los rechazos');
  assert.ok(fs.existsSync(path.join(normal, 'sub', 'x.bin')));
  const enlace = path.join(realDest, 'Trampa.copiando');
  try {
    fs.symlinkSync(normal, enlace, 'dir');
    await assert.rejects(engine.removePendingWork(enlace, { ruta: enlace, raiz: realDest, creada: 'hoy' }), /no es una carpeta normal/);
    assert.ok(fs.existsSync(path.join(normal, 'sub', 'x.bin')), 'a través del enlace no se tocó lo de verdad');
    fs.unlinkSync(enlace);
  } catch (err) {
    if (!/EPERM|EACCES/.test(String(err.code))) throw err;
  }
  // Caso bueno.
  assert.deepEqual(await engine.removePendingWork(work, entry), { estado: 'quitada' });
  assert.equal(fs.existsSync(work), false);
  assert.ok(fs.existsSync(normal), 'la carpeta con nombre normal sigue');
  assert.deepEqual(await engine.removePendingWork(work, entry), { estado: 'ya-no-esta' });
});

test('borrado definitivo: si la «copia» pasó a ser un enlace hacia OTRO sitio (no el origen), tampoco se borra: la copia debe estar DENTRO del destino elegido', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const otro = path.join(base, 'respaldo-en-otro-sitio');
  const name = path.basename(src);
  const { engine } = makeEngine(base);
  const pf = await engine.preflight(moveOpts(src, dest, 'borrar', { confirmPermanentDelete: true }));
  let ok = true;
  const r = await engine.run(pf.plan, {
    hooks: {
      afterVerify: async () => {
        // Una copia idéntica en otra parte, y la carpeta del destino reemplazada por un enlace hacia ella.
        copyTree(path.join(dest, name), otro);
        fs.rmSync(path.join(dest, name), { recursive: true });
        try {
          fs.symlinkSync(otro, path.join(dest, name), 'dir');
        } catch {
          ok = false;
          copyTree(otro, path.join(dest, name));
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
  assert.ok(fs.existsSync(path.join(src, 'a.txt')), 'el original sigue');
});
