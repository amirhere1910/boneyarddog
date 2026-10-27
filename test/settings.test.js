'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const S = require('../src/main/settings');
const { ValidationError } = require('../src/main/validate');
const { listDrives } = require('../src/main/drives');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-set-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const abs = (p) => (process.platform === 'win32' ? `C:\\${p}` : `/${p}`);

test('valores por defecto: 90 días, 500 MB, acceso apagado, creación encendida, sin exclusiones', () => {
  assert.deepEqual(S.defaults(), {
    version: 1,
    staleDays: 90,
    minSizeBytes: 524288000,
    useAccessTime: false,
    useCreationTime: true,
    excludedPaths: [],
  });
  // Los valores por defecto no se pueden mutar desde fuera.
  const d = S.defaults();
  d.excludedPaths.push('x');
  assert.deepEqual(S.defaults().excludedPaths, []);
  assert.throws(() => {
    'use strict';
    S.DEFAULTS.staleDays = 1;
  }, TypeError);
});

test('validatePatch: acepta valores válidos y límites', () => {
  assert.deepEqual(S.validatePatch({}), {});
  assert.deepEqual(S.validatePatch({ staleDays: 7 }), { staleDays: 7 });
  assert.deepEqual(S.validatePatch({ staleDays: 3650 }), { staleDays: 3650 });
  assert.deepEqual(S.validatePatch({ minSizeBytes: 0 }), { minSizeBytes: 0 });
  assert.deepEqual(S.validatePatch({ minSizeBytes: 10 * 1024 ** 4 }), { minSizeBytes: 10 * 1024 ** 4 });
  assert.deepEqual(S.validatePatch({ useAccessTime: true, useCreationTime: false }), { useAccessTime: true, useCreationTime: false });
  assert.deepEqual(S.validatePatch({ excludedPaths: [abs('a'), abs('a'), abs('b')] }), { excludedPaths: [abs('a'), abs('b')] }, 'sin repetidas');
});

test('validatePatch: rechaza lo inválido', () => {
  const malos = [
    { staleDays: 6 },
    { staleDays: 3651 },
    { staleDays: 30.5 },
    { staleDays: '30' },
    { staleDays: null },
    { minSizeBytes: -1 },
    { minSizeBytes: 10 * 1024 ** 4 + 1 },
    { minSizeBytes: 1.5 },
    { minSizeBytes: NaN },
    { useAccessTime: 'si' },
    { useCreationTime: 1 },
    { excludedPaths: 'x' },
    { excludedPaths: ['relativa'] },
    { excludedPaths: [abs('a\0b')] },
    { excludedPaths: [7] },
    { excludedPaths: Array.from({ length: 501 }, (_, i) => abs(`d${i}`)) },
    { version: 2 },
    { desconocida: 1 },
    { __proto__: { staleDays: 30 }, otra: 1 },
  ];
  for (const malo of malos) assert.throws(() => S.validatePatch(malo), ValidationError, JSON.stringify(malo));
  for (const noObjeto of [null, undefined, 5, 'x', []]) assert.throws(() => S.validatePatch(noObjeto), ValidationError);
  // Exactamente 500 es válido.
  assert.equal(S.validatePatch({ excludedPaths: Array.from({ length: 500 }, (_, i) => abs(`d${i}`)) }).excludedPaths.length, 500);
});

test('normalizeLoaded: versión desconocida, basura o campos sueltos inválidos', () => {
  assert.deepEqual(S.normalizeLoaded({ version: 99, staleDays: 30 }), S.defaults());
  assert.deepEqual(S.normalizeLoaded(null), S.defaults());
  assert.deepEqual(S.normalizeLoaded('texto'), S.defaults());
  assert.deepEqual(S.normalizeLoaded([]), S.defaults());
  assert.deepEqual(S.normalizeLoaded({ staleDays: 30 }), S.defaults(), 'sin versión');
  const parcial = S.normalizeLoaded({ version: 1, staleDays: 30, minSizeBytes: 'mucho', useAccessTime: true, extra: 1 });
  assert.equal(parcial.staleDays, 30);
  assert.equal(parcial.minSizeBytes, 524288000, 'el campo inválido vuelve a su valor por defecto');
  assert.equal(parcial.useAccessTime, true);
  assert.equal(parcial.extra, undefined);
});

test('SettingsStore: sin archivo usa los valores por defecto y no crea nada hasta guardar', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = new S.SettingsStore(file);
  assert.deepEqual(store.get(), S.defaults());
  assert.equal(fs.existsSync(file), false);
});

test('SettingsStore: guarda y vuelve a leer lo mismo', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sub', 'settings.json'); // crea la carpeta si falta
  const store = new S.SettingsStore(file);
  const next = store.update({ staleDays: 180, minSizeBytes: 1024 ** 3, useAccessTime: true, excludedPaths: [abs('x')] });
  assert.equal(next.staleDays, 180);
  const again = new S.SettingsStore(file).get();
  assert.deepEqual(again, { version: 1, staleDays: 180, minSizeBytes: 1024 ** 3, useAccessTime: true, useCreationTime: true, excludedPaths: [abs('x')] });
  // Un parche parcial conserva el resto.
  store.update({ staleDays: 365 });
  assert.deepEqual(new S.SettingsStore(file).get().excludedPaths, [abs('x')]);
  // get() devuelve copias.
  const copia = store.get();
  copia.excludedPaths.push('zzz');
  assert.deepEqual(store.get().excludedPaths, [abs('x')]);
});

test('SettingsStore: un parche inválido no cambia nada, ni en memoria ni en disco', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = new S.SettingsStore(file);
  store.update({ staleDays: 100 });
  const antes = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.update({ staleDays: 100, minSizeBytes: -5 }), ValidationError);
  assert.equal(store.get().staleDays, 100);
  assert.equal(fs.readFileSync(file, 'utf8'), antes);
});

test('SettingsStore: archivo corrupto o de versión desconocida => valores por defecto, sin romper', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  for (const contenido of ['{ esto no es json', '', '\0\0\0', '[1,2,3]', '"hola"', 'null', JSON.stringify({ version: 2, staleDays: 7 })]) {
    fs.writeFileSync(file, contenido);
    const store = new S.SettingsStore(file);
    assert.deepEqual(store.get(), S.defaults(), JSON.stringify(contenido));
    // Y se puede guardar encima.
    assert.equal(store.update({ staleDays: 30 }).staleDays, 30);
  }
});

test('SettingsStore: la escritura es atómica (sin archivos temporales y con rename)', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = new S.SettingsStore(file);
  store.update({ staleDays: 30 });
  store.update({ staleDays: 31 });
  assert.deepEqual(fs.readdirSync(dir), ['settings.json'], 'no queda ningún temporal');

  // Si el renombrado falla, el archivo anterior queda intacto y se limpia el temporal.
  const antes = fs.readFileSync(file, 'utf8');
  t.mock.method(fs, 'renameSync', () => {
    throw new Error('disco lleno (simulado)');
  });
  assert.throws(() => store.update({ staleDays: 99 }), /disco lleno/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(file, 'utf8'), antes);
  assert.deepEqual(fs.readdirSync(dir), ['settings.json']);
  assert.equal(store.get().staleDays, 31, 'la memoria tampoco cambió');
});

// --- Unidades ---------------------------------------------------------------

test('listDrives: en otros sistemas devuelve lista vacía', async () => {
  assert.deepEqual(await listDrives({ platform: 'linux', exists: async () => true }), []);
  assert.deepEqual(await listDrives({ platform: 'darwin', exists: async () => true }), []);
});

test('listDrives: en Windows prueba A–Z y devuelve las que existen', async () => {
  const probadas = [];
  const drives = await listDrives({
    platform: 'win32',
    exists: async (root) => {
      probadas.push(root);
      return ['C:\\', 'D:\\', 'Z:\\'].includes(root);
    },
  });
  assert.deepEqual(drives, [
    { letter: 'C', path: 'C:\\' },
    { letter: 'D', path: 'D:\\' },
    { letter: 'Z', path: 'Z:\\' },
  ]);
  assert.equal(probadas.length, 26);
  assert.equal(probadas[0], 'A:\\');
  assert.equal(probadas[25], 'Z:\\');
});
