'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('../src/core/datos-prueba');
const { createTestDataService } = require('../src/main/datos-prueba-service');
const { tmpDir, snapshot } = require('../test-support/transfer-helpers');

const MB = T.MB;
const tiny = (extra = {}) => [
  { name: 'Fotos ñandú 🌴', daysAgo: 400, files: [{ path: 'Playa/a.jpg', bytes: 3000 }, { path: 'leeme.txt', bytes: 10 }], emptyDirs: ['Vacía'] },
  { name: 'Reciente', daysAgo: 2, files: [{ path: 'b.bin', bytes: 2 * MB + 5 }], emptyDirs: [], ...extra },
];

// ------------------------------------------------------------------------------------ plan

test('el plan oficial: 5 carpetas de 50 a 300 MB, con tildes, ñ, emoji, subcarpetas, una carpeta vacía y las 5 antigüedades pedidas', () => {
  assert.deepEqual(T.validatePlan(), []);
  assert.equal(T.PLAN.length, 5);
  assert.deepEqual(T.PLAN.map((f) => f.daysAgo), [400, 200, 100, 30, 2]);
  for (const f of T.PLAN) {
    const bytes = f.files.reduce((s, x) => s + x.bytes, 0);
    assert.ok(bytes >= 50 * MB && bytes <= 300 * MB + 5000, `${f.name}: ${bytes}`);
  }
  const names = T.PLAN.map((f) => f.name).join('|');
  assert.match(names, /ñ/);
  assert.match(names, /🌴/);
  assert.match(names, /á|é|í|ó|ú|ñ/);
  assert.ok(T.PLAN.some((f) => /\s/.test(f.name)));
  assert.ok(T.PLAN.some((f) => f.emptyDirs.length > 0), 'una carpeta vacía');
  assert.ok(T.PLAN.some((f) => f.files.some((x) => x.path.split('/').length >= 4)), 'subcarpetas hondas');
  const t = T.planTotals();
  assert.ok(t.bytes <= T.MAX_TOTAL_BYTES, 'nunca más de 1 GB');
  assert.equal(t.folders, 5);
  assert.ok(t.bytes > 500 * MB);
});

test('validatePlan rechaza nombres de Windows no válidos, repetidos, rutas con «..», tamaños raros y más de 1 GB', () => {
  const ok = tiny();
  assert.deepEqual(T.validatePlan(ok), []);
  const casos = [
    [[], /vacío/],
    [[{ ...ok[0], name: 'a:b' }], /Nombre de carpeta/],
    [[{ ...ok[0], name: 'CON' }], /Nombre de carpeta/],
    [[{ ...ok[0], name: 'termina.' }], /Nombre de carpeta/],
    [[{ ...ok[0], name: '.byd-prueba' }], /Nombre de carpeta/],
    [[ok[0], { ...ok[1], name: 'FOTOS ñandú 🌴' }], /repetida/],
    [[{ ...ok[0], files: [{ path: '../fuera.txt', bytes: 1 }] }], /Ruta no válida/],
    [[{ ...ok[0], files: [{ path: 'a//b.txt', bytes: 1 }] }], /Ruta no válida/],
    [[{ ...ok[0], files: [{ path: 'C:/x.txt', bytes: 1 }] }], /Ruta no válida/],
    [[{ ...ok[0], files: [{ path: 'x.txt', bytes: -1 }] }], /Tamaño/],
    [[{ ...ok[0], files: [{ path: 'x.txt', bytes: 1.5 }] }], /Tamaño/],
    [[{ ...ok[0], files: [] }], /no tiene archivos/],
    [[{ ...ok[0], daysAgo: -1 }], /Antigüedad/],
    [[{ ...ok[0], files: [{ path: 'x.bin', bytes: T.GIB + 1 }] }], /más de 1 GB/],
    [[{ ...ok[0], emptyDirs: ['../x'] }], /vacía no válida/],
    [Array.from({ length: 21 }, (_, i) => ({ ...ok[0], name: `c${i}` })), /Demasiadas carpetas/],
    [null, /vacío/],
  ];
  for (const [plan, re] of casos) assert.match(T.validatePlan(plan).join(' | '), re, JSON.stringify(plan).slice(0, 60));
});

test('espacio: hace falta lo que se escribe más un margen; un espacio desconocido NO basta', () => {
  const total = 750 * MB;
  const need = T.neededFreeBytes(total);
  assert.equal(need, total + 256 * MB);
  assert.equal(T.neededFreeBytes(4 * T.GIB), 4 * T.GIB + Math.ceil(4 * T.GIB * 0.1), 'con mucho, el margen es el 10 %');
  assert.equal(T.checkSpace(need, total).ok, true, 'borde exacto');
  assert.equal(T.checkSpace(need - 1, total).ok, false);
  assert.match(T.checkSpace(100 * MB, total).reason, /No hay espacio suficiente.*hacen falta \d+ MB libres y hay 100 MB/);
  for (const raro of [null, undefined, NaN, Infinity, '5']) assert.equal(T.checkSpace(raro, total).ok, false, String(raro));
});

// ------------------------------------------------------------------------- la regla de la marca

const good = (extra = {}) => ({
  exists: true,
  isDirectory: true,
  isLink: false,
  realPathIsSame: true,
  markerText: T.markerContent({ plan: tiny() }),
  entries: ['.byd-prueba', 'Fotos ñandú 🌴', 'Reciente'],
  ...extra,
});

test('regla de la marca: solo se borra con marca válida, carpeta normal, ruta real y nada ajeno dentro', () => {
  assert.deepEqual(T.checkRemovable(good()), { ok: true, reason: null });
  const no = (info, re) => {
    const r = T.checkRemovable(info);
    assert.equal(r.ok, false);
    assert.match(r.reason, re);
    return r;
  };
  no(null, /No hay datos/);
  no(good({ exists: false }), /No hay datos/);
  no(good({ isLink: true }), /enlace/);
  no(good({ isDirectory: false }), /no es una carpeta normal/);
  no(good({ realPathIsSame: false }), /pasa por un enlace/);
  no(good({ markerText: null }), /no tiene la marca/);
  no(good({ markerText: '' }), /no tiene la marca/);
  no(good({ markerText: 'no es json' }), /no tiene la marca/);
  no(good({ markerText: JSON.stringify({ app: 'Otra', tipo: 'datos-de-prueba', carpetas: [] }) }), /no tiene la marca/);
  no(good({ markerText: JSON.stringify({ app: 'BoneYardDog', tipo: 'otra-cosa', carpetas: [] }) }), /no tiene la marca/);
  no(good({ markerText: JSON.stringify({ app: 'BoneYardDog', tipo: 'datos-de-prueba', carpetas: ['..'] }) }), /no tiene la marca/);
  no(good({ markerText: JSON.stringify({ app: 'BoneYardDog', tipo: 'datos-de-prueba', carpetas: 'x' }) }), /no tiene la marca/);
  const extra = no(good({ entries: ['.byd-prueba', 'Reciente', 'MIS FOTOS', 'tesis.docx'] }), /no son de la prueba.*MIS FOTOS, tesis\.docx/);
  assert.deepEqual(extra.extra, ['MIS FOTOS', 'tesis.docx']);
  // La marca de otra versión del plan con otras carpetas también vale mientras todo lo de dentro esté en ella.
  assert.equal(T.checkRemovable(good({ entries: ['.byd-prueba'] })).ok, true);
});

test('parseMarker: ida y vuelta, y rechaza basura y marcas enormes', () => {
  const m = T.parseMarker(T.markerContent({ version: '1.2.3', now: Date.UTC(2026, 9, 29), plan: tiny() }));
  assert.deepEqual(m.carpetas, ['Fotos ñandú 🌴', 'Reciente']);
  assert.equal(m.version, '1.2.3');
  assert.match(m.creada, /^2026-10-29/);
  for (const mal of [null, undefined, 5, '', '{}', '[]', 'x'.repeat(30000)]) assert.equal(T.parseMarker(mal), null, String(mal).slice(0, 10));
});

// ------------------------------------------------------------------ el servicio, con disco real

function makeSvc(t, extra = {}) {
  const base = tmpDir(t, 'td-');
  const docs = path.join(base, 'Documentos');
  fs.mkdirSync(docs);
  const now = () => new Date(2026, 9, 29, 12, 0).getTime();
  return { base, docs, svc: createTestDataService({ documentsDir: () => docs, version: '9.9.9', now, ...extra }), now };
}

test('crear: carpetas, nombres, tamaños exactos, fechas de modificación, carpeta vacía, marca y datos que no se repiten', async (t) => {
  const { docs, svc, now } = makeSvc(t);
  const events = [];
  const r = await svc.create({ plan: tiny(), onProgress: (e) => events.push(e) });
  const root = path.join(docs, 'BoneYardDog-Prueba');
  assert.equal(r.path, root);
  assert.deepEqual(fs.readdirSync(root).sort(), ['.byd-prueba', 'Fotos ñandú 🌴', 'Reciente'].sort());
  assert.equal(fs.statSync(path.join(root, 'Fotos ñandú 🌴', 'Playa', 'a.jpg')).size, 3000);
  assert.equal(fs.statSync(path.join(root, 'Reciente', 'b.bin')).size, 2 * MB + 5);
  assert.ok(fs.statSync(path.join(root, 'Fotos ñandú 🌴', 'Vacía')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(root, 'Fotos ñandú 🌴', 'Vacía')), []);
  const day = 24 * 3600 * 1000;
  const ageDays = (p) => Math.round((now() - fs.statSync(p).mtimeMs) / day);
  assert.equal(ageDays(path.join(root, 'Fotos ñandú 🌴', 'Playa', 'a.jpg')), 400);
  assert.equal(ageDays(path.join(root, 'Fotos ñandú 🌴', 'Playa')), 400, 'las carpetas llevan la misma fecha');
  assert.equal(ageDays(path.join(root, 'Fotos ñandú 🌴')), 400);
  assert.equal(ageDays(path.join(root, 'Reciente', 'b.bin')), 2);
  // Datos sin repetir: ningún trozo de 1 MB se repite dentro del archivo.
  const buf = fs.readFileSync(path.join(root, 'Reciente', 'b.bin'));
  assert.notDeepEqual(buf.subarray(0, MB), buf.subarray(MB, 2 * MB));
  assert.ok(buf.subarray(0, 4096).some((b) => b !== 0));
  // Progreso y marca.
  const last = events.at(-1);
  assert.equal(last.bytesDone, last.bytesTotal);
  assert.equal(last.filesDone, 3);
  const st = await svc.status();
  assert.equal(st.exists, true);
  assert.equal(st.marked, true);
  assert.equal(st.removable, true);
  assert.equal(T.parseMarker(fs.readFileSync(path.join(root, '.byd-prueba'), 'utf8')).version, '9.9.9');
});

test('crear: el plan oficial pasa la validación y NO escribe más de 1 GB (suma de lo declarado)', () => {
  assert.ok(T.planTotals().bytes <= T.MAX_TOTAL_BYTES);
});

test('crear: si ya existen datos de prueba (o cualquier cosa con ese nombre) no hace nada', async (t) => {
  const { docs, svc } = makeSvc(t);
  fs.mkdirSync(path.join(docs, 'BoneYardDog-Prueba'));
  fs.writeFileSync(path.join(docs, 'BoneYardDog-Prueba', 'mis cosas.txt'), 'mías');
  await assert.rejects(svc.create({ plan: tiny() }), { code: 'YA_EXISTEN' });
  assert.deepEqual(fs.readdirSync(path.join(docs, 'BoneYardDog-Prueba')), ['mis cosas.txt'], 'lo ajeno no se toca');
});

test('crear: sin espacio suficiente (o sin poder saberlo) avisa y no escribe nada', async (t) => {
  const { docs, svc } = makeSvc(t);
  const lowFs = {};
  lowFs.promises = new Proxy(fs.promises, {
    get(target, prop) {
      if (prop === 'statfs') return async () => ({ bavail: 10, bsize: 1024 });
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const low = createTestDataService({ documentsDir: () => docs, fs: lowFs });
  await assert.rejects(low.create({ plan: tiny() }), { code: 'SIN_ESPACIO', message: /No hay espacio suficiente/ });
  const unknown = {};
  unknown.promises = new Proxy(fs.promises, {
    get(target, prop) {
      if (prop === 'statfs') return async () => {
        throw new Error('no se sabe');
      };
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  await assert.rejects(createTestDataService({ documentsDir: () => docs, fs: unknown }).create({ plan: tiny() }), { code: 'SIN_ESPACIO', message: /No se pudo saber/ });
  assert.deepEqual(fs.readdirSync(docs), [], 'no se creó ni la carpeta');
});

test('crear: un plan no válido se rechaza antes de escribir', async (t) => {
  const { docs, svc } = makeSvc(t);
  await assert.rejects(svc.create({ plan: [{ name: 'a:b', daysAgo: 1, files: [{ path: 'x', bytes: 1 }] }] }), /no es válido/);
  assert.deepEqual(fs.readdirSync(docs), []);
});

test('cancelar a mitad: se quita lo creado y no queda nada (la marca permite borrarlo)', async (t) => {
  const { docs, svc } = makeSvc(t);
  const ctl = new AbortController();
  await assert.rejects(
    svc.create({
      plan: tiny(),
      signal: ctl.signal,
      onProgress: (e) => {
        if (e.bytesDone > 0) ctl.abort();
      },
    }),
    { name: 'AbortedError' },
  );
  assert.deepEqual(fs.readdirSync(docs), []);
});

test('un fallo de escritura a mitad (disco que falla) también deja todo limpio y relanza el error', async (t) => {
  const { docs } = makeSvc(t);
  let n = 0;
  const failing = {};
  failing.promises = new Proxy(fs.promises, {
    get(target, prop) {
      const v = target[prop];
      if (prop === 'open') {
        return async (...a) => {
          if (++n === 2) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
          return v.apply(target, a);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const svc = createTestDataService({ documentsDir: () => docs, fs: failing });
  await assert.rejects(svc.create({ plan: tiny() }), { code: 'ENOSPC' });
  assert.deepEqual(fs.readdirSync(docs), []);
});

// ------------------------------------------------------------------------------ borrar

test('borrar: con la marca, borra SOLO la carpeta de prueba y no toca nada más de Documentos', async (t) => {
  const { docs, svc } = makeSvc(t);
  fs.writeFileSync(path.join(docs, 'mi tesis.docx'), 'importante');
  fs.mkdirSync(path.join(docs, 'Otra carpeta'));
  fs.writeFileSync(path.join(docs, 'Otra carpeta', 'x.txt'), 'x');
  const before = snapshot(docs);
  await svc.create({ plan: tiny() });
  await svc.removeRoot();
  assert.deepEqual(snapshot(docs), before);
  assert.equal((await svc.status()).exists, false);
  await assert.rejects(svc.removeRoot(), { code: 'NO_SE_BORRA', message: /No hay datos de prueba/ });
});

test('borrar SIN marca: no borra nada (aunque la carpeta se llame igual)', async (t) => {
  const { docs, svc } = makeSvc(t);
  const root = path.join(docs, 'BoneYardDog-Prueba');
  fs.mkdirSync(path.join(root, 'Reciente'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Reciente', 'b.bin'), 'datos del usuario');
  const before = snapshot(root);
  await assert.rejects(svc.removeRoot(), { code: 'NO_SE_BORRA', message: /no tiene la marca/ });
  assert.deepEqual(snapshot(root), before);
  // Con la marca borrada a mano después de crear, tampoco.
  fs.rmSync(root, { recursive: true });
  await svc.create({ plan: tiny() });
  fs.unlinkSync(path.join(root, '.byd-prueba'));
  const mid = snapshot(root);
  await assert.rejects(svc.removeRoot(), { code: 'NO_SE_BORRA' });
  assert.deepEqual(snapshot(root), mid);
});

test('borrar con algo AJENO dentro: no borra nada y dice qué es', async (t) => {
  const { docs, svc } = makeSvc(t);
  await svc.create({ plan: tiny() });
  const root = path.join(docs, 'BoneYardDog-Prueba');
  fs.writeFileSync(path.join(root, 'mi archivo.txt'), 'mío');
  const before = snapshot(root);
  await assert.rejects(svc.removeRoot(), { code: 'NO_SE_BORRA', message: /no son de la prueba.*mi archivo\.txt/ });
  assert.deepEqual(snapshot(root), before);
});

test('borrar: si «BoneYardDog-Prueba» es un enlace (o pasa por uno), no se toca ni lo que hay al otro lado', async (t) => {
  const { base, docs, svc } = makeSvc(t);
  const real = path.join(base, 'real');
  fs.mkdirSync(path.join(real, 'Reciente'), { recursive: true });
  fs.writeFileSync(path.join(real, '.byd-prueba'), T.markerContent({ plan: tiny() }));
  fs.writeFileSync(path.join(real, 'Reciente', 'b.bin'), 'x');
  try {
    fs.symlinkSync(real, path.join(docs, 'BoneYardDog-Prueba'), 'dir');
  } catch (err) {
    t.skip(`No se pueden crear enlaces aquí (${err.code})`);
    return;
  }
  const before = snapshot(real);
  await assert.rejects(svc.removeRoot(), { code: 'NO_SE_BORRA', message: /enlace/ });
  assert.deepEqual(snapshot(real), before);
  // Y una carpeta Documentos que es un enlace hacia otro sitio: la ruta real no coincide.
  fs.unlinkSync(path.join(docs, 'BoneYardDog-Prueba'));
});

test('REGLA (código fuente): el servicio solo borra en removeRoot, después de la regla de la marca', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'datos-prueba-service.js'), 'utf8');
  const calls = [...src.matchAll(/\.(rm|unlink|rmdir|rename|truncate)\(/g)];
  assert.equal(calls.length, 1);
  assert.match(src, /async function removeRoot\(\) \{[\s\S]*?checkRemovable\(info\)[\s\S]*?if \(!verdict\.ok\) throw[\s\S]*?fsp\.rm\(info\.path, \{ recursive: true, force: false \}\)/);
  assert.doesNotMatch(src, /force:\s*true|rimraf|child_process/);
  // La ruta la fija el principal: nada de este módulo recibe una ruta de la interfaz.
  assert.match(src, /const rootPath = \(\) => nodePath\.join\(documentsDir\(\), T\.ROOT_NAME\)/);
});
