'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const v8 = require('node:v8');
const { Worker } = require('node:worker_threads');

const { AnalysisService } = require('../src/service/service');
const { scan } = require('../src/core/scanner');
const analysis = require('../src/core/analysis');
const { isProtectedPath } = require('../src/core/protected');

const DAY = 24 * 60 * 60 * 1000;
const TMP_BASE = path.join(__dirname, '..', '.test-tmp');

// Carpeta temporal dentro del repositorio: en Windows la carpeta temporal del
// sistema está dentro de AppData, que está protegida a propósito.
function tmpDir(t) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'svc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(isProtectedPath(dir), false, 'la carpeta de pruebas no debe estar protegida');
  return dir;
}

function put(root, rel, bytes, daysAgo = 0) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  if (daysAgo) {
    const d = new Date(Date.now() - daysAgo * DAY);
    fs.utimesSync(full, d, d);
  }
}

function newService(t, options) {
  const svc = new AnalysisService(options);
  t.after(() => svc.close());
  return svc;
}

/** Servicio para pruebas con archivos REALES: su fecha de creación es "ahora" y no se puede retrasar. */
async function newRealService(t, options) {
  const svc = newService(t, options);
  await svc.setUsageOptions({ useCreationTime: false });
  return svc;
}

/** Árbol de ejemplo: ~60 archivos con tamaños y fechas variadas. */
function buildSample(root) {
  for (let i = 0; i < 20; i++) put(root, `fotos/f${i}.jpg`, 1000 + i * 10, 800 + i);
  for (let i = 0; i < 20; i++) put(root, `docs/d${i}.txt`, 100 + i, 5);
  for (let i = 0; i < 10; i++) put(root, `viejo/v${i}.bin`, 5000 + i, 900);
  put(root, 'grande.iso', 90000, 400);
  put(root, 'reciente.txt', 10, 0);
  put(root, 'vacia/.keep', 0, 0);
}

test('resultados del servicio = análisis directo sobre el mismo árbol', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const svc = await newRealService(t);

  const summary = await svc.startScan(root);
  const direct = await scan(root);
  assert.equal(summary.cancelled, false);
  assert.equal(summary.rootPath, path.resolve(root));
  assert.equal(summary.stats.files, direct.stats.files);
  assert.equal(summary.stats.bytes, direct.tree.size);
  assert.equal(summary.skippedCount, direct.skipped.length);
  assert.deepEqual(summary.atimeReliability, analysis.atimeReliability(direct.tree));

  const files = await svc.getLargestFiles(5);
  const directFiles = analysis.topLargestFiles(direct.tree, 5);
  assert.deepEqual(files.map((f) => [f.path, f.size]), directFiles.map((f) => [f.path, f.size]));

  const folders = await svc.getLargestFolders(3);
  assert.deepEqual(folders.map((f) => f.path), analysis.topLargestFolders(direct.tree, 3).map((f) => f.path));

  const stale = await svc.getStale({ olderThanDays: 365, minSizeBytes: 100 });
  const directStale = analysis.findStale(direct.tree, { olderThanDays: 365, minSizeBytes: 100, useCreationTime: false });
  assert.deepEqual(stale.items.map((i) => i.path), directStale.items.map((i) => i.path));
  assert.equal(stale.totalBytes, directStale.totalBytes);
  assert.equal(stale.count, directStale.items.length);
  assert.equal(stale.truncated, false);
  assert.ok(stale.items.length > 0);
  assert.equal(stale.notOfferedCount, directStale.notOffered.length);

  const sel = [path.join(root, 'fotos'), path.join(root, 'fotos', 'f1.jpg'), path.join(root, 'grande.iso')];
  const sum = await svc.summarizeSelection(sel);
  const nodes = sel.map((p) => {
    const find = (n) => (n.path === p ? n : (n.children || []).map(find).find(Boolean));
    return find(direct.tree);
  });
  const directSum = analysis.summarize(nodes);
  assert.equal(sum.totalBytes, directSum.totalBytes);
  assert.equal(sum.totalFiles, directSum.totalFiles);
  assert.deepEqual(sum.counted, directSum.counted.map((n) => n.path));
  assert.deepEqual(sum.excluded, [{ path: sel[1], reason: 'dentro-de-otro-seleccionado' }]);
});

test('getChildren: nodos livianos, orden, paginación y bandera de protegido', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const svc = await newRealService(t);
  await svc.startScan(root);

  const page = await svc.getChildren(root, { sortBy: 'size', limit: 3 });
  assert.equal(page.total, 6);
  assert.deepEqual(page.items.map((i) => i.name), ['grande.iso', 'viejo', 'fotos']);
  for (const item of page.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      ['fileCount', 'hasChildren', 'lastUsedMs', 'name', 'path', 'protected', 'size', 'type'],
    );
    assert.equal(item.protected, false);
  }
  const grande = page.items[0];
  assert.equal(grande.type, 'file');
  assert.equal(grande.hasChildren, false);
  assert.ok(page.items[1].hasChildren);

  const byName = await svc.getChildren(root, { sortBy: 'name' });
  assert.deepEqual(byName.items.map((i) => i.name), ['docs', 'fotos', 'grande.iso', 'reciente.txt', 'vacia', 'viejo']);
  const resto = await svc.getChildren(root, { sortBy: 'name', offset: 4, limit: 10 });
  assert.deepEqual(resto.items.map((i) => i.name), ['vacia', 'viejo']);

  const porUso = await svc.getChildren(root, { sortBy: 'lastUsed' });
  assert.equal(porUso.items[0].name, 'viejo', 'lo más antiguo primero');
  const viejo = porUso.items[0];
  assert.ok(Math.abs(viejo.lastUsedMs - (Date.now() - 900 * DAY)) < DAY);

  const vacia = (await svc.getChildren(root)).items.find((i) => i.name === 'vacia');
  assert.equal(vacia.type, 'folder');
  const hijos = await svc.getChildren(path.join(root, 'fotos'), { limit: 5 });
  assert.equal(hijos.items.length, 5);
  assert.equal(hijos.total, 20);
});

test('getChildren/consultas: parámetros inválidos y sin análisis previo', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const svc = newService(t);
  await assert.rejects(() => svc.getLargestFiles(3), { code: 'SIN_ANALISIS' });
  await assert.rejects(() => svc.getChildren(root), { code: 'SIN_ANALISIS' });
  await svc.startScan(root);
  await assert.rejects(() => svc.getLargestFiles(0), RangeError);
  await assert.rejects(() => svc.getLargestFiles(100000), RangeError);
  await assert.rejects(() => svc.getLargestFolders(1.5), RangeError);
  await assert.rejects(() => svc.getChildren(root, { sortBy: 'otra' }), RangeError);
  await assert.rejects(() => svc.getChildren(root, { limit: 0 }), RangeError);
  await assert.rejects(() => svc.getChildren(root, { offset: -1 }), RangeError);
  await assert.rejects(() => svc.getChildren(path.join(root, 'grande.iso')), { code: 'NO_ES_CARPETA' });
  await assert.rejects(() => svc.getStale({}), RangeError);
  await assert.rejects(() => svc.getStale({ olderThanDays: 5, minSizeBytes: -1 }), RangeError);
  await assert.rejects(() => svc.startScan(''), TypeError);
  await assert.rejects(() => svc.startScan('a\0b'), TypeError);
});

test('rutas desconocidas se rechazan (el renderer solo manda rutas, nunca datos)', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const svc = newService(t);
  await svc.startScan(root);

  const afuera = path.join(path.dirname(root), 'otra-cosa');
  const intentos = [
    afuera,
    path.join(root, '..', 'secreto.txt'),
    path.join(root, 'fotos', '..', '..', 'x'),
    path.join(root, 'no-existe.txt'),
    path.join(root, 'FOTOS', 'f1.jpg').replace('FOTOS', 'fotoz'),
    'relativa/ruta',
    '',
    '\0',
  ];
  for (const p of intentos) {
    await assert.rejects(() => svc.summarizeSelection([p]), { code: 'RUTA_DESCONOCIDA' }, JSON.stringify(p));
    await assert.rejects(() => svc.getChildren(p), { code: 'RUTA_DESCONOCIDA' }, JSON.stringify(p));
  }
  // Un objeto "nodo" falso no es una ruta: se rechaza.
  await assert.rejects(() => svc.summarizeSelection([{ path: root, size: 1, type: 'file' }]), { code: 'RUTA_DESCONOCIDA' });
  await assert.rejects(() => svc.summarizeSelection('no es lista'), RangeError);
  // Si una sola es desconocida, se rechaza toda la selección.
  await assert.rejects(() => svc.summarizeSelection([path.join(root, 'grande.iso'), afuera]), { code: 'RUTA_DESCONOCIDA' });
  // Las válidas sí funcionan; una ruta con ".." que sigue dentro del árbol se normaliza.
  const ok = await svc.summarizeSelection([path.join(root, 'docs', '..', 'grande.iso')]);
  assert.equal(ok.totalBytes, 90000);
});

test('cancelación a mitad del escaneo', async (t) => {
  const root = tmpDir(t);
  for (let d = 0; d < 30; d++) for (let f = 0; f < 100; f++) put(root, `d${d}/f${f}.bin`, 10);
  const svc = newService(t);
  let cancelSent = false;
  svc.on('progress', () => {
    if (!cancelSent) {
      cancelSent = true;
      svc.cancel();
    }
  });
  const summary = await svc.startScan(root);
  assert.equal(cancelSent, true);
  assert.equal(summary.cancelled, true);
  assert.ok(summary.stats.files < 3000, `se leyeron ${summary.stats.files} de 3000`);
  // Un árbol parcial no se usa para nada.
  await assert.rejects(() => svc.getLargestFiles(3), { code: 'SIN_ANALISIS' });
  assert.deepEqual(await svc.cancel(), { cancelled: false }, 'cancelar sin escaneo en curso no hace nada');
});

test('un escaneo nuevo reemplaza al anterior', async (t) => {
  const grande = tmpDir(t);
  for (let d = 0; d < 30; d++) for (let f = 0; f < 100; f++) put(grande, `d${d}/f${f}.bin`, 10);
  const chico = tmpDir(t);
  put(chico, 'solo.txt', 77);
  const svc = newService(t);

  const primero = svc.startScan(grande);
  const segundo = svc.startScan(chico);
  const [r1, r2] = await Promise.all([primero, segundo]);

  assert.equal(r1.cancelled, true);
  assert.equal(r1.replaced, true);
  assert.equal(r2.cancelled, false);
  assert.equal(r2.stats.files, 1);
  const hijos = await svc.getChildren(chico);
  assert.deepEqual(hijos.items.map((i) => i.name), ['solo.txt']);
  await assert.rejects(() => svc.getChildren(grande), { code: 'RUTA_DESCONOCIDA' });
});

test('el mensaje entre hilos nunca contiene el árbol completo', async (t) => {
  const root = tmpDir(t);
  // 12 000 archivos: pesan ~2 MB serializado aunque la ruta temporal sea corta; el
  // margen sobre el umbral no depende del largo de la ruta del entorno.
  for (let d = 0; d < 60; d++) for (let f = 0; f < 200; f++) put(root, `carpeta${d}/archivo-${f}.dat`, 1 + f, f % 3 === 0 ? 700 : 0);
  const direct = await scan(root);
  const treeBytes = v8.serialize(direct.tree).length;
  assert.ok(treeBytes > 1_000_000, `el árbol de prueba debe ser grande (${treeBytes} bytes)`);
  // Debe superar el umbral con holgura (>= 50 %), sin depender de la ruta.
  assert.ok(treeBytes > 1_500_000, `sin holgura suficiente sobre el umbral (${treeBytes} bytes)`);

  const sizes = [];
  let sawChildrenKey = false;
  const svc = newService(t, {
    workerFactory: () => {
      const worker = new Worker(path.join(__dirname, '..', 'src', 'service', 'analysis-worker.js'));
      worker.on('message', (m) => {
        sizes.push(v8.serialize(m).length);
        if (JSON.stringify(m).includes('"children"')) sawChildrenKey = true;
      });
      return worker;
    },
  });

  await svc.startScan(root);
  await svc.getChildren(root, { limit: 1000 });
  await svc.getLargestFiles(1000);
  await svc.getLargestFolders(1000);
  await svc.getStale({ olderThanDays: 30 });
  await svc.summarizeSelection([root]);

  assert.ok(sizes.length >= 7);
  assert.equal(sawChildrenKey, false, 'ningún mensaje lleva subárboles');
  const biggest = Math.max(...sizes);
  assert.ok(biggest < treeBytes / 4, `mensaje máximo ${biggest} bytes vs árbol ${treeBytes} bytes`);
  assert.ok(biggest < 300_000, `mensaje máximo ${biggest} bytes`);
});

test('getStale: máximo 1000 entradas, con truncated y totales completos', async (t) => {
  const root = tmpDir(t);
  for (let i = 0; i < 1100; i++) put(root, `viejo-${String(i).padStart(4, '0')}.bin`, 10, 800);
  put(root, 'reciente.txt', 1, 0); // evita que la carpeta entera se ofrezca como una sola entrada
  const svc = await newRealService(t);
  await svc.startScan(root);
  const stale = await svc.getStale({ olderThanDays: 365 });
  assert.equal(stale.items.length, 1000);
  assert.equal(stale.count, 1100);
  assert.equal(stale.truncated, true);
  assert.equal(stale.totalBytes, 11000);
  assert.ok(stale.items.every((i) => typeof i.daysUnused === 'number' && i.daysUnused >= 799));
});

test('getStale informa los no ofrecidos por motivo', async (t) => {
  const root = tmpDir(t);
  put(root, 'a/viejo.bin', 100, 900);
  put(root, 'nuevo.txt', 1, 0);
  const svc = await newRealService(t);
  await svc.startScan(root);
  // Raíz de prueba con solo el archivo viejo y uno nuevo: nada protegido ni ilegible.
  const stale = await svc.getStale({ olderThanDays: 365 });
  assert.deepEqual(stale.notOfferedByReason, {});
  assert.equal(stale.notOfferedCount, 0);
  assert.deepEqual(stale.items.map((i) => i.name), ['a']);
});

test('ruta inexistente: el resumen indica que no hay árbol y las consultas fallan claro', async (t) => {
  const root = tmpDir(t);
  const svc = newService(t);
  const summary = await svc.startScan(path.join(root, 'no-existe'));
  assert.equal(summary.hasTree, false);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.skippedByKind['not-found'], 1);
  await assert.rejects(() => svc.getLargestFiles(3), { code: 'SIN_ANALISIS' });
});

test('un error en el hilo rechaza la promesa (no queda colgada) y el servicio se recupera', async (t) => {
  const stub = `require('node:worker_threads').parentPort.on('message', () => { throw new Error('boom'); });`;
  const svc = newService(t, { workerFactory: () => new Worker(stub, { eval: true }) });
  const errores = [];
  svc.on('worker-error', (e) => errores.push(e));

  const limite = new Promise((_, reject) => setTimeout(() => reject(new Error('la promesa quedó colgada')), 10000).unref());
  await assert.rejects(() => Promise.race([svc.getLargestFiles(1), limite]), /boom/);
  assert.equal(errores.length, 1);
  // Segunda llamada: se crea un hilo nuevo (que vuelve a fallar) en vez de quedarse esperando uno muerto.
  await assert.rejects(() => Promise.race([svc.getLargestFiles(1), limite]), /boom/);
});

test('si el hilo termina sin avisar, las promesas pendientes se rechazan', async (t) => {
  const stub = `require('node:worker_threads').parentPort.on('message', () => { process.exit(3); });`;
  const svc = newService(t, { workerFactory: () => new Worker(stub, { eval: true }) });
  const limite = new Promise((_, reject) => setTimeout(() => reject(new Error('la promesa quedó colgada')), 10000).unref());
  await assert.rejects(() => Promise.race([svc.startScan('/x'), limite]), /terminó inesperadamente/);
});

test('close() rechaza lo pendiente y termina el hilo', async (t) => {
  const root = tmpDir(t);
  for (let d = 0; d < 30; d++) for (let f = 0; f < 100; f++) put(root, `d${d}/f${f}.bin`, 10);
  const svc = newService(t);
  const scanning = svc.startScan(root);
  scanning.catch(() => {});
  await new Promise((r) => svc.once('progress', r));
  await svc.close();
  await assert.rejects(() => scanning, /se cerró|terminó/);
});

test('1b: fechas coherentes: daysUnused y lastUsedMs nunca se contradicen (mtime hace 800 días, atime hace 3)', async (t) => {
  const root = tmpDir(t);
  const f = path.join(root, 'leido.bin');
  fs.writeFileSync(f, Buffer.alloc(100, 1));
  fs.utimesSync(f, new Date(Date.now() - 3 * DAY), new Date(Date.now() - 800 * DAY)); // (atime, mtime)
  put(root, 'nuevo.txt', 5, 0);
  const svc = await newRealService(t);
  await svc.startScan(root);

  const dias = (ms) => (Date.now() - ms) / DAY;
  const coherente = (item) => assert.ok(Math.abs(dias(item.lastUsedMs) - item.daysUnused) < 1.01, `${item.daysUnused} días vs lastUsedMs de hace ${dias(item.lastUsedMs)}`);

  // Por defecto el acceso se ignora: en ambos lados son ~800 días.
  const stale = await svc.getStale({ olderThanDays: 365 });
  assert.deepEqual(stale.items.map((i) => i.name), ['leido.bin']);
  assert.ok(stale.items[0].daysUnused >= 799);
  coherente(stale.items[0]);
  const hijo = (await svc.getChildren(root)).items.find((i) => i.name === 'leido.bin');
  assert.ok(Math.abs(dias(hijo.lastUsedMs) - 800) < 1.01);

  // Con el acceso contando: en uso (3 días) en ambos lados, sin contradicción.
  assert.deepEqual(await svc.setUsageOptions({ useAccessTime: true }), { useAccessTime: true, useCreationTime: false });
  assert.equal((await svc.getStale({ olderThanDays: 365 })).items.length, 0);
  const hijo2 = (await svc.getChildren(root)).items.find((i) => i.name === 'leido.bin');
  assert.ok(Math.abs(dias(hijo2.lastUsedMs) - 3) < 1.01, 'lastUsedMs se re-anotó con las mismas opciones');
  const stale3 = await svc.getStale({ olderThanDays: 1 });
  for (const item of stale3.items) coherente(item);

  // Volver atrás.
  await svc.setUsageOptions({ useAccessTime: false });
  const otra = await svc.getStale({ olderThanDays: 365 });
  assert.equal(otra.items.length, 1);
  coherente(otra.items[0]);
});

test('setUsageOptions: valida lo que recibe y vale para escaneos nuevos', async (t) => {
  const root = tmpDir(t);
  put(root, 'a.bin', 5, 0);
  const svc = newService(t);
  await assert.rejects(() => svc.setUsageOptions(null), TypeError);
  await assert.rejects(() => svc.setUsageOptions([]), TypeError);
  await assert.rejects(() => svc.setUsageOptions({ useAccessTime: 'si' }), TypeError);
  assert.deepEqual(await svc.setUsageOptions({}), { useAccessTime: false, useCreationTime: true });
  assert.deepEqual(await svc.setUsageOptions({ useCreationTime: false }), { useAccessTime: false, useCreationTime: false });
  await svc.startScan(root); // sin árbol previo: las opciones siguen vigentes
  const hijo = (await svc.getChildren(root)).items[0];
  assert.ok(Math.abs(hijo.lastUsedMs - Date.now()) < 60_000);
  assert.deepEqual(await svc.setUsageOptions({ useAccessTime: true }), { useAccessTime: true, useCreationTime: false });
});

// --- getStaleFolders ---------------------------------------------------------

function buildFolders(root) {
  put(root, 'vieja/a.bin', 5000, 800);
  put(root, 'conReciente/a.bin', 5000, 800);
  put(root, 'conReciente/nota.txt', 10, 5);
  put(root, 'chica/a.bin', 10, 800);
  put(root, 'padre/h1/a.bin', 3000, 600);
  put(root, 'padre/h2/b.bin', 3000, 600);
  put(root, 'canción ñandú 🐕/x.bin', 4000, 500);
  put(root, 'nuevo.txt', 5, 0);
}

test('getStaleFolders: igual que el análisis directo, con campos livianos y newestFile', async (t) => {
  const root = tmpDir(t);
  buildFolders(root);
  const svc = await newRealService(t);
  await svc.startScan(root);
  const direct = await scan(root);
  const opts = { olderThanDays: 90, minSizeBytes: 1000 };
  const want = analysis.findStaleFolders(direct.tree, { ...opts, useCreationTime: false });

  const got = await svc.getStaleFolders(opts);
  assert.deepEqual(got.items.map((i) => i.path), want.items.map((i) => i.path));
  assert.equal(got.count, want.items.length);
  assert.equal(got.truncated, false);
  assert.equal(got.totalBytes, want.totalBytes);
  assert.equal(got.notOfferedCount, want.notOffered.length);
  assert.deepEqual(got.items.map((i) => i.name).sort(), ['canción ñandú 🐕', 'padre', 'vieja'].sort());
  for (const item of got.items) {
    assert.deepEqual(Object.keys(item).sort(), ['daysUnused', 'fileCount', 'hasChildren', 'hasLinks', 'lastUsedMs', 'name', 'newestFile', 'path', 'protected', 'size', 'type']);
    assert.equal(item.type, 'folder');
    assert.ok(item.newestFile && item.newestFile.name && item.newestFile.ms === item.lastUsedMs);
  }
  const vieja = got.items.find((i) => i.name === 'vieja');
  assert.equal(vieja.newestFile.name, 'a.bin');
  // Valores por defecto: 90 días y 500 MB => nada de lo de prueba llega al mínimo.
  assert.equal((await svc.getStaleFolders()).count, 0);
});

test('getStaleFolders: parámetros inválidos se rechazan', async (t) => {
  const root = tmpDir(t);
  buildFolders(root);
  const svc = await newRealService(t);
  await assert.rejects(() => svc.getStaleFolders({ olderThanDays: 5 }), { code: 'SIN_ANALISIS' });
  await svc.startScan(root);
  for (const mal of [0, -1, 3651, 1.5, NaN, '90', null]) {
    await assert.rejects(() => svc.getStaleFolders({ olderThanDays: mal }), RangeError, `olderThanDays ${mal}`);
  }
  for (const mal of [-1, 10 * 1024 ** 4 + 1, 1.5, NaN, '5', null]) {
    await assert.rejects(() => svc.getStaleFolders({ minSizeBytes: mal }), RangeError, `minSizeBytes ${mal}`);
  }
  await assert.doesNotReject(() => svc.getStaleFolders({ olderThanDays: 3650, minSizeBytes: 10 * 1024 ** 4 }));
  await assert.doesNotReject(() => svc.getStaleFolders({ olderThanDays: 1, minSizeBytes: 0 }));
  await assert.rejects(() => svc.getStaleFolders({ excludedPaths: 'x' }), RangeError);
  await assert.rejects(() => svc.getStaleFolders({ excludedPaths: [1] }), TypeError);
  await assert.rejects(() => svc.getStaleFolders({ excludedPaths: ['a\0b'] }), TypeError);
  await assert.rejects(() => svc.getStaleFolders({ excludedPaths: Array(501).fill('/x') }), RangeError);
  await assert.rejects(() => svc.getStaleFolders([]), TypeError);
  await assert.rejects(() => svc.getStaleFolders(null), TypeError);
  await assert.rejects(() => svc.getStaleFolders({ olderThanDays: 5, now: 'ayer' }), RangeError);
});

test('getStaleFolders: excludedPaths aparta carpetas y se informa en notOfferedByReason', async (t) => {
  const root = tmpDir(t);
  buildFolders(root);
  const svc = await newRealService(t);
  await svc.startScan(root);
  const base = { olderThanDays: 90, minSizeBytes: 1000 };
  const all = await svc.getStaleFolders(base);
  const ex = await svc.getStaleFolders({ ...base, excludedPaths: [path.join(root, 'vieja')] });
  assert.equal(ex.count, all.count - 1);
  assert.ok(!ex.items.some((i) => i.name === 'vieja'));
  assert.equal(ex.notOfferedByReason['excluida-por-usuario'], 1);
  // Una ruta ignorada que ya no existe en este escaneo no estorba.
  const fuera = await svc.getStaleFolders({ ...base, excludedPaths: [path.join(root, '..', 'otra-cosa')] });
  assert.equal(fuera.count, all.count);
});

test('getStaleFolders: máximo 500 entradas, truncated y totales completos; mensaje pequeño', async (t) => {
  const root = tmpDir(t);
  for (let i = 0; i < 600; i++) put(root, `c${String(i).padStart(3, '0')}/a.bin`, 2000, 400);
  put(root, 'nuevo.txt', 1, 0);
  const sizes = [];
  const svc = newService(t, {
    workerFactory: () => {
      const w = new Worker(path.join(__dirname, '..', 'src', 'service', 'analysis-worker.js'));
      w.on('message', (m) => sizes.push(v8.serialize(m).length));
      return w;
    },
  });
  await svc.setUsageOptions({ useCreationTime: false });
  await svc.startScan(root);
  sizes.length = 0;
  const r = await svc.getStaleFolders({ olderThanDays: 90, minSizeBytes: 1000 });
  assert.equal(r.items.length, 500);
  assert.equal(r.count, 600);
  assert.equal(r.truncated, true);
  assert.equal(r.totalBytes, 600 * 2000);
  assert.equal(sizes.length, 1);
  assert.ok(sizes[0] < 400_000, `mensaje de ${sizes[0]} bytes`);
  assert.ok(!JSON.stringify(r).includes('"children"'));
});

test('getStaleFolders: setUsageOptions y un escaneo nuevo cambian los resultados de forma coherente (cache)', async (t) => {
  const root = tmpDir(t);
  // Carpeta con mtime viejo y atime de hoy ("antivirus").
  const f = path.join(root, 'av', 'a.bin');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.alloc(5000, 1));
  fs.utimesSync(f, new Date(), new Date(Date.now() - 700 * DAY));
  put(root, 'nuevo.txt', 1, 0);
  const svc = await newRealService(t);
  await svc.startScan(root);
  const opts = { olderThanDays: 90, minSizeBytes: 1000 };

  const a = await svc.getStaleFolders(opts);
  assert.deepEqual(a.items.map((i) => i.name), ['av']);
  assert.deepEqual(await svc.getStaleFolders(opts), a, 'misma respuesta con los mismos parámetros');
  assert.ok(a.items[0].daysUnused >= 699);

  await svc.setUsageOptions({ useAccessTime: true });
  assert.equal((await svc.getStaleFolders(opts)).count, 0, 'con el acceso contando, está en uso');
  await svc.setUsageOptions({ useAccessTime: false });
  assert.equal((await svc.getStaleFolders(opts)).count, 1);

  // Escaneo nuevo: el resultado guardado no se reutiliza.
  const otra = tmpDir(t);
  put(otra, 'x/a.bin', 5000, 800);
  put(otra, 'nuevo.txt', 1, 0);
  await svc.startScan(otra);
  const b = await svc.getStaleFolders(opts);
  assert.deepEqual(b.items.map((i) => i.name), ['x']);
  assert.ok(b.items[0].path.startsWith(otra));
});

test('getNode: confirma rutas del árbol y devuelve la ruta canónica; rechaza las demás', async (t) => {
  const root = tmpDir(t);
  buildFolders(root);
  const svc = await newRealService(t);
  await svc.startScan(root);
  const node = await svc.getNode(path.join(root, 'padre', '..', 'vieja'));
  assert.equal(node.path, path.join(root, 'vieja'));
  assert.equal(node.type, 'folder');
  assert.equal((await svc.getNode(path.join(root, 'nuevo.txt'))).type, 'file');
  for (const mala of [path.join(root, '..'), path.join(root, 'no-existe'), '', '\0', 5, null]) {
    await assert.rejects(() => svc.getNode(mala), { code: 'RUTA_DESCONOCIDA' }, String(mala));
  }
});
