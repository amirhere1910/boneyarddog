'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scan } = require('../src/core/scanner');
const {
  DAY_MS,
  topLargestFiles,
  topLargestFolders,
  lastUsedDate,
  findStale,
  findStaleFolders,
  atimeReliability,
  summarize,
} = require('../src/core/analysis');

// --- Constructores de árboles sintéticos (sin disco) -----------------------

function file(p, size, { atime = 0, mtime = 0, birth = 0 } = {}) {
  return {
    name: p.split(/[\\/]/).pop(),
    path: p,
    type: 'file',
    size,
    atimeMs: atime,
    mtimeMs: mtime,
    birthtimeMs: birth,
    fileCount: 1,
  };
}

function folder(p, children = [], { atime = 0, mtime = 0 } = {}) {
  return {
    name: p.split(/[\\/]/).pop(),
    path: p,
    type: 'folder',
    size: children.reduce((s, c) => s + c.size, 0),
    atimeMs: atime,
    mtimeMs: mtime,
    birthtimeMs: 0,
    fileCount: children.reduce((s, c) => s + c.fileCount, 0),
    children,
  };
}

const NOW = Date.UTC(2025, 0, 1);
// Las carpetas temporales reales pueden estar dentro de AppData (Windows), que está
// protegida. Las pruebas con archivos reales inyectan "nada protegido".
const NO_PROT = () => false;
// Con archivos reales la fecha de creación es siempre "ahora" (no se puede retrasar):
// estas pruebas la desactivan y la lógica de creación se prueba con árboles sintéticos.
const REAL = { isProtected: NO_PROT, useCreationTime: false };
const daysAgo = (d) => NOW - d * DAY_MS;

function allNodes(node, out = []) {
  out.push(node);
  (node.children || []).forEach((c) => allNodes(c, out));
  return out;
}

function isInside(parent, child) {
  return child.path !== parent.path && child.path.startsWith(parent.path + '/');
}

// --- topLargestFiles --------------------------------------------------------

test('topLargestFiles: devuelve los n más grandes en orden', () => {
  const tree = folder('/r', [
    file('/r/a', 10),
    folder('/r/d', [file('/r/d/b', 300), file('/r/d/c', 20)]),
    file('/r/e', 150),
  ]);
  assert.deepEqual(topLargestFiles(tree, 2).map((f) => f.path), ['/r/d/b', '/r/e']);
  assert.equal(topLargestFiles(tree, 99).length, 4, 'n mayor que la cantidad');
  assert.deepEqual(topLargestFiles(tree, 0), []);
  assert.deepEqual(topLargestFiles(null, 3), []);
});

test('topLargestFiles: empates se ordenan por ruta (resultado estable)', () => {
  const tree = folder('/r', [file('/r/z', 5), file('/r/a', 5), file('/r/m', 5)]);
  assert.deepEqual(topLargestFiles(tree, 3).map((f) => f.path), ['/r/a', '/r/m', '/r/z']);
});

// --- topLargestFolders ------------------------------------------------------

test('topLargestFolders: C:\\Users\\amir con Videos 40, Docs 35 y Fotos 25, n = 3 => las tres', () => {
  const GB = 1e9;
  const tree = folder('C:\\Users\\amir', [
    folder('C:\\Users\\amir\\Videos', [file('C:\\Users\\amir\\Videos\\v.mp4', 40 * GB)]),
    folder('C:\\Users\\amir\\Docs', [file('C:\\Users\\amir\\Docs\\d.pdf', 35 * GB)]),
    folder('C:\\Users\\amir\\Fotos', [file('C:\\Users\\amir\\Fotos\\f.jpg', 25 * GB)]),
  ]);
  assert.deepEqual(
    topLargestFolders(tree, 3).map((f) => f.name),
    ['Videos', 'Docs', 'Fotos'],
  );
});

test('topLargestFolders: abre la más pesada que tenga subcarpetas hasta llegar a n', () => {
  const tree = folder('/r', [
    folder('/r/Users', [
      folder('/r/Users/amir', [file('/r/Users/amir/a', 495)]),
      file('/r/Users/l.txt', 5),
    ]),
    folder('/r/Otro', [
      folder('/r/Otro/A', [file('/r/Otro/A/a', 50)]),
      folder('/r/Otro/B', [file('/r/Otro/B/b', 40)]),
    ]),
  ]);
  // Raíz: Users (500), Otro (90). Con n = 2 ya hay 2 entradas: no se abre nada.
  assert.deepEqual(topLargestFolders(tree, 2).map((f) => f.path), ['/r/Users', '/r/Otro']);
  // n = 3: faltan entradas, se abre Users (la más pesada con subcarpetas) => Otro, amir (2),
  // todavía falta una, se abre Otro => amir, A, B.
  assert.deepEqual(topLargestFolders(tree, 3).map((f) => f.path), ['/r/Users/amir', '/r/Otro/A', '/r/Otro/B']);
  // n = 4: solo hay 3 disponibles, devuelve las 3.
  assert.deepEqual(topLargestFolders(tree, 4).map((f) => f.path), ['/r/Users/amir', '/r/Otro/A', '/r/Otro/B']);
});

test('topLargestFolders: n mayor que lo disponible devuelve lo que haya', () => {
  const tree = folder('/r', [folder('/r/A', [file('/r/A/f', 5)]), folder('/r/B', [file('/r/B/f', 9)])]);
  assert.deepEqual(topLargestFolders(tree, 50).map((f) => f.path), ['/r/B', '/r/A']);
});

test('topLargestFolders: nunca devuelve padre e hijo a la vez', () => {
  const tree = folder('/r', [
    folder('/r/A', [folder('/r/A/B', [folder('/r/A/B/C', [file('/r/A/B/C/f', 90)]), file('/r/A/B/g', 5)]), file('/r/A/h', 5)]),
    folder('/r/X', [folder('/r/X/Y', [file('/r/X/Y/f', 30)]), folder('/r/X/Z', [file('/r/X/Z/f', 20)])]),
  ]);
  for (let n = 1; n <= 8; n++) {
    const top = topLargestFolders(tree, n);
    assert.ok(top.length <= n);
    for (const a of top) for (const b of top) assert.ok(!isInside(a, b), `n=${n}: ${b.path} dentro de ${a.path}`);
  }
});

test('topLargestFolders: la raíz no cuenta y los casos vacíos devuelven []', () => {
  const tree = folder('/r', [folder('/r/A', [file('/r/A/f', 5)])]);
  assert.ok(!topLargestFolders(tree, 5).some((f) => f.path === '/r'));
  assert.deepEqual(topLargestFolders(folder('/r', []), 5), []);
  assert.deepEqual(topLargestFolders(folder('/r', [file('/r/a', 1)]), 5), []);
  assert.deepEqual(topLargestFolders(null, 5), []);
  assert.deepEqual(topLargestFolders(tree, 0), []);
});

// --- lastUsedDate -----------------------------------------------------------

test('lastUsedDate: archivo = el más reciente entre mtime, creación y (si se pide) atime', () => {
  const f = file('/r/a', 1, { atime: 900, mtime: 500, birth: 700 });
  assert.equal(lastUsedDate(f), 700, 'por defecto: mtime y creación; el acceso se ignora');
  assert.equal(lastUsedDate(f, { useAccessTime: true }), 900);
  assert.equal(lastUsedDate(f, { useCreationTime: false }), 500);
  assert.equal(lastUsedDate(f, { useAccessTime: true, useCreationTime: false }), 900);
  assert.equal(lastUsedDate(file('/r/a', 1, { atime: 100, mtime: 500 }), { useAccessTime: true }), 500);
});

test('lastUsedDate: carpeta = lo más reciente de todo su contenido (a cualquier profundidad)', () => {
  const tree = folder('/r', [
    file('/r/a', 1, { atime: 10, mtime: 20 }),
    folder('/r/d', [folder('/r/d/e', [file('/r/d/e/f', 1, { atime: 700, mtime: 30 })])]),
  ]);
  assert.equal(lastUsedDate(tree, { useAccessTime: true }), 700);
  assert.equal(lastUsedDate(tree), 30, 'sin contar el acceso, lo más reciente es el mtime de f');
});

test('lastUsedDate: el atime propio de una carpeta se ignora; vacía usa su mtime', () => {
  const conContenido = folder('/r', [file('/r/a', 1, { atime: 10, mtime: 20 })], { atime: 99999, mtime: 88888 });
  assert.equal(lastUsedDate(conContenido, { useAccessTime: true }), 20, 'ni el atime ni el mtime de la carpeta pesan si hay contenido');
  const vacia = folder('/r/v', [], { atime: 99999, mtime: 55 });
  assert.equal(lastUsedDate(vacia), 55);
});

test('lastUsedDate: sin fechas válidas devuelve null', () => {
  const raro = { ...file('/r/a', 1), atimeMs: NaN, mtimeMs: undefined };
  assert.equal(lastUsedDate(raro), null);
});

// --- findStale (con archivos reales y fs.utimes) ----------------------------

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-an-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, bytes, { atimeDaysAgo, mtimeDaysAgo }) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  const m = mtimeDaysAgo === undefined ? atimeDaysAgo : mtimeDaysAgo;
  fs.utimesSync(full, new Date(daysAgo(atimeDaysAgo)), new Date(daysAgo(m)));
  return full;
}

async function sampleStaleTree(t) {
  const root = tmpDir(t);
  // Carpeta totalmente abandonada: todo con más de 2 años.
  put(root, 'abandonada/uno.bin', 1000, { atimeDaysAgo: 800 });
  put(root, 'abandonada/sub/dos.bin', 2000, { atimeDaysAgo: 900 });
  put(root, 'abandonada/sub/tres.bin', 3000, { atimeDaysAgo: 1000 });
  // Carpeta con un solo archivo reciente: NO está abandonada.
  put(root, 'mixta/viejo_grande.bin', 5000, { atimeDaysAgo: 700 });
  put(root, 'mixta/viejo_chico.bin', 10, { atimeDaysAgo: 700 });
  put(root, 'mixta/reciente.bin', 20, { atimeDaysAgo: 3 });
  // Sueltos en la raíz.
  put(root, 'reciente.txt', 4000, { atimeDaysAgo: 1 });
  put(root, 'viejo_suelto.iso', 6000, { atimeDaysAgo: 500 });
  const { tree } = await scan(root);
  return { root, tree };
}

test('findStale: carpeta abandonada sale como UNA entrada; la que tiene un archivo reciente se desglosa', async (t) => {
  const { root, tree } = await sampleStaleTree(t);
  const { items, totalBytes } = findStale(tree, { olderThanDays: 365, minSizeBytes: 100, now: NOW, ...REAL });

  // Orden: por tamaño, de mayor a menor.
  assert.deepEqual(
    items.map((i) => path.relative(root, i.path)),
    ['abandonada', 'viejo_suelto.iso', path.join('mixta', 'viejo_grande.bin')],
  );
  const abandonada = items[0];
  assert.equal(abandonada.type, 'folder');
  assert.equal(abandonada.size, 6000);
  assert.equal(abandonada.fileCount, 3);
  assert.equal(abandonada.daysUnused, 800, 'la fecha de uso de la carpeta es la de su archivo más reciente');
  assert.equal(totalBytes, 6000 + 6000 + 5000);
});

test('findStale: minSizeBytes descarta lo pequeño; sin mínimo aparece todo lo viejo', async (t) => {
  const { root, tree } = await sampleStaleTree(t);
  const sinMinimo = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL });
  assert.ok(sinMinimo.items.some((i) => i.path === path.join(root, 'mixta', 'viejo_chico.bin')));
  const conMinimo = findStale(tree, { olderThanDays: 365, minSizeBytes: 100, now: NOW, ...REAL });
  assert.ok(!conMinimo.items.some((i) => i.path.endsWith('viejo_chico.bin')));
});

test('findStale: las entradas nunca se solapan (no hay padre e hijo a la vez)', async (t) => {
  const { tree } = await sampleStaleTree(t);
  const { items } = findStale(tree, { olderThanDays: 30, now: NOW, ...REAL });
  for (const a of items) {
    for (const b of items) {
      if (a === b) continue;
      assert.ok(!b.path.startsWith(a.path + path.sep), `${b.path} dentro de ${a.path}`);
    }
  }
});

test('findStale: si TODO está abandonado, la raíz sale como una sola entrada', async (t) => {
  const root = tmpDir(t);
  put(root, 'x/a.bin', 10, { atimeDaysAgo: 900 });
  put(root, 'y.bin', 10, { atimeDaysAgo: 900 });
  const { tree } = await scan(root);
  const { items } = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL });
  assert.equal(items.length, 1);
  assert.equal(items[0].path, root);
});

test('(a) mtime de hace 800 días y atime de hace 3: sin uso por defecto; con useAccessTime, en uso', async (t) => {
  const root = tmpDir(t);
  const full = path.join(root, 'leido.bin');
  fs.writeFileSync(full, Buffer.alloc(50, 1));
  fs.utimesSync(full, new Date(daysAgo(3)), new Date(daysAgo(800))); // (atime, mtime)
  put(root, 'nuevo.txt', 5, { atimeDaysAgo: 1 }); // evita que la raíz entera sea una sola entrada
  const { tree } = await scan(root);
  const porDefecto = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL });
  assert.deepEqual(porDefecto.items.map((i) => path.basename(i.path)), ['leido.bin']);
  assert.equal(porDefecto.items[0].daysUnused, 800);
  const conAcceso = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL, useAccessTime: true });
  assert.equal(conAcceso.items.length, 0);
});

test('(b) mtime viejo y creación de hace 2 días (carpeta restaurada de un respaldo): en uso por defecto', () => {
  const restaurada = folder('/r/restaurada', [
    file('/r/restaurada/a.bin', 10, { atime: daysAgo(900), mtime: daysAgo(900), birth: daysAgo(2) }),
    file('/r/restaurada/b.bin', 10, { atime: daysAgo(900), mtime: daysAgo(900), birth: daysAgo(2) }),
  ]);
  const vieja = folder('/r/vieja', [file('/r/vieja/c.bin', 10, { atime: daysAgo(900), mtime: daysAgo(900), birth: daysAgo(900) })]);
  const tree = folder('/r', [restaurada, vieja, file('/r/nuevo', 1, { atime: daysAgo(1), mtime: daysAgo(1), birth: daysAgo(1) })]);

  const def = findStale(tree, { olderThanDays: 365, now: NOW, isProtected: NO_PROT });
  assert.deepEqual(def.items.map((i) => i.path), ['/r/vieja'], 'la restaurada está en uso');
  const sinCreacion = findStale(tree, { olderThanDays: 365, now: NOW, isProtected: NO_PROT, useCreationTime: false });
  assert.deepEqual(sinCreacion.items.map((i) => i.path).sort(), ['/r/restaurada', '/r/vieja']);
  assert.equal(lastUsedDate(restaurada), daysAgo(2));
  assert.equal(lastUsedDate(restaurada, { useCreationTime: false }), daysAgo(900));
});

test('(c) una carpeta con un solo archivo reciente entre miles viejos está en uso', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const hijos = Array.from({ length: 3000 }, (_, i) => file(`/r/gran/f${i}`, 10, old));
  hijos.push(file('/r/gran/reciente.txt', 1, { atime: daysAgo(900), mtime: daysAgo(5) }));
  const gran = folder('/r/gran', hijos);
  assert.equal(lastUsedDate(gran), daysAgo(5));
  const tree = folder('/r', [gran, file('/r/nuevo', 1, { atime: daysAgo(1), mtime: daysAgo(1) })]);
  const { items } = findStale(tree, { olderThanDays: 90, now: NOW, isProtected: NO_PROT });
  assert.ok(!items.some((i) => i.path === '/r/gran'), 'la carpeta no sale entera');
  assert.equal(items.length, 3000, 'los archivos viejos salen sueltos (findStale es el detector de archivos)');
});

test('(d) carpeta vacía vieja: su fecha es su mtime', () => {
  const vacia = folder('/r/vacia', [], { atime: daysAgo(1), mtime: daysAgo(700) });
  assert.equal(lastUsedDate(vacia), daysAgo(700));
  assert.equal(lastUsedDate(vacia, { useAccessTime: true }), daysAgo(700), 'su atime propio nunca cuenta');
  const tree = folder('/r', [vacia, file('/r/nuevo', 1, { atime: daysAgo(1), mtime: daysAgo(1) })]);
  assert.deepEqual(findStale(tree, { olderThanDays: 365, now: NOW, isProtected: NO_PROT }).items.map((i) => i.path), ['/r/vacia']);
});

test('(e) fechas inválidas o en 0 no cuentan como uso y nunca se ofrecen como abandonadas', () => {
  const malas = [0, -5, NaN, Infinity, -Infinity, undefined, null, '1700000000000'];
  for (const mala of malas) {
    const f = { ...file('/r/a', 10), atimeMs: mala, mtimeMs: mala, birthtimeMs: mala };
    assert.equal(lastUsedDate(f, { useAccessTime: true }), null, String(mala));
  }
  // Una fecha válida compensa a las inválidas.
  assert.equal(lastUsedDate({ ...file('/r/a', 1), mtimeMs: 0, atimeMs: NaN, birthtimeMs: daysAgo(40) }), daysAgo(40));
  assert.equal(lastUsedDate({ ...file('/r/a', 1), mtimeMs: daysAgo(40), atimeMs: -1, birthtimeMs: 0 }, { useAccessTime: true }), daysAgo(40));

  const sinFechas = { ...file('/r/carpeta/sin', 10), name: 'sin', atimeMs: 0, mtimeMs: 0, birthtimeMs: 0 };
  const viejo = file('/r/carpeta/viejo', 10, { mtime: daysAgo(900) });
  const mezcla = folder('/r/carpeta', [sinFechas, viejo]);
  assert.equal(lastUsedDate(mezcla), daysAgo(900), 'el archivo sin fechas no ensucia la carpeta');

  // Sin fechas válidas el uso es desconocido, y lo desconocido nunca se ofrece como abandonado.
  const tree = folder('/r', [mezcla, file('/r/nuevo', 1, { mtime: daysAgo(1) })]);
  const { items } = findStale(tree, { olderThanDays: 365, now: NOW, isProtected: NO_PROT });
  assert.deepEqual(items.map((i) => i.path), ['/r/carpeta']);
  const soloSin = folder('/r', [{ ...sinFechas, path: '/r/sin' }, file('/r/nuevo', 1, { mtime: daysAgo(1) })]);
  assert.deepEqual(findStale(soloSin, { olderThanDays: 365, now: NOW, isProtected: NO_PROT }).items, []);
});

test('findStale: el límite es "más de N días" (exactamente N no cuenta)', () => {
  const tree = folder('/r', [
    file('/r/justo', 10, { atime: daysAgo(100), mtime: daysAgo(100) }),
    file('/r/pasado', 10, { atime: daysAgo(100) - 1, mtime: daysAgo(100) - 1 }),
  ]);
  const { items } = findStale(tree, { olderThanDays: 100, now: NOW });
  assert.deepEqual(items.map((i) => i.path), ['/r/pasado']);
});

test('findStale: now se inyecta (mismo árbol, distinto "hoy", distinto resultado)', () => {
  const tree = folder('/r', [file('/r/a', 10, { atime: daysAgo(10), mtime: daysAgo(10) })]);
  assert.equal(findStale(tree, { olderThanDays: 30, now: NOW }).items.length, 0);
  assert.equal(findStale(tree, { olderThanDays: 30, now: NOW + 60 * DAY_MS }).items.length, 1);
});

test('findStale: carpeta ilegible (incomplete) no se ofrece entera', () => {
  const sinLeer = { ...folder('/r/cerrada', [], { mtime: daysAgo(900) }), incomplete: true };
  const tree = folder('/r', [
    sinLeer,
    file('/r/f', 5, { atime: daysAgo(900), mtime: daysAgo(900) }),
    file('/r/nuevo', 5, { atime: daysAgo(1), mtime: daysAgo(1) }), // evita que la raíz entera esté abandonada
  ]);
  const { items } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.deepEqual(items.map((i) => i.path), ['/r/f']);
});

test('findStale: árbol nulo y opciones inválidas', () => {
  assert.deepEqual(findStale(null, { olderThanDays: 1 }), { items: [], notOffered: [], totalBytes: 0 });
  assert.throws(() => findStale(folder('/r', []), {}), RangeError);
  assert.throws(() => findStale(folder('/r', []), { olderThanDays: -1 }), RangeError);
});

test('findStale: con un verificador de protección inyectado, excluye y avisa', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const tree = folder('/r', [
    folder('/r/sistema', [file('/r/sistema/a', 100, old)]),
    folder('/r/mezcla', [file('/r/mezcla/ok', 70, old), folder('/r/mezcla/nucleo', [file('/r/mezcla/nucleo/b', 60, old)])]),
    file('/r/libre', 50, old),
  ]);
  const isProtected = (p) => p === '/r/sistema' || p.startsWith('/r/sistema/') || p === '/r/mezcla/nucleo' || p.startsWith('/r/mezcla/nucleo/');
  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW, isProtected });

  assert.deepEqual(items.map((i) => i.path).sort(), ['/r/libre', '/r/mezcla/ok']);
  const reasons = Object.fromEntries(notOffered.map((p) => [p.path, p.reason]));
  assert.equal(reasons['/r/sistema'], 'protegido');
  assert.equal(reasons['/r/mezcla'], 'contiene-protegidos');
  assert.equal(reasons['/r/mezcla/nucleo'], 'protegido');
  assert.ok(!items.some((i) => i.path === '/r' || i.path === '/r/mezcla'), 'ni la raíz ni la mezcla enteras');
});

// --- atimeReliability --------------------------------------------------------

function manyFiles(n, make) {
  return folder('/r', Array.from({ length: n }, (_, i) => file(`/r/f${i}`, 1, make(i))));
}

test('atimeReliability: atime igual a mtime en casi todo => poco fiable, con explicación', () => {
  const tree = manyFiles(40, (i) => ({ atime: daysAgo(200 + i), mtime: daysAgo(200 + i) }));
  const r = atimeReliability(tree);
  assert.equal(r.level, 'poco-fiable');
  assert.equal(r.reliable, false);
  assert.equal(r.ratio, 1);
  assert.match(r.message, /poco fiable/);
  assert.match(r.message, /40 de 40/);
  assert.match(r.message, /modificación/);
});

test('atimeReliability: atime igual a la fecha de creación también cuenta', () => {
  const tree = manyFiles(30, (i) => ({ atime: daysAgo(50 + i), mtime: daysAgo(10), birth: daysAgo(50 + i) }));
  assert.equal(atimeReliability(tree).level, 'poco-fiable');
});

test('atimeReliability: atime variado e independiente => fiable', () => {
  const tree = manyFiles(40, (i) => ({ atime: daysAgo(i), mtime: daysAgo(300 + i), birth: daysAgo(500 + i) }));
  const r = atimeReliability(tree);
  assert.equal(r.level, 'fiable');
  assert.equal(r.reliable, true);
  assert.match(r.message, /fiable/);
});

test('atimeReliability: pocos archivos => indeterminado (no opina)', () => {
  const r = atimeReliability(manyFiles(5, (i) => ({ atime: i, mtime: i })));
  assert.equal(r.level, 'indeterminado');
  assert.equal(r.reliable, null);
  assert.match(r.message, /muy pocos archivos/);
  assert.equal(atimeReliability(null).level, 'indeterminado');
  assert.equal(atimeReliability(folder('/r', [])).level, 'indeterminado');
});

test('atimeReliability: el umbral es 90 % (27 de 30 ya es poco fiable, 26 de 30 no)', () => {
  const build = (similar) =>
    manyFiles(30, (i) =>
      i < similar ? { atime: daysAgo(100), mtime: daysAgo(100) } : { atime: daysAgo(1), mtime: daysAgo(400) },
    );
  assert.equal(atimeReliability(build(27)).level, 'poco-fiable');
  assert.equal(atimeReliability(build(26)).level, 'fiable');
});

test('atimeReliability: tolerancia de 2 s (sistemas de archivos con fechas redondeadas)', () => {
  const tree = manyFiles(30, (i) => ({ atime: daysAgo(100 + i) + 1500, mtime: daysAgo(100 + i) }));
  assert.equal(atimeReliability(tree).level, 'poco-fiable');
  const lejos = manyFiles(30, (i) => ({ atime: daysAgo(100 + i) + 5000, mtime: daysAgo(100 + i) }));
  assert.equal(atimeReliability(lejos).level, 'fiable');
});

// --- summarize ---------------------------------------------------------------

test('summarize: suma simple', () => {
  const a = file('/r/a', 100);
  const b = file('/r/b', 250);
  const r = summarize([a, b]);
  assert.equal(r.totalBytes, 350);
  assert.equal(r.totalFiles, 2);
  assert.deepEqual(r.excluded, []);
});

test('summarize: carpeta + algo dentro de ella no se cuenta dos veces', () => {
  const dentro = file('/r/d/sub/x.bin', 400);
  const otro = file('/r/d/y.bin', 100);
  const d = folder('/r/d', [folder('/r/d/sub', [dentro]), otro]);
  const fuera = file('/r/z.bin', 7);

  const r = summarize([dentro, d, fuera, otro]);
  assert.equal(r.totalBytes, 500 + 7);
  assert.equal(r.totalFiles, 3);
  assert.deepEqual(r.counted.map((n) => n.path).sort(), ['/r/d', '/r/z.bin']);
  assert.deepEqual(
    r.excluded.map((e) => [e.node.path, e.reason]).sort(),
    [['/r/d/sub/x.bin', 'dentro-de-otro-seleccionado'], ['/r/d/y.bin', 'dentro-de-otro-seleccionado']],
  );
});

test('summarize: el orden de la selección no importa', () => {
  const dentro = file('/r/d/x.bin', 400);
  const d = folder('/r/d', [dentro]);
  assert.equal(summarize([dentro, d]).totalBytes, 400);
  assert.equal(summarize([d, dentro]).totalBytes, 400);
});

test('summarize: abuelo, padre e hijo seleccionados cuentan solo al abuelo', () => {
  const f = file('/r/a/b/f', 10);
  const b = folder('/r/a/b', [f]);
  const a = folder('/r/a', [b]);
  assert.equal(summarize([f, b, a]).totalBytes, 10);
});

test('summarize: el mismo nodo (o una copia con la misma ruta) cuenta una vez', () => {
  const a = file('/r/a', 100);
  const copia = JSON.parse(JSON.stringify(a));
  const r = summarize([a, a, copia]);
  assert.equal(r.totalBytes, 100);
  assert.equal(r.excluded.length, 2);
  assert.ok(r.excluded.every((e) => e.reason === 'duplicado'));
});

test('summarize: prefijos parecidos no son anidados (/r/foo vs /r/foobar)', () => {
  const foo = folder('/r/foo', [file('/r/foo/a', 10)]);
  const foobar = folder('/r/foobar', [file('/r/foobar/a', 20)]);
  assert.equal(summarize([foo, foobar]).totalBytes, 30);
});

test('summarize: rutas de Windows (mayúsculas y barras mezcladas) se detectan como anidadas', () => {
  const f = file('c:/DATA/Fotos/a.jpg', 100);
  const d = folder('C:\\data\\fotos', [f]);
  const r = summarize([f, d]);
  assert.equal(r.totalBytes, 100);
  assert.equal(r.counted.length, 1);
  assert.equal(r.counted[0], d);
  // Disco distinto o carpeta hermana: no son anidadas.
  const otro = file('D:\\data\\fotos\\a.jpg', 5);
  assert.equal(summarize([d, otro]).totalBytes, 105);
});

test('summarize: nodos protegidos (o con algo protegido) quedan fuera del total', () => {
  const prot = file('/r/p/sys.dll', 1000);
  const carpetaProt = folder('/r/p', [prot]);
  const mezcla = folder('/r/m', [file('/r/m/ok', 5), file('/r/m/p/x', 50)]);
  const libre = file('/r/libre', 30);
  const isProtected = (p) => p === '/r/p' || p.startsWith('/r/p/') || p === '/r/m/p/x';

  const r = summarize([carpetaProt, mezcla, libre], { isProtected });
  assert.equal(r.totalBytes, 30);
  assert.deepEqual(
    r.excluded.map((e) => [e.node.path, e.reason]).sort(),
    [['/r/m', 'contiene-protegidos'], ['/r/p', 'protegido']],
  );
});

test('summarize: selección vacía o nula', () => {
  assert.equal(summarize([]).totalBytes, 0);
  assert.equal(summarize(null).totalBytes, 0);
});

// --- Integración con las protecciones reales (rutas de Windows) -------------

test('findStale con protecciones reales: Windows y la carpeta de usuario no se ofrecen; lo demás sí', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const tree = folder('C:\\', [
    folder('C:\\Windows', [folder('C:\\Windows\\System32', [file('C:\\Windows\\System32\\k.dll', 1000, old)])]),
    folder('C:\\Users', [
      folder('C:\\Users\\amir', [
        folder('C:\\Users\\amir\\Documents', [file('C:\\Users\\amir\\Documents\\tesis.doc', 500, old)]),
        file('C:\\Users\\amir\\NTUSER.DAT', 40, old),
      ]),
    ]),
    folder('C:\\Temp', [file('C:\\Temp\\basura.tmp', 300, old)]),
    folder('C:\\WindowsOld', [file('C:\\WindowsOld\\viejo.bak', 200, old)]),
    file('C:\\pagefile.sys', 9999, old),
  ]);

  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.deepEqual(
    items.map((i) => i.path),
    // Orden: por tamaño, de mayor a menor.
    ['C:\\Users\\amir\\Documents', 'C:\\Temp', 'C:\\WindowsOld'],
  );
  // Nada de lo ofrecido está protegido ni contiene algo protegido.
  const { isProtectedPath } = require('../src/core/protected');
  for (const i of items) {
    for (const n of allNodes(i.node)) assert.equal(isProtectedPath(n.path), false, n.path);
  }
  const reasons = Object.fromEntries(notOffered.map((p) => [p.path, p.reason]));
  assert.equal(reasons['C:\\'], 'protegido');
  assert.equal(reasons['C:\\Windows'], 'protegido');
  assert.equal(reasons['C:\\pagefile.sys'], 'protegido');
  assert.equal(reasons['C:\\Users'], 'protegido');
  assert.equal(reasons['C:\\Users\\amir'], 'protegido');
  assert.equal(reasons['C:\\Users\\amir\\NTUSER.DAT'], 'protegido');
  assert.ok(!('C:\\Windows\\System32' in reasons), 'lo totalmente protegido no se desglosa');
});

test('findStale con protecciones reales: una carpeta que contiene algo protegido no sale entera', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const tree = folder('D:\\', [
    folder('D:\\Mezcla', [
      file('D:\\Mezcla\\libre.bin', 70, old),
      folder('D:\\Mezcla\\Windows', [file('D:\\Mezcla\\Windows\\x.dll', 60, old)]), // anidada: NO protegida
    ]),
    folder('D:\\Disco', [file('D:\\Disco\\a', 10, old), folder('D:\\Disco\\Program Files', [file('D:\\Disco\\Program Files\\b', 50, old)])]),
  ]);
  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW });
  // D:\Mezcla\Windows no está en la raíz de la unidad, así que no es protegida: sale la carpeta Mezcla entera.
  assert.ok(items.some((i) => i.path === 'D:\\Mezcla'));
  // D:\Disco contiene D:\Disco\Program Files (anidada, tampoco protegida): sale entera también.
  assert.ok(items.some((i) => i.path === 'D:\\Disco'));
  // La raíz D:\ está protegida, así que no sale como una sola entrada.
  assert.ok(!items.some((i) => i.path === 'D:\\'));
  assert.equal(notOffered[0].path, 'D:\\');
});

test('findStale con protecciones reales: la raíz de un disco con carpeta de sistema real se desglosa', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const tree = folder('D:\\', [
    folder('D:\\Windows', [file('D:\\Windows\\a.dll', 10, old)]),
    folder('D:\\Fotos', [file('D:\\Fotos\\a.jpg', 20, old)]),
  ]);
  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.deepEqual(items.map((i) => i.path), ['D:\\Fotos']);
  assert.deepEqual(notOffered.map((p) => [p.path, p.reason]).sort(), [
    ['D:\\', 'protegido'],
    ['D:\\Windows', 'protegido'],
  ]);
});

test('summarize con protecciones reales: excluye lo protegido y no cuenta doble', () => {
  const win = folder('C:\\Windows', [file('C:\\Windows\\a.dll', 1000)]);
  const docs = folder('C:\\Users\\amir\\Documents', [file('C:\\Users\\amir\\Documents\\t.doc', 500)]);
  const amir = folder('C:\\Users\\amir', [docs]);
  const users = folder('C:\\Users', [amir]);
  const temp = folder('C:\\Temp', [file('C:\\Temp\\b.tmp', 300)]);
  const pagefile = file('C:\\pagefile.sys', 9999);
  const dentroTemp = file('C:\\Temp\\b.tmp', 300);

  const r = summarize([win, amir, users, docs, temp, dentroTemp, pagefile]);
  assert.equal(r.totalBytes, 500 + 300);
  assert.deepEqual(r.counted.map((n) => n.path).sort(), ['C:\\Temp', 'C:\\Users\\amir\\Documents']);
  const reasons = Object.fromEntries(r.excluded.map((e) => [e.node.path, e.reason]));
  assert.equal(reasons['C:\\Windows'], 'protegido');
  assert.equal(reasons['C:\\Users\\amir'], 'protegido');
  assert.equal(reasons['C:\\Users'], 'protegido');
  assert.equal(reasons['C:\\pagefile.sys'], 'protegido');
  assert.equal(r.excluded.find((e) => e.node === dentroTemp).reason, 'dentro-de-otro-seleccionado');
});

test('summarize con protecciones reales: carpeta que contiene algo protegido se excluye', () => {
  const sys = folder('D:\\Mezcla\\$Recycle.Bin', [file('D:\\Mezcla\\$Recycle.Bin\\x', 5)]);
  // $Recycle.Bin solo es protegida en la raíz de la unidad; aquí está anidada y es libre.
  assert.equal(summarize([sys]).totalBytes, 5);
  const enRaiz = folder('D:\\', [folder('D:\\$Recycle.Bin', [file('D:\\$Recycle.Bin\\x', 5)]), file('D:\\a', 7)]);
  const r = summarize([enRaiz]);
  assert.equal(r.totalBytes, 0);
  assert.equal(r.excluded[0].reason, 'protegido'); // D:\ es la raíz de la unidad
});

// --- Contenido no leído (1a) y carpetas sin datos (1b) ----------------------

test('findStale: carpeta vieja con una subcarpeta ilegible NO se ofrece entera', () => {
  const GB = 1e9;
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const locked = { ...folder('D:\\datos\\viejo\\locked', [], { mtime: daysAgo(900) }), incomplete: true };
  const tree = folder('D:\\datos', [folder('D:\\datos\\viejo', [file('D:\\datos\\viejo\\a.bin', 1 * GB, old), locked]), file('D:\\datos\\nuevo.txt', 5, { atime: daysAgo(1), mtime: daysAgo(1) })]);

  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.ok(!items.some((i) => i.path === 'D:\\datos\\viejo'), 'la carpeta con contenido no leído no sale entera');
  assert.deepEqual(items.map((i) => i.path), ['D:\\datos\\viejo\\a.bin'], 'sus hijos legibles sí se revisan por separado');
  const reasons = Object.fromEntries(notOffered.map((n) => [n.path, n.reason]));
  assert.equal(reasons['D:\\datos\\viejo'], 'contiene-no-leidos');
});

test('findStale: una carpeta con partial (un hijo no se pudo leer) tampoco sale entera', () => {
  const old = { atime: daysAgo(900), mtime: daysAgo(900) };
  const parcial = { ...folder('D:\\p', [file('D:\\p\\a', 10, old)]), partial: true };
  const tree = folder('D:\\', [parcial, file('D:\\nuevo', 1, { atime: daysAgo(1), mtime: daysAgo(1) })]);
  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.deepEqual(items.map((i) => i.path), ['D:\\p\\a']);
  assert.ok(notOffered.some((n) => n.path === 'D:\\p' && n.reason === 'contiene-no-leidos'));
});

test('summarize: carpeta con contenido no leído se excluye con motivo contiene-no-leidos', () => {
  const locked = { ...folder('D:\\v\\locked', []), incomplete: true };
  const viejo = folder('D:\\v', [file('D:\\v\\a', 100), locked]);
  const r = summarize([viejo, file('D:\\z', 7)]);
  assert.equal(r.totalBytes, 7);
  assert.deepEqual(r.excluded.map((e) => [e.node.path, e.reason]), [['D:\\v', 'contiene-no-leidos']]);
});

test('escáner + análisis: una subcarpeta sin permisos hace "partial" al padre y frena la oferta', async (t) => {
  const root = tmpDir(t);
  put(root, 'viejo/a.bin', 100, { atimeDaysAgo: 900 });
  put(root, 'viejo/locked/b.bin', 100, { atimeDaysAgo: 900 });
  put(root, 'nuevo.txt', 5, { atimeDaysAgo: 1 });
  const fsp = require('node:fs/promises');
  const blocked = path.join(root, 'viejo', 'locked');
  // Sin contenido legible, la fecha de la carpeta ilegible es la suya propia: se la dejamos vieja.
  fs.utimesSync(blocked, new Date(daysAgo(800)), new Date(daysAgo(800)));
  const original = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (p, ...rest) => {
    if (p === blocked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return original.call(fsp, p, ...rest);
  });
  const { tree } = await scan(root);
  const viejo = tree.children.find((c) => c.name === 'viejo');
  const locked = viejo.children.find((c) => c.name === 'locked');
  assert.equal(locked.incomplete, true);
  const { items } = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL });
  assert.ok(!items.some((i) => i.path === viejo.path));
});

test('findStale/summarize: carpeta sin lista children no lanza error y se excluye (sin-datos)', () => {
  const sinHijos = { name: 'x', path: 'D:\\x', type: 'folder', size: 500, atimeMs: 0, mtimeMs: 0, fileCount: 3 };
  const padre = folder('D:\\', [sinHijos, file('D:\\viejo', 9, { atime: daysAgo(900), mtime: daysAgo(900) }), file('D:\\nuevo', 1, { atime: daysAgo(1), mtime: daysAgo(1) })]);

  let r;
  assert.doesNotThrow(() => (r = findStale(padre, { olderThanDays: 365, now: NOW })));
  assert.deepEqual(r.items.map((i) => i.path), ['D:\\viejo']);
  assert.ok(r.notOffered.some((n) => n.path === 'D:\\x' && n.reason === 'sin-datos'));

  let s2;
  assert.doesNotThrow(() => (s2 = summarize([sinHijos, padre.children[1]])));
  assert.equal(s2.totalBytes, 9);
  assert.deepEqual(s2.excluded.map((e) => [e.node.path, e.reason]), [['D:\\x', 'sin-datos']]);
  assert.doesNotThrow(() => lastUsedDate(sinHijos));
  assert.doesNotThrow(() => topLargestFolders(padre, 3));
  assert.doesNotThrow(() => topLargestFiles(padre, 3));
  assert.doesNotThrow(() => atimeReliability(padre));
});

test('escáner: un archivo que falla por EPERM deja al padre inmediato como partial; uno que desaparece no', async (t) => {
  const root = tmpDir(t);
  put(root, 'viejo/a.bin', 100, { atimeDaysAgo: 900 });
  put(root, 'viejo/bloqueado.bin', 100, { atimeDaysAgo: 900 });
  put(root, 'otro/b.bin', 100, { atimeDaysAgo: 900 });
  put(root, 'otro/fantasma.bin', 100, { atimeDaysAgo: 900 });
  const fsp = require('node:fs/promises');
  const original = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (p, ...rest) => {
    if (p === path.join(root, 'viejo', 'bloqueado.bin')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    if (p === path.join(root, 'otro', 'fantasma.bin')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return original.call(fsp, p, ...rest);
  });
  const { tree } = await scan(root);
  const get = (n) => tree.children.find((c) => c.name === n);
  assert.equal(get('viejo').partial, true);
  assert.equal(get('otro').partial, undefined, 'desaparecer durante el escaneo no cuenta como no leído');
  assert.equal(tree.partial, undefined, 'solo el padre inmediato');
  const { items, notOffered } = findStale(tree, { olderThanDays: 365, now: NOW, ...REAL });
  assert.ok(!items.some((i) => i.path === get('viejo').path));
  assert.ok(notOffered.some((n) => n.path === get('viejo').path && n.reason === 'contiene-no-leidos'));
});

// --- findStaleFolders (el detector principal) --------------------------------

const MB = 1024 * 1024;
const OLD = { atime: daysAgo(900), mtime: daysAgo(900) };
const FRESH = { atime: daysAgo(1), mtime: daysAgo(1) };
// Opciones de prueba: 3 meses, mínimo 100 MB, nada protegido salvo que se diga.
const SF = { olderThanDays: 90, minSizeBytes: 100 * MB, now: NOW, isProtected: NO_PROT };
const paths = (r) => r.items.map((i) => i.path);
const reasons = (r) => Object.fromEntries(r.notOffered.map((n) => [n.path, n.reason]));

test('findStaleFolders: vieja grande sí; con un archivo de hace 5 días no; bajo el mínimo no', () => {
  const tree = folder('/r', [
    folder('/r/vieja', [file('/r/vieja/a.iso', 600 * MB, OLD)]),
    folder('/r/conReciente', [file('/r/conReciente/a.iso', 600 * MB, OLD), file('/r/conReciente/nota.txt', 10, { atime: daysAgo(5), mtime: daysAgo(5) })]),
    folder('/r/chica', [file('/r/chica/a.bin', 50 * MB, OLD)]),
    file('/r/suelto.iso', 900 * MB, OLD), // un archivo suelto NO es una carpeta
    file('/r/nuevo.txt', 1, FRESH),
  ]);
  const r = findStaleFolders(tree, SF);
  assert.deepEqual(paths(r), ['/r/vieja']);
  assert.equal(r.items[0].daysUnused, 900);
  assert.equal(r.items[0].name, 'vieja');
  assert.equal(r.items[0].fileCount, 1);
  assert.deepEqual(r.items[0].newestFile, { path: '/r/vieja/a.iso', name: 'a.iso', ms: daysAgo(900) });
  assert.equal(r.totalBytes, 600 * MB);
  assert.deepEqual(r.notOffered, []);
});

test('findStaleFolders: newestFile es el archivo que fija la fecha (el más reciente de la carpeta)', () => {
  const tree = folder('/r', [
    folder('/r/p', [
      file('/r/p/a', 300 * MB, { atime: daysAgo(900), mtime: daysAgo(400) }),
      folder('/r/p/sub', [file('/r/p/sub/b', 300 * MB, { atime: daysAgo(900), mtime: daysAgo(200) })]),
    ]),
    file('/r/nuevo', 1, FRESH),
  ]);
  const [item] = findStaleFolders(tree, SF).items;
  assert.equal(item.newestFile.path, '/r/p/sub/b');
  assert.equal(item.lastUsedMs, daysAgo(200));
  assert.equal(item.daysUnused, 200);
});

test('findStaleFolders: antivirus (atime de hoy, mtime viejo) se ofrece; con useAccessTime ya no', () => {
  const tree = folder('/r', [
    folder('/r/av', [file('/r/av/a.bin', 300 * MB, { atime: daysAgo(0), mtime: daysAgo(700) })]),
    file('/r/nuevo', 1, FRESH),
  ]);
  assert.deepEqual(paths(findStaleFolders(tree, SF)), ['/r/av']);
  assert.deepEqual(paths(findStaleFolders(tree, { ...SF, useAccessTime: true })), []);
});

test('findStaleFolders: la carpeta restaurada de un respaldo (creación reciente) no se ofrece por defecto', () => {
  const tree = folder('/r', [
    folder('/r/restaurada', [file('/r/restaurada/a', 300 * MB, { ...OLD, birth: daysAgo(2) })]),
    file('/r/nuevo', 1, FRESH),
  ]);
  assert.deepEqual(paths(findStaleFolders(tree, SF)), []);
  assert.deepEqual(paths(findStaleFolders(tree, { ...SF, useCreationTime: false })), ['/r/restaurada']);
});

test('findStaleFolders: padre vieja con hijos viejos es UNA entrada; los hijos no se repiten', () => {
  const tree = folder('/r', [
    folder('/r/Proyectos', [
      folder('/r/Proyectos/2019', [
        folder('/r/Proyectos/2019/a', [file('/r/Proyectos/2019/a/x', 300 * MB, OLD)]),
        folder('/r/Proyectos/2019/b', [file('/r/Proyectos/2019/b/y', 300 * MB, OLD)]),
      ]),
      folder('/r/Proyectos/actual', [file('/r/Proyectos/actual/z', 10, FRESH)]),
    ]),
  ]);
  const r = findStaleFolders(tree, SF);
  assert.deepEqual(paths(r), ['/r/Proyectos/2019'], 'la carpeta más alta que cumple');
  assert.equal(r.items[0].size, 600 * MB);
});

test('findStaleFolders: sin solapamientos nunca (propiedad sobre un árbol grande)', () => {
  const mk = (base, depth) =>
    folder(base, [
      file(`${base}/f`, 200 * MB, depth % 2 ? OLD : FRESH),
      ...(depth > 0 ? [mk(`${base}/a`, depth - 1), mk(`${base}/b`, depth - 1)] : []),
    ]);
  const r = findStaleFolders(folder('/r', [mk('/r/x', 4), mk('/r/y', 3)]), { ...SF, minSizeBytes: 0 });
  for (const a of r.items) for (const b of r.items) if (a !== b) assert.ok(!b.path.startsWith(a.path + '/'), `${b.path} dentro de ${a.path}`);
});

test('findStaleFolders: la raíz nunca se ofrece; si toda está sin uso se ofrecen sus hijos', () => {
  const tree = folder('/r', [
    folder('/r/a', [file('/r/a/x', 300 * MB, OLD)]),
    folder('/r/b', [file('/r/b/y', 200 * MB, OLD)]),
    file('/r/suelto', 1, OLD),
  ]);
  const r = findStaleFolders(tree, SF);
  assert.deepEqual(paths(r), ['/r/a', '/r/b'], 'ordenadas por tamaño');
  assert.ok(!paths(r).includes('/r'));
});

test('findStaleFolders: excluida por el usuario (y lo que contiene); comparación sin mayúsculas en Windows', () => {
  const tree = folder('C:\\Datos', [
    folder('C:\\Datos\\Vieja', [file('C:\\Datos\\Vieja\\a', 300 * MB, OLD), folder('C:\\Datos\\Vieja\\sub', [file('C:\\Datos\\Vieja\\sub\\b', 300 * MB, OLD)])]),
    folder('C:\\Datos\\Otra', [file('C:\\Datos\\Otra\\c', 300 * MB, OLD)]),
  ]);
  const r = findStaleFolders(tree, { ...SF, excludedPaths: ['c:/datos/VIEJA'] });
  assert.deepEqual(paths(r), ['C:\\Datos\\Otra']);
  assert.equal(reasons(r)['C:\\Datos\\Vieja'], 'excluida-por-usuario');
  assert.ok(!('C:\\Datos\\Vieja\\sub' in reasons(r)), 'lo de adentro no se desglosa');
  // Ignorar una subcarpeta: el padre no se ofrece entero (arrastraría la ignorada), el resto sí.
  const r2 = findStaleFolders(tree, { ...SF, excludedPaths: ['C:\\Datos\\Vieja\\sub\\'] });
  assert.equal(reasons(r2)['C:\\Datos\\Vieja'], 'contiene-excluidas');
  assert.equal(reasons(r2)['C:\\Datos\\Vieja\\sub'], 'excluida-por-usuario');
  assert.deepEqual(paths(r2), ['C:\\Datos\\Otra']);
  // En rutas de Linux sí se distinguen mayúsculas.
  const lin = folder('/r', [folder('/r/Vieja', [file('/r/Vieja/a', 300 * MB, OLD)])]);
  assert.deepEqual(paths(findStaleFolders(lin, { ...SF, excludedPaths: ['/r/vieja'] })), ['/r/Vieja']);
});

test('findStaleFolders: protegidas y carpetas con algo protegido dentro no se ofrecen', () => {
  const tree = folder('C:\\', [
    folder('C:\\Windows', [file('C:\\Windows\\k.dll', 900 * MB, OLD)]),
    folder('C:\\Users', [
      folder('C:\\Users\\amir', [
        folder('C:\\Users\\amir\\Videos', [file('C:\\Users\\amir\\Videos\\v.mp4', 400 * MB, OLD)]),
        folder('C:\\Users\\amir\\AppData', [file('C:\\Users\\amir\\AppData\\x', 200 * MB, OLD)]),
      ]),
    ]),
    folder('C:\\Temp', [file('C:\\Temp\\t', 300 * MB, OLD)]),
  ]);
  const r = findStaleFolders(tree, { ...SF, isProtected: undefined });
  assert.deepEqual(paths(r), ['C:\\Users\\amir\\Videos', 'C:\\Temp']);
  const why = reasons(r);
  assert.equal(why['C:\\Windows'], 'protegido');
  assert.equal(why['C:\\Users'], 'protegido');
  assert.equal(why['C:\\Users\\amir'], 'protegido');
  assert.equal(why['C:\\Users\\amir\\AppData'], 'protegido');
});

test('findStaleFolders: con una subcarpeta ilegible no se ofrece entera; la parte legible sí', () => {
  const locked = { ...folder('D:\\datos\\viejo\\locked', [], { mtime: daysAgo(900) }), incomplete: true };
  const tree = folder('D:\\datos', [
    folder('D:\\datos\\viejo', [
      folder('D:\\datos\\viejo\\ok', [file('D:\\datos\\viejo\\ok\\a.bin', 1024 * MB, OLD)]),
      locked,
    ]),
    file('D:\\datos\\nuevo', 1, FRESH),
  ]);
  const r = findStaleFolders(tree, { ...SF, isProtected: NO_PROT });
  assert.deepEqual(paths(r), ['D:\\datos\\viejo\\ok']);
  assert.equal(reasons(r)['D:\\datos\\viejo'], 'contiene-no-leidos');
});

test('findStaleFolders: carpeta sin lista de hijos => sin-datos, sin lanzar error', () => {
  const sinHijos = { name: 'x', path: '/r/x', type: 'folder', size: 800 * MB, atimeMs: 0, mtimeMs: 0, fileCount: 3 };
  const tree = folder('/r', [sinHijos, file('/r/nuevo', 1, FRESH)]);
  let r;
  assert.doesNotThrow(() => (r = findStaleFolders(tree, SF)));
  assert.deepEqual(r.items, []);
  assert.equal(reasons(r)['/r/x'], 'sin-datos');
});

test('findStaleFolders: valores por defecto (90 días y 500 MB), orden por tamaño y validación', () => {
  const tree = folder('/r', [
    folder('/r/a', [file('/r/a/x', 600 * MB, { atime: daysAgo(100), mtime: daysAgo(100) })]),
    folder('/r/b', [file('/r/b/x', 700 * MB, { atime: daysAgo(100), mtime: daysAgo(100) })]),
    folder('/r/c', [file('/r/c/x', 499 * MB, { atime: daysAgo(100), mtime: daysAgo(100) })]),
    folder('/r/d', [file('/r/d/x', 800 * MB, { atime: daysAgo(89), mtime: daysAgo(89) })]),
  ]);
  const r = findStaleFolders(tree, { now: NOW, isProtected: NO_PROT });
  assert.deepEqual(paths(r), ['/r/b', '/r/a']);
  assert.deepEqual(findStaleFolders(null, SF), { items: [], notOffered: [], totalBytes: 0 });
  assert.deepEqual(findStaleFolders(file('/r/f', 5), SF).items, []);
  assert.throws(() => findStaleFolders(tree, { olderThanDays: -1 }), RangeError);
});

// Con carpetas reales: fechas con utimes, fecha de creación desactivada.
const SFR = { olderThanDays: 90, minSizeBytes: 1000, now: NOW, isProtected: NO_PROT, useCreationTime: false };

async function realCase(t, build) {
  const root = tmpDir(t);
  build(root);
  const { tree } = await scan(root);
  return { root, tree, rel: (r) => r.items.map((i) => path.relative(root, i.path)) };
}
function putAt(root, rel, bytes, { atimeDaysAgo, mtimeDaysAgo }) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(bytes, 1));
  fs.utimesSync(full, new Date(daysAgo(atimeDaysAgo)), new Date(daysAgo(mtimeDaysAgo)));
}

test('findStaleFolders con carpetas reales: los casos del encargo', async (t) => {
  const { root, tree, rel } = await realCase(t, (root) => {
    putAt(root, 'vieja/a.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
    putAt(root, 'conArchivoReciente/a.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
    putAt(root, 'conArchivoReciente/nota.txt', 10, { atimeDaysAgo: 5, mtimeDaysAgo: 5 });
    putAt(root, 'antivirus/a.bin', 5000, { atimeDaysAgo: 0, mtimeDaysAgo: 700 });
    putAt(root, 'chica/a.bin', 10, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
    putAt(root, 'padre/h1/a.bin', 3000, { atimeDaysAgo: 600, mtimeDaysAgo: 600 });
    putAt(root, 'padre/h2/b.bin', 3000, { atimeDaysAgo: 600, mtimeDaysAgo: 600 });
    putAt(root, 'canción ñandú 🐕/x.bin', 4000, { atimeDaysAgo: 500, mtimeDaysAgo: 500 });
    putAt(root, 'nuevo.txt', 5, { atimeDaysAgo: 1, mtimeDaysAgo: 1 });
  });
  const r = findStaleFolders(tree, SFR);
  assert.deepEqual(rel(r).sort(), ['antivirus', 'canción ñandú 🐕', 'padre', 'vieja'].sort());
  assert.ok(!rel(r).some((p) => p.startsWith('padre' + path.sep)), 'los hijos de padre no se repiten');
  // Con el acceso contando, la del antivirus deja de ofrecerse.
  assert.ok(!rel(findStaleFolders(tree, { ...SFR, useAccessTime: true })).includes('antivirus'));
  // Excluida por el usuario.
  const ex = findStaleFolders(tree, { ...SFR, excludedPaths: [path.join(root, 'VIEJA'.toLowerCase())] });
  assert.ok(!rel(ex).includes('vieja'));
  assert.equal(ex.notOffered.find((n) => n.path === path.join(root, 'vieja')).reason, 'excluida-por-usuario');
});

test('findStaleFolders con carpetas reales: raíz vieja => se ofrecen los hijos; protegida inyectada', async (t) => {
  const { root, tree, rel } = await realCase(t, (root) => {
    putAt(root, 'a/x.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
    putAt(root, 'sistema/y.bin', 6000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
    putAt(root, 'b/z.bin', 4000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  });
  const todo = findStaleFolders(tree, SFR);
  assert.deepEqual(rel(todo), ['sistema', 'a', 'b']);
  assert.ok(!todo.items.some((i) => i.path === root));
  const sistema = path.join(root, 'sistema');
  const r = findStaleFolders(tree, { ...SFR, isProtected: (p) => p === sistema || p.startsWith(sistema + path.sep) });
  assert.deepEqual(rel(r), ['a', 'b']);
  assert.equal(r.notOffered.find((n) => n.path === sistema).reason, 'protegido');
});

test('findStaleFolders con carpetas reales: subcarpeta sin permiso (simulada)', async (t) => {
  const root = tmpDir(t);
  putAt(root, 'viejo/ok/a.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  putAt(root, 'viejo/locked/b.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  putAt(root, 'nuevo.txt', 5, { atimeDaysAgo: 1, mtimeDaysAgo: 1 });
  const fsp = require('node:fs/promises');
  const blocked = path.join(root, 'viejo', 'locked');
  // Sin contenido legible, la fecha de la carpeta ilegible es la suya propia: se la dejamos vieja.
  fs.utimesSync(blocked, new Date(daysAgo(800)), new Date(daysAgo(800)));
  const original = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (p, ...rest) => {
    if (p === blocked) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return original.call(fsp, p, ...rest);
  });
  const { tree } = await scan(root);
  const r = findStaleFolders(tree, SFR);
  assert.deepEqual(r.items.map((i) => path.relative(root, i.path)), [path.join('viejo', 'ok')]);
  assert.equal(r.notOffered.find((n) => n.path === path.join(root, 'viejo')).reason, 'contiene-no-leidos');
});

// --- Enlaces (hasLinks) ------------------------------------------------------

test('hasLinks: un enlace directo marca solo al padre inmediato en el escáner; el análisis lo propaga a los ancestros', async (t) => {
  const root = tmpDir(t);
  putAt(root, 'viejo/a/b/dato.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  putAt(root, 'viejo/directo/dato2.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  putAt(root, 'limpia/x.bin', 5000, { atimeDaysAgo: 800, mtimeDaysAgo: 800 });
  putAt(root, 'nuevo.txt', 5, { atimeDaysAgo: 1, mtimeDaysAgo: 1 });
  try {
    fs.symlinkSync(path.join(root, 'limpia'), path.join(root, 'viejo', 'a', 'b', 'enlace'), 'dir'); // a dos niveles
    fs.symlinkSync(path.join(root, 'limpia', 'x.bin'), path.join(root, 'viejo', 'directo', 'enlace.bin'), 'file'); // directo
  } catch (err) {
    t.skip(`No se pudo crear un enlace simbólico en este sistema (${err.code})`);
    return;
  }
  const { tree, skipped } = await scan(root);
  assert.equal(skipped.filter((s) => s.kind === 'symlink').length, 2);
  const get = (...names) => names.reduce((n, name) => n.children.find((c) => c.name === name), tree);
  // El escáner solo marca al padre inmediato.
  assert.equal(get('viejo', 'a', 'b').hasLinks, true);
  assert.equal(get('viejo', 'directo').hasLinks, true);
  assert.equal(get('viejo', 'a').hasLinks, undefined);
  assert.equal(get('viejo').hasLinks, undefined);
  assert.equal(get('limpia').hasLinks, undefined);

  // findStaleFolders: sigue ofreciendo la carpeta, con aviso.
  const r = findStaleFolders(tree, { ...SFR, minSizeBytes: 1000 });
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.ok(byName.viejo, 'la carpeta con enlaces sigue ofreciéndose');
  assert.equal(byName.viejo.hasLinks, true, 'marca de los ancestros (a dos niveles y directo)');
  assert.equal(byName.limpia.hasLinks, false);
});

test('hasLinks: propagación sintética a todos los ancestros; la carpeta sigue ofreciéndose', () => {
  const profundo = { ...folder('/r/p/a/b', [file('/r/p/a/b/x', 300 * MB, OLD)]), hasLinks: true };
  const tree = folder('/r', [
    folder('/r/p', [folder('/r/p/a', [profundo])]),
    folder('/r/q', [file('/r/q/y', 300 * MB, OLD)]),
    file('/r/nuevo', 1, FRESH),
  ]);
  const r = findStaleFolders(tree, SF);
  assert.deepEqual(r.items.map((i) => [i.path, i.hasLinks]), [['/r/p', true], ['/r/q', false]]);
});
