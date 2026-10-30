'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRegistry, validRecord, MAX_RECORDS } = require('../src/core/registro');
const { tmpDir } = require('../test-support/transfer-helpers');

const rec = (extra = {}) => ({
  version: 1,
  nombre: 'Fotos',
  origen: 'C:\\Datos\\Fotos',
  destino: 'E:\\Fotos',
  destinoRaiz: 'E:\\',
  fecha: '2026-10-29T10:00:00.000Z',
  modo: 'copy',
  verificacion: 'full',
  sistemaDeArchivos: 'exFAT',
  totalBytes: 12,
  archivos: [{ ruta: 'a.txt', tamano: 12, mtimeMs: 1, sha256: 'a'.repeat(64) }],
  carpetasVacias: ['vacia'],
  original: { accion: 'sin-tocar', motivo: null },
  ...extra,
});
const mk = (t, opts = {}) => createRegistry({ dir: path.join(tmpDir(t, 'reg-'), 'registros'), ...opts });

test('guardar, leer, listar (sin archivos), actualizar y quitar un registro; sin temporales sueltos', async (t) => {
  const reg = mk(t);
  const id = await reg.save(rec());
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.deepEqual(fs.readdirSync(reg.dir), [`${id}.json`], 'escritura atómica: no queda ningún archivo temporal');
  const got = await reg.get(id);
  assert.equal(got.nombre, 'Fotos');
  assert.equal(got.archivos.length, 1);
  const list = await reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].archivosTotal, 1);
  assert.equal(list[0].archivos, undefined);
  assert.equal(await reg.update(id, { original: { accion: 'papelera', motivo: null }, id: 'otro', archivos: [] }), true);
  const after = await reg.get(id);
  assert.deepEqual(after.original, { accion: 'papelera', motivo: null });
  assert.equal(after.id, id, 'el id no se puede cambiar');
  assert.equal(after.archivos.length, 1, 'los archivos no se pueden cambiar');
  assert.equal(await reg.remove(id), true);
  assert.equal(await reg.get(id), null);
  assert.equal(await reg.remove(id), false);
  assert.deepEqual(await reg.list(), []);
});

test('lo dañado, de otra versión, con otro formato o con ids raros se IGNORA sin romper la lista', async (t) => {
  const reg = mk(t);
  const bueno = await reg.save(rec({ nombre: 'Bueno' }));
  const put = (name, text) => fs.writeFileSync(path.join(reg.dir, name), text);
  put('aaaaaaaaaaaaaaaa.json', '{ roto');
  put('bbbbbbbbbbbbbbbb.json', JSON.stringify({ ...rec(), id: 'bbbbbbbbbbbbbbbb', version: 9 }));
  put('cccccccccccccccc.json', JSON.stringify({ ...rec(), id: 'cccccccccccccccc', archivos: 'no-es-lista' }));
  put('dddddddddddddddd.json', JSON.stringify({ ...rec(), id: 'dddddddddddddddd', archivos: [{ ruta: '', tamano: 1, mtimeMs: 0, sha256: null }] }));
  put('eeeeeeeeeeeeeeee.json', JSON.stringify({ ...rec(), id: 'ffffffffffffffff' })); // el id no coincide con el nombre
  put('..json', 'x');
  put('notas.txt', 'no es un registro');
  assert.deepEqual((await reg.list()).map((r) => r.id), [bueno]);
  for (const id of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', 'dddddddddddddddd', 'eeeeeeeeeeeeeeee']) assert.equal(await reg.get(id), null, id);
  for (const malo of ['../x', '', null, undefined, 5, 'ABCDEFABCDEFABCD', 'abc']) {
    assert.equal(await reg.get(malo), null);
    assert.equal(await reg.remove(malo), false, 'un id raro nunca borra nada');
    assert.equal(await reg.update(malo, {}), false);
  }
  assert.ok(fs.existsSync(path.join(reg.dir, `${bueno}.json`)));
  // Una carpeta de registro que no existe o no se puede leer: lista vacía.
  assert.deepEqual(await createRegistry({ dir: path.join(reg.dir, 'no', 'existe') }).list(), []);
});

test('guardar rechaza un registro mal formado; conserva los últimos N (por fecha)', async (t) => {
  const reg = mk(t, { maxRecords: 3 });
  await assert.rejects(reg.save({ ...rec(), modo: 'otro' }), /formato esperado/);
  await assert.rejects(reg.save({ ...rec(), archivos: null }), /formato esperado/);
  assert.equal(validRecord({ ...rec(), id: '0123456789abcdef' }), true);
  assert.equal(validRecord(rec()), false, 'sin id no vale');
  assert.equal(MAX_RECORDS, 200);
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(await reg.save(rec({ nombre: `C${i}`, fecha: `2026-10-0${i + 1}T10:00:00.000Z` })));
  const left = (await reg.list()).map((r) => r.nombre);
  assert.deepEqual(left, ['C4', 'C3', 'C2'], 'se conservan las 3 más recientes');
});

test('una escritura que falla no deja el registro a medias ni archivos temporales', async (t) => {
  const base = tmpDir(t, 'reg-');
  const failing = { promises: new Proxy(fs.promises, { get(target, prop) { if (prop === 'rename') return async () => { throw Object.assign(new Error('disco lleno'), { code: 'ENOSPC' }); }; const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; } }) };
  const reg = createRegistry({ dir: path.join(base, 'registros'), fs: failing });
  await assert.rejects(reg.save(rec()), { code: 'ENOSPC' });
  assert.deepEqual(fs.readdirSync(path.join(base, 'registros')), [], 'sin registro y sin temporal');
});

test('diario de carpetas provisionales: añadir, quitar, sin repetir, y un diario dañado se ignora; las escrituras se encolan', async (t) => {
  const reg = mk(t);
  await Promise.all([reg.addPending({ ruta: 'E:\\A.copiando', raiz: 'E:\\', origen: 'C:\\A' }), reg.addPending({ ruta: 'E:\\B.copiando', raiz: 'E:\\' }), reg.addPending({ ruta: 'E:\\A.copiando', raiz: 'E:\\' })]);
  assert.deepEqual((await reg.listPending()).map((p) => p.ruta).sort(), ['E:\\A.copiando', 'E:\\B.copiando']);
  await reg.removePending('E:\\A.copiando');
  await reg.removePending('E:\\NO-ESTA.copiando');
  assert.deepEqual((await reg.listPending()).map((p) => p.ruta), ['E:\\B.copiando']);
  fs.writeFileSync(path.join(reg.dir, 'pendientes.json'), 'basura');
  assert.deepEqual(await reg.listPending(), []);
  fs.writeFileSync(path.join(reg.dir, 'pendientes.json'), JSON.stringify({ version: 1, pendientes: [{ ruta: 5 }, { ruta: 'E:\\C.copiando', raiz: 'E:\\', creada: 'hoy' }, null] }));
  assert.deepEqual((await reg.listPending()).map((p) => p.ruta), ['E:\\C.copiando']);
});
