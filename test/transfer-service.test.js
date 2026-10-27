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
  // En Linux el worker no conoce el tipo de disco: el veredicto es "desconocido", así que hay que aceptar el riesgo.
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera' });
  // Fuera de Windows el worker no puede saber el tipo de disco ("desconocido"): sin aceptar el riesgo se rechaza.
  // En Windows sí lo sabe (NTFS fijo) y una carpeta pequeña "probablemente cabe".
  if (process.platform !== 'win32') assert.ok(pf.blockers.some((b) => b.code === 'papelera-no-recomendada'), 'sin aceptar el riesgo se rechaza');
  const pf2 = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera', acceptRecycleRisk: true });
  assert.deepEqual(pf2.blockers, []);
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
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera', acceptRecycleRisk: true });
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
  const pf = await svc.preflight({ sources: [src], destinationRoot: makeDest(base), mode: 'move', verify: 'full', disposal: 'papelera', acceptRecycleRisk: true });
  assert.ok(pf.blockers.some((b) => b.code === 'sin-funcion-papelera'));
});

test('servicio: una sola operación a la vez y cancelación a mitad (originales intactos)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base, { big: true });
  const dest = makeDest(base);
  const before = snapshot(src);
  // Avisos de progreso sin límite de frecuencia: en una máquina rápida la copia podría terminar antes del primer aviso del archivo grande.
  const { svc, trashed } = newService(t, { progressIntervalMs: 0 });
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'move', verify: 'full', disposal: 'papelera', acceptRecycleRisk: true });
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
  await assert.rejects(() => svc.verifyBatch(dest), { code: 'OCUPADO' });
  const r = await running;
  assert.ok(cancelSent);
  assert.equal(r.estado, 'cancelado');
  assert.equal(r.carpetas[0].resultado, 'cancelada');
  assert.deepEqual(trashed, []);
  assert.deepEqual(snapshot(src), before);
  assert.ok(events.length > 1);
  assert.deepEqual(await svc.cancel(), { cancelled: false }, 'cancelar sin operación no hace nada');
  // Ya libre: se puede revisar otra vez.
  assert.deepEqual((await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy' })).blockers, []);
});

test('servicio: verifyBatch y quitarCopiado (por runId)', async (t) => {
  const base = tmpDir(t);
  const src = makeSource(base);
  const dest = makeDest(base);
  const { svc } = newService(t);
  const pf = await svc.preflight({ sources: [src], destinationRoot: dest, mode: 'copy', verify: 'full' });
  const r = await svc.run(pf.planId);
  const v = await svc.verifyBatch(r.batchFolder);
  assert.equal(v.ok, true);
  fs.writeFileSync(path.join(r.carpetas[0].destino, 'a.txt'), 'dañado!!!!');
  assert.equal((await svc.verifyBatch(r.batchFolder)).ok, false);
  await assert.rejects(() => svc.quitarCopiado('desconocido'), { code: 'RESULTADO_DESCONOCIDO' });
  const q = await svc.quitarCopiado(r.runId);
  assert.ok(q.quitados > 0 || q.omitidos.length > 0);
  assert.equal(fs.existsSync(path.join(r.carpetas[0].destino, 'canción.txt')), false);
  assert.ok(fs.existsSync(src));
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
  await assert.rejects(() => svc.verifyBatch(7), /no válida/);
});
