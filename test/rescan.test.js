'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rescanView, shouldHandleKey, STALE_TEXT } = require('../src/shared/rescan');

const base = { hasResult: true, scanning: false, transferring: false, transferredCount: 0, folder: 'C:\\x' };

test('«Volver a escanear»: habilitado solo con resultado, sin escaneo ni transferencia en curso', () => {
  assert.equal(rescanView(base).disabled, false);
  assert.equal(rescanView({ ...base, scanning: true }).disabled, true);
  assert.equal(rescanView({ ...base, transferring: true }).disabled, true);
  assert.match(rescanView({ ...base, transferring: true }).reason, /copia|transferencia/);
  assert.equal(rescanView({ ...base, hasResult: false }).disabled, true);
  assert.equal(rescanView({ ...base, folder: null }).disabled, true);
  assert.equal(rescanView(null).disabled, true);
});

test('tras retirar originales el mapa se marca desactualizado, sin escanear solo', () => {
  assert.equal(rescanView(base).stale, false);
  const v = rescanView({ ...base, transferredCount: 2 });
  assert.equal(v.stale, true);
  assert.equal(v.staleText, STALE_TEXT);
  assert.match(v.staleText, /desactualizado/);
  assert.equal(v.disabled, false, 'se puede volver a escanear ahora, pero nada lo hace automáticamente');
  assert.equal(rescanView({ ...base, hasResult: false, transferredCount: 2 }).stale, false);
});

test('F5 y Ctrl+R: solo con el botón habilitado y sin escribir en un campo', () => {
  const on = rescanView(base);
  const off = rescanView({ ...base, scanning: true });
  assert.equal(shouldHandleKey({ key: 'F5' }, on, false), true);
  assert.equal(shouldHandleKey({ key: 'r', ctrlKey: true }, on, false), true);
  assert.equal(shouldHandleKey({ key: 'F5' }, off, false), false);
  assert.equal(shouldHandleKey({ key: 'F5' }, on, true), false);
  assert.equal(shouldHandleKey({ key: 'a' }, on, false), false);
});

test('código fuente: nada se vuelve a escanear solo y el renderer no manda rutas nuevas', () => {
  const fs = require('node:fs');
  const app = fs.readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const calls = [...app.matchAll(/\brescan\(\)/g)].length;
  // Solo: definición, clics (vía addEventListener sin paréntesis) y la tecla F5.
  assert.ok(calls <= 3, `rescan() se llama ${calls} veces`);
  const from = app.indexOf('function onOriginalsRemoved');
  const onRemoved = app.slice(from, app.indexOf('\n  }\n', from));
  assert.doesNotMatch(onRemoved, /(?<![A-Za-z])(rescan|scan)\(|startScan/);
});
