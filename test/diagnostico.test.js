'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDiagnostic } = require('../src/core/diagnostico');
const { tmpDir } = require('../test-support/transfer-helpers');

test('el diagnóstico anota con marcas de tiempo, sin contenido de archivos, y se puede leer entero', async (t) => {
  const file = path.join(tmpDir(t, 'diag-'), 'datos', 'diagnostico.log');
  const d = createDiagnostic({ file, now: () => Date.UTC(2026, 9, 29, 12, 0, 0) });
  d.log('archivo', { ruta: 'E:\\Fotos.copiando\\a.jpg', bytes: 123, aperturaOrigenMs: 7, primeraLecturaMs: 21, codigo: 'EIO' });
  d.log('etapa', { etapa: 'guardando en el disco', ms: 4200 });
  const text = await d.readAll();
  const lines = text.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^2026-10-29T12:00:00\.000Z archivo \{.*"aperturaOrigenMs":7.*"primeraLecturaMs":21.*\}$/);
  assert.match(lines[1], /guardando en el disco/);
});

test('rotación: nunca pasa de ~1 MB (el viejo pasa a «.1») y se siguen anotando cosas', async (t) => {
  const file = path.join(tmpDir(t, 'diag-'), 'diagnostico.log');
  const d = createDiagnostic({ file, maxBytes: 2000 });
  for (let i = 0; i < 200; i++) d.log('evento', { i, relleno: 'x'.repeat(40) });
  await d.flush();
  assert.ok(fs.statSync(file).size <= 2000, String(fs.statSync(file).size));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.statSync(`${file}.1`).size <= 2000);
  const all = await d.readAll();
  assert.match(all, /"i":199/, 'lo último siempre está');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['diagnostico.log', 'diagnostico.log.1']);
});

test('si no se puede escribir, NO rompe nada y cuenta lo perdido; datos raros y enormes se acotan', async (t) => {
  const dir = tmpDir(t, 'diag-');
  fs.writeFileSync(path.join(dir, 'es-un-archivo'), 'x');
  const d = createDiagnostic({ file: path.join(dir, 'es-un-archivo', 'dentro.log') }); // la «carpeta» es un archivo
  await d.log('algo', { a: 1 });
  assert.equal(d.lostLines(), 1);
  assert.equal(await d.readAll(), '');
  assert.doesNotThrow(() => createDiagnostic({ file: null }).log('x'));
  const ok = createDiagnostic({ file: path.join(dir, 'ok.log') });
  const circular = {};
  circular.yo = circular;
  await ok.log('circular', { circular });
  await ok.log('enorme', { texto: 'y'.repeat(100000), lista: Array.from({ length: 1000 }, (_, i) => i), simbolo: Symbol('s') });
  const lines = (await ok.readAll()).trim().split('\n');
  assert.ok(lines.length >= 1);
  for (const l of lines) assert.ok(l.length <= 4001, `línea de ${l.length}`);
});
