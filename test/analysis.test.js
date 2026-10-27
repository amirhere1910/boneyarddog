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

test('topLargestFolders: no mezcla padres con hijos y baja hasta donde se reparte el peso', () => {
  const tree = folder('/r', [
    folder('/r/Users', [
      folder('/r/Users/amir', [
        folder('/r/Users/amir/Videos', [
          folder('/r/Users/amir/Videos/Vac', [file('/r/Users/amir/Videos/Vac/v.mp4', 290)]),
          file('/r/Users/amir/Videos/x.mp4', 10),
        ]),
        folder('/r/Users/amir/Docs', [file('/r/Users/amir/Docs/d.pdf', 150)]),
        file('/r/Users/amir/suelto.bin', 45),
      ]),
      file('/r/Users/l.txt', 5),
    ]),
    folder('/r/Otro', [
      folder('/r/Otro/A', [file('/r/Otro/A/a', 50)]),
      folder('/r/Otro/B', [file('/r/Otro/B/b', 50)]),
    ]),
  ]);

  const top = topLargestFolders(tree, 10);
  assert.deepEqual(top.map((f) => f.path), ['/r/Users/amir', '/r/Otro']);
  for (const a of top) {
    for (const b of top) assert.ok(!isInside(a, b), `${b.path} no debe estar dentro de ${a.path}`);
  }
  assert.ok(!top.some((f) => f.path === '/r'), 'la raíz escaneada no cuenta');
  assert.deepEqual(topLargestFolders(tree, 1).map((f) => f.path), ['/r/Users/amir']);
});

test('topLargestFolders: una cadena donde un hijo concentra el peso se muestra por el hijo', () => {
  const tree = folder('/r', [
    folder('/r/A', [
      folder('/r/A/B', [folder('/r/A/B/C', [file('/r/A/B/C/f', 90)]), file('/r/A/B/g', 5)]),
      file('/r/A/h', 5),
    ]),
  ]);
  assert.deepEqual(topLargestFolders(tree, 3).map((f) => f.path), ['/r/A/B/C']);
});

test('topLargestFolders: la dominancia es configurable', () => {
  const tree = folder('/r', [
    folder('/r/A', [folder('/r/A/B', [file('/r/A/B/f', 80)]), file('/r/A/g', 20)]),
  ]);
  assert.deepEqual(topLargestFolders(tree, 3).map((f) => f.path), ['/r/A']);
  assert.deepEqual(topLargestFolders(tree, 3, { dominance: 0.7 }).map((f) => f.path), ['/r/A/B']);
});

test('topLargestFolders: casos vacíos', () => {
  assert.deepEqual(topLargestFolders(folder('/r', []), 5), []);
  assert.deepEqual(topLargestFolders(null, 5), []);
  assert.deepEqual(topLargestFolders(folder('/r', [file('/r/a', 1)]), 0), []);
});

// --- lastUsedDate -----------------------------------------------------------

test('lastUsedDate: archivo = el más reciente entre atime y mtime', () => {
  assert.equal(lastUsedDate(file('/r/a', 1, { atime: 100, mtime: 500 })), 500);
  assert.equal(lastUsedDate(file('/r/a', 1, { atime: 900, mtime: 500 })), 900);
});

test('lastUsedDate: ignoreAtime usa solo mtime', () => {
  assert.equal(lastUsedDate(file('/r/a', 1, { atime: 900, mtime: 500 }), { ignoreAtime: true }), 500);
});

test('lastUsedDate: carpeta = lo más reciente de todo su contenido (a cualquier profundidad)', () => {
  const tree = folder('/r', [
    file('/r/a', 1, { atime: 10, mtime: 20 }),
    folder('/r/d', [folder('/r/d/e', [file('/r/d/e/f', 1, { atime: 700, mtime: 30 })])]),
  ]);
  assert.equal(lastUsedDate(tree), 700);
});

test('lastUsedDate: el atime propio de una carpeta se ignora; vacía usa su mtime', () => {
  const conContenido = folder('/r', [file('/r/a', 1, { atime: 10, mtime: 20 })], { atime: 99999, mtime: 88888 });
  assert.equal(lastUsedDate(conContenido), 20, 'ni el atime ni el mtime de la carpeta pesan si hay contenido');
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
  const { items, totalBytes } = findStale(tree, { olderThanDays: 365, minSizeBytes: 100, now: NOW });

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
  const sinMinimo = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.ok(sinMinimo.items.some((i) => i.path === path.join(root, 'mixta', 'viejo_chico.bin')));
  const conMinimo = findStale(tree, { olderThanDays: 365, minSizeBytes: 100, now: NOW });
  assert.ok(!conMinimo.items.some((i) => i.path.endsWith('viejo_chico.bin')));
});

test('findStale: las entradas nunca se solapan (no hay padre e hijo a la vez)', async (t) => {
  const { tree } = await sampleStaleTree(t);
  const { items } = findStale(tree, { olderThanDays: 30, now: NOW });
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
  const { items } = findStale(tree, { olderThanDays: 365, now: NOW });
  assert.equal(items.length, 1);
  assert.equal(items[0].path, root);
});

test('findStale: usa la fecha más reciente entre atime y mtime, y ignoreAtime la cambia', async (t) => {
  const root = tmpDir(t);
  // Leído hace 2 días, pero modificado hace 3 años.
  put(root, 'leido.bin', 50, { atimeDaysAgo: 2, mtimeDaysAgo: 1100 });
  const { tree } = await scan(root);
  assert.equal(findStale(tree, { olderThanDays: 365, now: NOW }).items.length, 0);
  assert.equal(findStale(tree, { olderThanDays: 365, now: NOW, ignoreAtime: true }).items.length, 1);
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
  assert.deepEqual(findStale(null, { olderThanDays: 1 }), { items: [], protectedSkipped: [], totalBytes: 0 });
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
  const { items, protectedSkipped } = findStale(tree, { olderThanDays: 365, now: NOW, isProtected });

  assert.deepEqual(items.map((i) => i.path).sort(), ['/r/libre', '/r/mezcla/ok']);
  const reasons = Object.fromEntries(protectedSkipped.map((p) => [p.path, p.reason]));
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
