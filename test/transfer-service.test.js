'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const v8 = require('node:v8');
const { Worker } = require('node:worker_threads');
const { fs, path, tmpDir, write, snapshot, makeSource, makeDest } = require('../test-support/transfer-helpers');
const { TransferService } = require('../src/service/transfer-service');

const WORKER = path.join(__dirname, '..', 'src', 'service', 'transfer-worker.js');

function newService(t, options = {}) {
  const trashed = [];
  const svc = new TransferService({
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    },
    registryDir: require('node:path').join(tmpDir(t, 'reg-'), 'registros'),
    ...options,
  });
  t.after(() => svc.close());
  return { svc, trashed };
}

test('servicio: preflight devuelve un planId (el plan se queda en el hilo) y run solo acepta ese planId, una vez', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t);
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  assert.deepEqual(pf.blockers, []);
  assert.match(pf.planId, /^[0-9a-f]{16}$/);
  assert.equal(pf.plan.totals.files, 5);
  assert.equal(pf.plan.sources[0].source, src);
  assert.equal(pf.plan.sources[0].entries, undefined, 'el listado de elementos no sale del hilo');

  await assert.rejects(() => svc.run('0000000000000000'), { code: 'PLAN_DESCONOCIDO' });
  await assert.rejects(() => svc.run({ sources: [src] }), { code: 'PLAN_DESCONOCIDO' }, 'un plan armado a mano no sirve');
  const r = await svc.run(pf.planId);
  assert.equal(r.estado, 'completo');
  assert.equal(r.carpetas[0].resultado, 'copiada-verificada');
  assert.match(r.runId, /^[0-9a-f]{16}$/);
  assert.equal(r.created, undefined, 'la lista de lo creado tampoco sale');
  await assert.rejects(() => svc.run(pf.planId), { code: 'PLAN_DESCONOCIDO' }, 'un plan se ejecuta una sola vez');
});

test('servicio: con impedimentos no hay planId', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const { svc } = newService(t);
  const pf = await svc.preflight({ sources: [src], destinationRoot: path.join(base, 'no-existe'), mode: 'copy' });
  assert.equal(pf.planId, null);
  assert.equal(pf.plan, null);
  assert.ok(pf.blockers.length > 0);
});

test('servicio: la Papelera se atiende desde el otro hilo (trash inyectada) y el original desaparece', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { svc, trashed } = newService(t);
  const pf2 = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  // Fuera de Windows el worker no sabe el tipo de disco: es un aviso (no un impedimento) y la operación sigue.
  assert.deepEqual(pf2.blockers, []);
  if (process.platform !== 'win32') assert.ok(pf2.warnings.some((w) => w.code === 'papelera-desconocida'));
  const r = await svc.run(pf2.planId);
  assert.equal(r.carpetas[0].resultado, 'original-enviado-a-papelera');
  assert.deepEqual(trashed, [src]);
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(snapshot(r.carpetas[0].destino), before);
});

test('servicio: si la Papelera falla, el original queda y se informa', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { svc } = newService(t, {
    trash: async () => {
      throw new Error('Papelera no disponible');
    },
  });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  const r = await svc.run(pf.planId);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.match(r.carpetas[0].motivo, /Papelera no disponible/);
  assert.deepEqual(snapshot(src), before);
});

test('servicio: sin función de Papelera, "papelera" es un impedimento', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const svc = new TransferService();
  t.after(() => svc.close());
  const pf = await svc.preflight({ sources: [src], destinationRoot: makeDest(base), mode: 'move', verify: 'full', disposal: 'papelera' });
  assert.ok(pf.blockers.some((b) => b.code === 'sin-funcion-papelera'));
});

test('servicio: una sola operación a la vez y cancelación a mitad (originales intactos)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base, { big: true });
  const dest = makeDest(base);
  const before = snapshot(src);
  // Avisos de progreso sin límite de frecuencia: en una máquina rápida la copia podría terminar antes del primer aviso del archivo grande.
  const { svc, trashed } = newService(t, { progressIntervalMs: 0 });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  const events = [];
  let cancelSent = false;
  svc.on('progress', (e) => {
    events.push(e);
    if (!cancelSent && e.fase === 'copiando' && e.archivo.endsWith('grande.bin') && e.bytesDone > 0) {
      cancelSent = true;
      svc.cancel();
    }
  });
  const running = svc.run(pf.planId);
  await new Promise((r) => svc.once('progress', r));
  await assert.rejects(() => svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy' }), { code: 'OCUPADO' });
  await assert.rejects(() => svc.verifyRecord('0123456789abcdef'), { code: 'OCUPADO' });
  const r = await running;
  assert.ok(cancelSent);
  assert.equal(r.estado, 'cancelado');
  assert.equal(r.carpetas[0].resultado, 'cancelada');
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
  assert.deepEqual(fs.readdirSync(dest), [], 'cancelar deja el destino limpio');
  assert.ok(events.length > 1);
  assert.deepEqual(await svc.cancel(), { cancelled: false }, 'cancelar sin operación no hace nada');
  // Ya libre: se puede revisar otra vez.
  assert.deepEqual((await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy' })).blockers, []);
});

test('servicio: copias anteriores (registro en el PC), verificarlas y quitarCopiado (por runId)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t);
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  const r = await svc.run(pf.planId);
  const id = r.carpetas[0].registroId;
  assert.match(id, /^[0-9a-f]{16}$/);
  const list = await svc.listRecords();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].archivosTotal, 5);
  assert.equal(list[0].archivos, undefined, 'la lista no trae los archivos');
  const v = await svc.verifyRecord(id);
  assert.equal(v.estado, 'ok');
  assert.equal(v.nombre, path.basename(src));
  fs.writeFileSync(path.join(r.carpetas[0].destino, 'a.txt'), 'dañado!!!!');
  assert.equal((await svc.verifyRecord(id)).estado, 'problemas');
  await assert.rejects(() => svc.verifyRecord('ffffffffffffffff'), { code: 'REGISTRO_DESCONOCIDO' });
  await assert.rejects(() => svc.quitarCopiado('desconocido'), { code: 'RESULTADO_DESCONOCIDO' });
  const q = await svc.quitarCopiado(r.runId);
  assert.ok(q.quitados > 0 || q.omitidos.length > 0);
  assert.equal(fs.existsSync(path.join(r.carpetas[0].destino, 'canción.txt')), false);
  assert.ok(fs.existsSync(src));
  assert.deepEqual((await svc.removeRecord(id)), { quitado: false }, 'quitarCopiado ya quitó el registro cuando se pudo quitar todo');
});

test('servicio: carpetas «….copiando» pendientes (diario) se listan y solo se limpian las que BoneYardDog anotó', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t, { progressIntervalMs: 0 });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  // Se corta a la fuerza a mitad (como un cierre forzado): el hilo se mata y NADIE limpia.
  let cut = false;
  svc.on('progress', (e) => {
    if (!cut && e.fase === 'copiando') {
      cut = true;
      svc._worker.terminate();
    }
  });
  await assert.rejects(() => svc.run(pf.planId));
  const work = path.join(fs.realpathSync(dest), `${path.basename(src)}.copiando`);
  assert.ok(fs.existsSync(work), 'quedó la carpeta provisional');
  assert.equal(fs.existsSync(path.join(dest, path.basename(src))), false, 'y NUNCA parece una copia buena');
  const pend = await svc.listPending();
  assert.deepEqual(pend.map((p) => p.ruta), [work]);
  // Una carpeta que el diario no conoce no se toca, aunque se llame «.copiando».
  const ajena = path.join(dest, 'Ajena.copiando');
  fs.mkdirSync(ajena);
  fs.writeFileSync(path.join(ajena, 'x.txt'), 'ajeno');
  await assert.rejects(() => svc.cleanPending(ajena), { code: 'NO_ANOTADA' });
  assert.ok(fs.existsSync(path.join(ajena, 'x.txt')));
  assert.deepEqual(await svc.cleanPending(work), { estado: 'quitada' });
  assert.equal(fs.existsSync(work), false);
  assert.deepEqual(await svc.listPending(), []);
  assert.deepEqual(snapshot(src), snapshot(src));
});

test('servicio: los mensajes entre hilos son pequeños aunque haya miles de archivos', async (t) => {
  const base = tmpDir(t);
  const src = path.join(base, 'origen', 'Muchos');
  for (let d = 0; d < 20; d++) for (let f = 0; f < 150; f++) write(path.join(src, `d${d}`, `archivo-${f}.dat`), `contenido ${d}-${f}`);
  const dest = makeDest(base);
  const sizes = [];
  const { svc } = newService(t, {
    workerFactory: () => {
      const w = new Worker(WORKER, { workerData: { hasTrash: true } });
      w.on('message', (m) => !(m && m.type === 'progress') && sizes.push(v8.serialize(m).length));
      return w;
    },
  });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'quick' });
  assert.equal(pf.plan.totals.files, 3000);
  const r = await svc.run(pf.planId);
  assert.equal(r.estado, 'completo');
  assert.ok(Math.max(...sizes) < 20_000, `mensaje máximo: ${Math.max(...sizes)} bytes`);
  assert.ok(!JSON.stringify([pf, r]).includes('"entries"'));
});

test('servicio: un error en el hilo rechaza la promesa y el servicio se recupera', async (t) => {
  const stub = `require('node:worker_threads').parentPort.on('message', () => { throw new Error('boom'); });`;
  const svc = new TransferService({ workerFactory: () => new Worker(stub, { eval: true }) });
  t.after(() => svc.close());
  await assert.rejects(() => svc.preflight({}), /boom/);
  await assert.rejects(() => svc.preflight({}), /boom/);
});

test('servicio: método desconocido y argumentos raros no cuelgan nada', async (t) => {
  const { svc } = newService(t);
  await assert.rejects(() => svc._call('borrarTodo'), { code: 'METODO_DESCONOCIDO' });
  const pf = await svc.preflight(null);
  assert.ok(pf.blockers.length > 0);
  await assert.rejects(() => svc.verifyRecord(7), /no válida|Identificador|registro|desconocida/i);
});

test('servicio: eliminarDefinitivamente (tras una Papelera que falló) pide confirmación, valida índices y borra', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const before = snapshot(src);
  const { svc } = newService(t, {
    trash: async () => {
      throw new Error('Windows rechazó la Papelera');
    },
  });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  assert.deepEqual(pf.blockers, []);
  assert.equal(pf.plan.confirmPermanentDelete, false);
  const r = await svc.run(pf.planId);
  assert.equal(r.carpetas[0].resultado, 'original-sin-tocar');
  assert.equal(r.carpetas[0].motivoCodigo, 'papelera-fallo');
  assert.match(r.carpetas[0].motivo, /Windows rechazó la Papelera/);
  await assert.rejects(() => svc.eliminarDefinitivamente(r.runId, [0], false), /confirmación/);
  await assert.rejects(() => svc.eliminarDefinitivamente(r.runId, [0], 'true'), /confirmación/);
  await assert.rejects(() => svc.eliminarDefinitivamente(r.runId, [3], true), /índice/);
  await assert.rejects(() => svc.eliminarDefinitivamente('desconocido', [0], true), { code: 'RESULTADO_DESCONOCIDO' });
  assert.deepEqual(snapshot(src), before, 'nada se borró con peticiones inválidas');
  const out = await svc.eliminarDefinitivamente(r.runId, [0], true);
  assert.equal(out.resumen.carpetas[0].resultado, 'original-borrado-definitivamente');
  assert.equal(fs.existsSync(src), false);
  assert.deepEqual(snapshot(out.resumen.carpetas[0].destino), before);
  await assert.rejects(() => svc.eliminarDefinitivamente(r.runId, [0], true), /no se puede borrar así/);
  await assert.rejects(() => svc.quitarCopiado(r.runId), /ya se retiró/);
});

test('servicio: transferencia con borrado definitivo explícito (confirmPermanentDelete) y el resumen no filtra el plan', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc, trashed } = newService(t);
  const sin = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'borrar' });
  assert.equal(sin.planId, null);
  assert.ok(sin.blockers.some((b) => b.code === 'borrado-sin-confirmar'));
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'borrar', confirmPermanentDelete: true });
  assert.equal(pf.plan.confirmPermanentDelete, true);
  assert.equal(pf.plan.sources[0].entries, undefined);
  const r = await svc.run(pf.planId);
  assert.equal(r.carpetas[0].resultado, 'original-borrado-definitivamente');
  assert.deepEqual(trashed, []);
  assert.equal(fs.existsSync(src), false);
});

// ---------------------------------------------------------------- perro guardián (disco que se cuelga)

for (const lado of ['read', 'write']) {
  test(`perro guardián: si el disco se cuelga al ${lado === 'read' ? 'leer' : 'escribir'}, cancelar corta el hilo, avisa y no toca el original`, { timeout: 15000 }, async (t) => {
    const base = tmpDir(t);
    const src = makeSource(base);
    const dest = makeDest(base);
    const before = snapshot(src);
    const { svc } = newService(t, { cancelGraceMs: 400, workerData: { testHangFs: lado } });
    const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
    assert.deepEqual(pf.blockers, []);
    let forced = null;
    svc.on('forced-cancel', (e) => (forced = e));
    const running = svc.run(pf.planId);
    await new Promise((r) => setTimeout(r, 500)); // ya está colgado dentro del disco
    const t0 = Date.now();
    await svc.cancel();
    const res = await running;
    assert.ok(Date.now() - t0 < 5000, 'no espera indefinidamente');
    assert.equal(res.forzada, true);
    assert.equal(res.estado, 'cancelada');
    assert.match(res.aviso, /Cancelada a la fuerza/);
    assert.match(res.aviso, /\.copiando/, 'nombra la carpeta provisional exacta');
    assert.ok(forced && forced.pendientes.length === 1);
    assert.deepEqual(snapshot(src), before, 'el original queda intacto');
    assert.equal(fs.existsSync(forced.pendientes[0]), true, 'el servicio no borra a ciegas: la carpeta queda para limpiarla después');

    // El hilo nuevo funciona: lista lo pendiente y puede limpiarlo (solo lo anotado en el diario).
    const pend = await svc.listPending();
    assert.equal(pend.length, 1);
    await svc.cleanPending(pend[0].ruta);
    assert.equal(fs.existsSync(pend[0].ruta), false);
    assert.deepEqual(await svc.listPending(), []);
  });
}

test('perro guardián: si el hilo termina de cancelar a tiempo, no se corta nada', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t, { cancelGraceMs: 3000 });
  let forced = false;
  svc.on('forced-cancel', () => (forced = true));
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  const running = svc.run(pf.planId);
  await svc.cancel();
  const res = await running;
  assert.notEqual(res.forzada, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(forced, false);
});

test('cancelAndWait: con el disco colgado espera como mucho el perro guardián', { timeout: 15000 }, async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t, { cancelGraceMs: 300, workerData: { testHangFs: 'read' } });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  const running = svc.run(pf.planId);
  await new Promise((r) => setTimeout(r, 400));
  const t0 = Date.now();
  await svc.cancelAndWait();
  assert.ok(Date.now() - t0 < 5000);
  assert.equal((await running).forzada, true);
  assert.deepEqual(await svc.cancelAndWait(), { cancelled: false });
});

test('diagnóstico: queda el tiempo de abrir el origen y de la primera lectura, con rutas pero sin contenido', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const diagFile = path.join(tmpDir(t, 'diag-'), 'diagnostico.log');
  const { svc } = newService(t, { diagFile });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  await svc.run(pf.planId);
  await svc.close();
  await new Promise((r) => setTimeout(r, 300));
  const text = fs.readFileSync(diagFile, 'utf8');
  assert.match(text, /archivo-copiado/);
  assert.match(text, /aperturaOrigenMs/);
  assert.match(text, /primeraLecturaMs/);
  assert.match(text, /verificacion-abierta/);
  assert.match(text, /"evento":"inicio"|inicio/);
  assert.match(text, /fin/);
  const contents = fs.readdirSync(src, { recursive: true }).filter((n) => fs.statSync(path.join(src, n)).isFile()).map((n) => fs.readFileSync(path.join(src, n), 'utf8')).filter((c) => c.length > 8);
  for (const c of contents) assert.equal(text.includes(c), false, 'el contenido de los archivos no va al registro');
});
