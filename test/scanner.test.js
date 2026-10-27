'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { scan } = require('../src/core/scanner');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-scan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

function find(node, name) {
  return node.children.find((c) => c.name === name);
}

/** Árbol de ejemplo con tamaños conocidos (total: 6 archivos, 3157 bytes). */
function buildSample(root) {
  write(path.join(root, 'a.txt'), 100);
  write(path.join(root, 'cero.bin'), 0);
  fs.mkdirSync(path.join(root, 'vacía'));
  write(path.join(root, 'sub', 'b.bin'), 1000);
  write(path.join(root, 'sub', 'deep', 'c.bin'), 2000);
  write(path.join(root, 'áéñ ü con espacios', 'canción ñandú.txt'), 50);
  write(path.join(root, 'emoji 🐕', '🦴 hueso.txt'), 7);
}

test('calcula tamaños y cantidad de archivos (carpeta = suma de su contenido)', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const { tree, skipped, cancelled, stats } = await scan(root);

  assert.equal(cancelled, false);
  assert.deepEqual(skipped, []);
  assert.equal(tree.type, 'folder');
  assert.equal(tree.size, 3157);
  assert.equal(tree.fileCount, 6);
  assert.equal(stats.files, 6);
  assert.equal(stats.bytes, 3157);

  const sub = find(tree, 'sub');
  assert.equal(sub.size, 3000);
  assert.equal(sub.fileCount, 2);
  assert.equal(find(sub, 'deep').size, 2000);
  assert.equal(find(tree, 'a.txt').size, 100);
  assert.equal(find(tree, 'a.txt').type, 'file');
});

test('carpetas vacías y archivos de 0 bytes se registran con tamaño 0', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const { tree } = await scan(root);

  const vacia = find(tree, 'vacía');
  assert.equal(vacia.type, 'folder');
  assert.equal(vacia.size, 0);
  assert.equal(vacia.fileCount, 0);
  assert.deepEqual(vacia.children, []);

  const cero = find(tree, 'cero.bin');
  assert.equal(cero.type, 'file');
  assert.equal(cero.size, 0);
  assert.equal(cero.fileCount, 1);
});

test('nombres con tildes, ñ, espacios y emojis se conservan', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const { tree } = await scan(root);

  const tildes = find(tree, 'áéñ ü con espacios');
  assert.ok(tildes, 'carpeta con tildes y espacios');
  assert.equal(find(tildes, 'canción ñandú.txt').size, 50);

  const emoji = find(tree, 'emoji 🐕');
  assert.ok(emoji, 'carpeta con emoji');
  const hueso = find(emoji, '🦴 hueso.txt');
  assert.equal(hueso.size, 7);
  assert.equal(hueso.path, path.join(root, 'emoji 🐕', '🦴 hueso.txt'));
});

test('guarda atime y mtime reales del archivo', async (t) => {
  const root = tmpDir(t);
  const file = path.join(root, 'viejo.txt');
  write(file, 10);
  const atime = new Date('2020-01-02T03:04:05Z');
  const mtime = new Date('2021-06-07T08:09:10Z');
  fs.utimesSync(file, atime, mtime);

  const { tree } = await scan(root);
  const node = find(tree, 'viejo.txt');
  assert.equal(node.atimeMs, atime.getTime());
  assert.equal(node.mtimeMs, mtime.getTime());
});

test('enlace simbólico: se omite, se registra y no se cuenta dos veces', async (t) => {
  const root = tmpDir(t);
  write(path.join(root, 'real', 'x.bin'), 500);
  try {
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'enlace'), 'dir');
  } catch (err) {
    t.skip(`No se pudo crear un enlace simbólico en este sistema (${err.code})`);
    return;
  }
  const { tree, skipped } = await scan(root);

  assert.equal(tree.size, 500, 'el contenido del enlace no se suma');
  assert.equal(tree.fileCount, 1);
  assert.equal(find(tree, 'enlace'), undefined, 'el enlace no está en el árbol');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'symlink');
  assert.equal(skipped[0].path, path.join(root, 'enlace'));
});

test('enlace simbólico a un ancestro (bucle) no cuelga el escaneo', async (t) => {
  const root = tmpDir(t);
  write(path.join(root, 'a', 'x.bin'), 5);
  try {
    fs.symlinkSync(root, path.join(root, 'a', 'bucle'), 'dir');
  } catch (err) {
    t.skip(`No se pudo crear un enlace simbólico en este sistema (${err.code})`);
    return;
  }
  const { tree, skipped } = await scan(root);
  assert.equal(tree.size, 5);
  assert.equal(skipped[0].kind, 'symlink');
});

test('junction de Windows: se omite (solo se ejecuta en Windows)', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Las junctions solo existen en Windows');
    return;
  }
  const root = tmpDir(t);
  write(path.join(root, 'real', 'x.bin'), 300);
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'union'), 'junction');
  const { tree, skipped } = await scan(root);
  assert.equal(tree.size, 300);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'symlink');
});

test('ruta inexistente: no lanza error, devuelve árbol nulo y la registra', async (t) => {
  const root = tmpDir(t);
  const missing = path.join(root, 'no-existe');
  const { tree, skipped, cancelled } = await scan(missing);
  assert.equal(tree, null);
  assert.equal(cancelled, false);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'not-found');
  assert.equal(skipped[0].path, missing);
});

test('si la raíz es un archivo, devuelve ese archivo', async (t) => {
  const root = tmpDir(t);
  const file = path.join(root, 'solo.txt');
  write(file, 42);
  const { tree } = await scan(file);
  assert.equal(tree.type, 'file');
  assert.equal(tree.size, 42);
});

test('carpeta sin permisos (simulada con EACCES): se omite sin romper el resto', async (t) => {
  const root = tmpDir(t);
  write(path.join(root, 'ok', 'a.bin'), 100);
  write(path.join(root, 'secreta', 'b.bin'), 999);
  const blocked = path.join(root, 'secreta');
  const original = fsp.readdir;
  t.mock.method(fsp, 'readdir', async (p, ...rest) => {
    if (p === blocked) {
      const err = new Error(`EACCES: permission denied, scandir '${p}'`);
      err.code = 'EACCES';
      throw err;
    }
    return original.call(fsp, p, ...rest);
  });

  const { tree, skipped, cancelled } = await scan(root);
  assert.equal(cancelled, false);
  assert.equal(tree.size, 100, 'solo cuenta lo legible');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'permission');
  assert.equal(skipped[0].code, 'EACCES');
  assert.equal(skipped[0].path, blocked);
  const secreta = find(tree, 'secreta');
  assert.equal(secreta.incomplete, true);
  assert.equal(secreta.size, 0);
});

test('EPERM al leer metadatos de un archivo: se omite y sigue', async (t) => {
  const root = tmpDir(t);
  write(path.join(root, 'bien.bin'), 10);
  write(path.join(root, 'mal.bin'), 20);
  const bad = path.join(root, 'mal.bin');
  const original = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (p, ...rest) => {
    if (p === bad) {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    }
    return original.call(fsp, p, ...rest);
  });
  const { tree, skipped } = await scan(root);
  assert.equal(tree.size, 10);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].kind, 'permission');
  assert.equal(skipped[0].code, 'EPERM');
});

test('carpeta sin permisos real (chmod 000)', async (t) => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform === 'win32' || isRoot) {
    t.skip('chmod no restringe a root ni funciona igual en Windows; ver la prueba simulada');
    return;
  }
  const root = tmpDir(t);
  write(path.join(root, 'ok', 'a.bin'), 100);
  write(path.join(root, 'cerrada', 'b.bin'), 999);
  const closed = path.join(root, 'cerrada');
  fs.chmodSync(closed, 0o000);
  try {
    const { tree, skipped } = await scan(root);
    assert.equal(tree.size, 100);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].kind, 'permission');
    assert.equal(skipped[0].path, closed);
  } finally {
    // Restaurar antes de que tmpDir intente borrar la carpeta.
    fs.chmodSync(closed, 0o755);
  }
});

test('cancelación a mitad: termina, marca cancelled y deja un árbol parcial', async (t) => {
  const root = tmpDir(t);
  for (let d = 0; d < 10; d++) {
    for (let f = 0; f < 20; f++) write(path.join(root, `d${d}`, `f${f}.bin`), 10);
  }
  const controller = new AbortController();
  let seen = 0;
  const result = await scan(root, {
    concurrency: 2,
    progressIntervalMs: 0,
    signal: controller.signal,
    onProgress: ({ filesSeen }) => {
      seen = filesSeen;
      if (filesSeen >= 5) controller.abort();
    },
  });

  assert.equal(result.cancelled, true);
  assert.ok(seen >= 5);
  assert.ok(result.stats.files < 200, `debió quedar incompleto, se leyeron ${result.stats.files}`);
});

test('cancelación antes de empezar: no lee nada', async (t) => {
  const root = tmpDir(t);
  write(path.join(root, 'a.bin'), 10);
  const controller = new AbortController();
  controller.abort();
  const result = await scan(root, { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.tree, null);
  assert.equal(result.stats.files, 0);
});

test('progreso: sin límite de frecuencia avisa por cada archivo y al final', async (t) => {
  const root = tmpDir(t);
  buildSample(root);
  const calls = [];
  await scan(root, { progressIntervalMs: 0, onProgress: (p) => calls.push({ ...p }) });

  assert.equal(calls.length, 6 + 1, 'un aviso por archivo más el final');
  const last = calls[calls.length - 1];
  assert.equal(last.filesSeen, 6);
  assert.equal(last.bytes, 3157);
  assert.equal(typeof last.currentPath, 'string');
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].filesSeen >= calls[i - 1].filesSeen, 'el progreso nunca retrocede');
  }
});

test('progreso: con intervalo largo se limitan los avisos (primero y final)', async (t) => {
  const root = tmpDir(t);
  for (let i = 0; i < 100; i++) write(path.join(root, `f${i}.bin`), 1);
  const calls = [];
  await scan(root, { progressIntervalMs: 3_600_000, onProgress: (p) => calls.push({ ...p }) });

  assert.ok(calls.length <= 2, `se esperaban a lo sumo 2 avisos y hubo ${calls.length}`);
  assert.equal(calls[calls.length - 1].filesSeen, 100);
});

test('concurrencia: nunca hay más lecturas simultáneas que el límite', async (t) => {
  const root = tmpDir(t);
  for (let d = 0; d < 5; d++) {
    for (let f = 0; f < 20; f++) write(path.join(root, `d${d}`, `f${f}.bin`), 1);
  }
  let inFlight = 0;
  let maxInFlight = 0;
  const wrap = (name) => {
    const original = fsp[name];
    t.mock.method(fsp, name, async (...args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        return await original.apply(fsp, args);
      } finally {
        inFlight--;
      }
    });
  };
  wrap('lstat');
  wrap('readdir');

  const { tree } = await scan(root, { concurrency: 3 });
  assert.equal(tree.fileCount, 100);
  assert.ok(maxInFlight <= 3, `máximo simultáneo: ${maxInFlight}`);
  assert.ok(maxInFlight > 1, 'sí debe trabajar en paralelo');
});

test('concurrencia por defecto es 16', async (t) => {
  const root = tmpDir(t);
  for (let f = 0; f < 80; f++) write(path.join(root, `f${f}.bin`), 1);
  let inFlight = 0;
  let maxInFlight = 0;
  const original = fsp.lstat;
  t.mock.method(fsp, 'lstat', async (...args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return await original.apply(fsp, args);
    } finally {
      inFlight--;
    }
  });
  await scan(root);
  assert.equal(maxInFlight, 16);
});

test('concurrencia inválida o ruta inválida: lanza error claro', async () => {
  await assert.rejects(() => scan('.', { concurrency: 0 }), RangeError);
  await assert.rejects(() => scan('.', { concurrency: 1.5 }), RangeError);
  await assert.rejects(() => scan(''), TypeError);
  await assert.rejects(() => scan(null), TypeError);
});
