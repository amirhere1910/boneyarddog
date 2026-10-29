'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/main/validate');

test('validateCount: acepta enteros de 1 a 1000 y rechaza el resto', () => {
  assert.equal(V.validateCount(1), 1);
  assert.equal(V.validateCount(10), 10);
  assert.equal(V.validateCount(1000), 1000);
  for (const mal of [0, -1, 1001, 1.5, NaN, Infinity, '10', null, undefined, {}, [], true, 10n]) {
    assert.throws(() => V.validateCount(mal), V.ValidationError, String(mal));
  }
  assert.equal(V.validateCount(50, 50), 50);
  assert.throws(() => V.validateCount(51, 50), V.ValidationError);
});

test('validateAbsolutePath: acepta rutas absolutas y rechaza lo peligroso', () => {
  const buenas = process.platform === 'win32' ? ['C:\\Users\\amir\\Documents', 'D:\\'] : ['/home/amir/docs', '/'];
  for (const ok of buenas) assert.equal(V.validateAbsolutePath(ok), ok);

  const malas = [
    '',
    null,
    undefined,
    42,
    {},
    ['/tmp'],
    'relativa/ruta',
    './x',
    '../x',
    'C:relativa',
    '/tmp/a\0b',
    '\0',
    '/tmp/../etc/passwd',
    '/tmp/a/..',
    'x'.repeat(40000),
  ];
  for (const mal of malas) assert.throws(() => V.validateAbsolutePath(mal), V.ValidationError, JSON.stringify(String(mal).slice(0, 30)));
  // Rutas de Windows: la parte ".." se rechaza en cualquier sistema.
  assert.throws(() => V.validateAbsolutePath('C:\\Users\\..\\Windows'), V.ValidationError);
});

test('validateDriveLetter: una sola letra A–Z (sale en mayúscula)', () => {
  assert.equal(V.validateDriveLetter('c'), 'C');
  assert.equal(V.validateDriveLetter('Z'), 'Z');
  for (const mal of ['', 'CC', 'C:', 'C:\\', '1', '*', ' ', 'ñ', '\0', null, undefined, 3, ['C']]) {
    assert.throws(() => V.validateDriveLetter(mal), V.ValidationError, JSON.stringify(mal));
  }
});

test('validateTreemapOptions: solo minBytes y maxCells, acotados', () => {
  assert.deepEqual(V.validateTreemapOptions(undefined), {});
  assert.deepEqual(V.validateTreemapOptions({}), {});
  assert.deepEqual(V.validateTreemapOptions({ minBytes: 0, maxCells: 10 }), { minBytes: 0, maxCells: 10 });
  assert.deepEqual(V.validateTreemapOptions({ minBytes: 10 * 1024 ** 4, maxCells: 200 }), { minBytes: 10 * 1024 ** 4, maxCells: 200 });
  const malos = [null, [], 5, 'x', { minBytes: -1 }, { minBytes: 10 * 1024 ** 4 + 1 }, { minBytes: 1.5 }, { minBytes: '5' }, { maxCells: 9 }, { maxCells: 201 }, { maxCells: 20.5 }, { maxCells: null }, { otra: 1 }, { now: 5 }];
  for (const malo of malos) assert.throws(() => V.validateTreemapOptions(malo), V.ValidationError, JSON.stringify(malo));
});

test('validatePathList: hasta 500 rutas absolutas', () => {
  const abs = (i) => (process.platform === 'win32' ? `C:\\d${i}` : `/d${i}`);
  assert.deepEqual(V.validatePathList([]), []);
  assert.equal(V.validatePathList(Array.from({ length: 500 }, (_, i) => abs(i))).length, 500);
  assert.throws(() => V.validatePathList(Array.from({ length: 501 }, (_, i) => abs(i))), V.ValidationError);
  for (const malo of [null, undefined, 'x', {}, [1], [abs(1), 'relativa'], [abs(1), '/a/../b'], [abs(1), '/a\0b'], [[abs(1)]]]) {
    assert.throws(() => V.validatePathList(malo), V.ValidationError, JSON.stringify(malo));
  }
  const dup = [abs(1), abs(1)];
  assert.deepEqual(V.validatePathList(dup), dup, 'las repetidas se dejan pasar: el servicio las informa');
});

test('validateNoArgs: los canales sin datos rechazan cualquier argumento', () => {
  assert.doesNotThrow(() => V.validateNoArgs([]));
  assert.throws(() => V.validateNoArgs(['C:\\']), V.ValidationError);
  assert.throws(() => V.validateNoArgs([undefined]), V.ValidationError);
  assert.throws(() => V.validateNoArgs(undefined), V.ValidationError);
});

test('isTrustedSender: solo nuestra ventana y nuestra página, en el marco principal', () => {
  const expected = { webContentsId: 3, indexUrl: 'file:///app/src/renderer/index.html' };
  const ok = { senderId: 3, frameUrl: 'file:///app/src/renderer/index.html', isMainFrame: true };
  assert.equal(V.isTrustedSender(ok, expected), true);
  assert.equal(V.isTrustedSender({ ...ok, frameUrl: ok.frameUrl + '#x' }, expected), true);
  assert.equal(V.isTrustedSender({ ...ok, frameUrl: ok.frameUrl + '?a=1' }, expected), true);

  assert.equal(V.isTrustedSender({ ...ok, senderId: 4 }, expected), false, 'otra ventana');
  assert.equal(V.isTrustedSender({ ...ok, isMainFrame: false }, expected), false, 'un iframe');
  assert.equal(V.isTrustedSender({ ...ok, frameUrl: 'https://evil.example/' }, expected), false, 'página remota');
  assert.equal(V.isTrustedSender({ ...ok, frameUrl: 'file:///otra/pagina.html' }, expected), false, 'otro archivo local');
  assert.equal(V.isTrustedSender({ ...ok, frameUrl: undefined }, expected), false);
  assert.equal(V.isTrustedSender(null, expected), false);
  assert.equal(V.isTrustedSender(ok, null), false);
  assert.equal(V.isTrustedSender({}, expected), false);
});

test('sameFileUrl: iguala variantes de la misma página y rechaza lo demás', () => {
  const same = V.sameFileUrl;
  assert.equal(same('file:///app/index.html', 'file:///app/index.html'), true);
  assert.equal(same('file:///app/index.html#x', 'file:///app/index.html?y=1'), true);
  assert.equal(same('file:///my%20app/index.html', 'file:///my app/index.html'), true, 'codificación de espacios');
  // Windows: la letra de unidad y las mayúsculas no cuentan.
  assert.equal(same('file:///D:/a/BoneYardDog/src/renderer/index.html', 'file:///d:/a/boneyarddog/src/renderer/index.html'), true);
  // En rutas sin letra de unidad (Linux/macOS) las mayúsculas SÍ cuentan.
  assert.equal(same('file:///app/Index.html', 'file:///app/index.html'), false);
  assert.equal(same('file:///app/index.html', 'file:///app/otra.html'), false);
  assert.equal(same('https://example.com/app/index.html', 'file:///app/index.html'), false);
  assert.equal(same('file:///app/index.html', 'https://example.com/app/index.html'), false);
  assert.equal(same('https://a.com/x', 'https://a.com/x'), false, 'solo archivos locales');
  assert.equal(same(undefined, 'file:///app/index.html'), false);
  assert.equal(same('no es una url', 'no es una url'), false);
  assert.equal(same('file:///app/%E0%A4%A', 'file:///app/%E0%A4%A'), false);
});

// ============================================================= copiar y transferir (Fase 3B)

const P = process.platform === 'win32' ? { a: 'C:\\Datos\\A', b: 'C:\\Datos\\B', raiz: 'D:\\' } : { a: '/datos/a', b: '/datos/b', raiz: '/mnt/usb' };
const base = (extra = {}) => ({ mode: 'copy', verify: 'full', sources: [P.a], ...extra });

test('transferPreflight: acepta una petición correcta y completa los valores por defecto', () => {
  assert.deepEqual(V.validateTransferPreflight(base()), { mode: 'copy', verify: 'full', disposal: 'ninguna', confirmPermanentDelete: false, sources: [P.a] });
  assert.deepEqual(V.validateTransferPreflight(base({ verify: 'quick' })).verify, 'quick');
  const mover = V.validateTransferPreflight({ mode: 'move', verify: 'full', disposal: 'papelera', sources: [P.a, P.b] });
  assert.equal(mover.disposal, 'papelera');
  const borrar = V.validateTransferPreflight({ mode: 'move', disposal: 'borrar', confirmPermanentDelete: true, sources: [P.a] });
  assert.equal(borrar.confirmPermanentDelete, true);
});

test('transferPreflight: la interfaz NO puede mandar un destino ni claves desconocidas', () => {
  for (const key of ['destinationRoot', 'destination', 'destino', 'dest', 'path', 'acceptRecycleRisk', '__proto__x', 'batch']) {
    assert.throws(() => V.validateTransferPreflight(base({ [key]: P.raiz })), V.ValidationError, key);
  }
});

test('transferPreflight: rechaza tipos, valores fuera de la lista, combinaciones peligrosas y rutas malas', () => {
  for (const mal of [null, undefined, 'copy', 5, [], [base()]]) assert.throws(() => V.validateTransferPreflight(mal), V.ValidationError);
  for (const mode of [undefined, 'Copy', 'mover', '', 1, null]) assert.throws(() => V.validateTransferPreflight(base({ mode })), V.ValidationError, String(mode));
  for (const verify of ['rapida', 'FULL', 1, null]) assert.throws(() => V.validateTransferPreflight(base({ verify })), V.ValidationError, String(verify));
  for (const disposal of ['cuarentena', 'delete', 'Papelera', 1, null, '']) assert.throws(() => V.validateTransferPreflight({ mode: 'move', disposal, sources: [P.a] }), V.ValidationError, String(disposal));
  // Copiar no retira nada; transferir exige verificación completa; la confirmación solo vale para borrar.
  assert.throws(() => V.validateTransferPreflight(base({ disposal: 'papelera' })), V.ValidationError);
  assert.throws(() => V.validateTransferPreflight(base({ disposal: 'borrar', confirmPermanentDelete: true })), V.ValidationError);
  assert.throws(() => V.validateTransferPreflight({ mode: 'move', verify: 'quick', disposal: 'papelera', sources: [P.a] }), V.ValidationError, 'la verificación rápida no sirve para transferir');
  assert.throws(() => V.validateTransferPreflight({ mode: 'move', disposal: 'papelera', confirmPermanentDelete: true, sources: [P.a] }), V.ValidationError);
  for (const c of ['true', 1, 0, null, 'sí', {}]) assert.throws(() => V.validateTransferPreflight({ mode: 'move', disposal: 'borrar', confirmPermanentDelete: c, sources: [P.a] }), V.ValidationError, String(c));
  // Orígenes.
  for (const sources of [undefined, null, [], 'x', P.a, { 0: P.a }, [5], [null], [''], ['relativa/ruta'], ['./x'], [`${P.a}\0x`], [P.a, '../x'], [`${P.a}/../b`]]) {
    assert.throws(() => V.validateTransferPreflight(base({ sources })), V.ValidationError, JSON.stringify(sources));
  }
});

test('transferPreflight: hasta 500 orígenes; 501 se rechazan', () => {
  const muchos = (n) => Array.from({ length: n }, (_, i) => (process.platform === 'win32' ? `C:\\Datos\\c${i}` : `/datos/c${i}`));
  assert.equal(V.validateTransferPreflight(base({ sources: muchos(500) })).sources.length, 500);
  assert.throws(() => V.validateTransferPreflight(base({ sources: muchos(501) })), V.ValidationError);
  assert.equal(V.MAX_TRANSFER_SOURCES, 500);
});

test('identificadores de plan y de resultado: solo los 16 hexadecimales que genera el servicio', () => {
  assert.equal(V.validateOpaqueId('0123456789abcdef'), '0123456789abcdef');
  for (const mal of ['', '0123456789ABCDEF', '0123456789abcde', '0123456789abcdeff', '../../etc/passwd', '0123456789abcdeg', null, undefined, 5, {}, ['0123456789abcdef'], '0123456789abcdef\n']) {
    assert.throws(() => V.validateOpaqueId(mal), V.ValidationError, String(mal));
  }
});

test('transferDeleteFromResult: id válido, posiciones sin repetir dentro de 0–499 y confirmación EXACTAMENTE true', () => {
  const id = '0123456789abcdef';
  assert.deepEqual(V.validateDeleteFromResult(id, [0, 3, 499], true), { runId: id, indices: [0, 3, 499] });
  for (const malo of [[], [-1], [500], [1.5], ['0'], [0, 0], null, undefined, 'x', [null], [NaN], [Infinity], Array.from({ length: 501 }, (_, i) => i % 500)]) {
    assert.throws(() => V.validateDeleteFromResult(id, malo, true), V.ValidationError, JSON.stringify(malo));
  }
  for (const c of [false, undefined, null, 'true', 1, 0, {}, []]) assert.throws(() => V.validateDeleteFromResult(id, [0], c), V.ValidationError, String(c));
  assert.throws(() => V.validateDeleteFromResult('no-es-id', [0], true), V.ValidationError);
});

test('destino: solo rutas absolutas y locales (nada de red, relativas, con \\0 ni ".."); en Windows con letra de unidad', () => {
  assert.equal(V.validateDestinationPath(P.raiz), P.raiz);
  for (const mal of ['', null, undefined, 5, 'relativa', './x', '../x', `${P.raiz}\0x`, `${P.raiz}/../x`, '\\\\servidor\\recurso\\carpeta', '//servidor/recurso', '\\\\?\\UNC\\servidor\\recurso']) {
    assert.throws(() => V.validateDestinationPath(mal), V.ValidationError, String(mal));
  }
  // La regla de Windows se puede comprobar en cualquier sistema.
  assert.equal(V.validateDestinationPath('D:\\Respaldo', { platform: 'win32' }), 'D:\\Respaldo');
  assert.equal(V.validateDestinationPath('\\\\?\\D:\\Respaldo', { platform: 'win32' }), '\\\\?\\D:\\Respaldo');
  if (process.platform !== 'win32') assert.throws(() => V.validateDestinationPath('/mnt/usb', { platform: 'win32' }), V.ValidationError, 'en Windows hace falta letra de unidad');
});

test('verificar una copia anterior: solo { mode } con full o quick', () => {
  assert.deepEqual(V.validateVerifyBatchOptions(undefined), { mode: 'full' });
  assert.deepEqual(V.validateVerifyBatchOptions({}), { mode: 'full' });
  assert.deepEqual(V.validateVerifyBatchOptions({ mode: 'quick' }), { mode: 'quick' });
  for (const mal of [null, 'full', [], { mode: 'rapida' }, { mode: 1 }, { path: 'C:\\x' }, { mode: 'full', batchFolder: 'C:\\x' }]) {
    assert.throws(() => V.validateVerifyBatchOptions(mal), V.ValidationError, JSON.stringify(mal));
  }
});

test('los canales nuevos existen y tienen el prefijo y formato esperados', () => {
  for (const name of ['chooseDestination', 'chooseDestinationDrive', 'listDestinationDrives', 'transferPreflight', 'transferRun', 'transferCancel', 'transferProgress', 'transferDeleteFromResult', 'transferRemoveCopy', 'verifyBatchChooseFolder', 'verifyBatchRun']) {
    assert.match(V.CHANNELS[name], /^byd:[a-z-]+$/, name);
  }
  assert.equal(new Set(Object.values(V.CHANNELS)).size, Object.keys(V.CHANNELS).length, 'sin canales repetidos');
});

test('borrar datos de prueba: solo { confirm: true, removeCopies? } y NINGUNA ruta', () => {
  assert.deepEqual(V.validateTestDataDelete({ confirm: true }), { confirm: true, removeCopies: false });
  assert.deepEqual(V.validateTestDataDelete({ confirm: true, removeCopies: true }), { confirm: true, removeCopies: true });
  for (const mal of [undefined, null, [], 'x', {}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { removeCopies: true }, { confirm: true, removeCopies: 'sí' }, { confirm: true, path: 'C:\\Users' }, { confirm: true, root: '/' }, { confirm: true, removeCopies: 1 }]) {
    assert.throws(() => V.validateTestDataDelete(mal), V.ValidationError, JSON.stringify(mal));
  }
  for (const name of ['testDataStatus', 'testDataCreate', 'testDataCancel', 'testDataDelete', 'testDataUse', 'testDataProgress', 'appInfo']) assert.match(V.CHANNELS[name], /^byd:[a-z-]+$/, name);
});
