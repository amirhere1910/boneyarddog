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
