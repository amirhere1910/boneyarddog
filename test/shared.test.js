'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { STATES, LABELS, PALETTE, activityState } = require('../src/shared/activity');
const { layout } = require('../src/shared/treemap');

// --- activity.js -----------------------------------------------------------------

test('activityState: límites de cada estado (período de 90 días)', () => {
  const P = 90;
  assert.equal(activityState(0, P), 'muy-reciente');
  assert.equal(activityState(30, P), 'muy-reciente', 'P/3 incluido');
  assert.equal(activityState(30.0001, P), 'reciente');
  assert.equal(activityState(90, P), 'reciente', 'P incluido');
  assert.equal(activityState(90.0001, P), 'sin-movimiento');
  assert.equal(activityState(180, P), 'sin-movimiento', '2P incluido');
  assert.equal(activityState(180.0001, P), 'muy-antigua');
  assert.equal(activityState(5000, P), 'muy-antigua');
});

test('activityState: desconocido y otros períodos', () => {
  for (const mal of [null, undefined, NaN, Infinity, -Infinity, '12']) assert.equal(activityState(mal, 90), 'desconocido', String(mal));
  assert.equal(activityState(10, 30), 'muy-reciente');
  assert.equal(activityState(11, 30), 'reciente');
  assert.equal(activityState(61, 30), 'muy-antigua');
  assert.equal(activityState(365, 365), 'reciente');
});

test('PALETTE: hay un color por estado, en la familia esperada', () => {
  assert.deepEqual(Object.keys(PALETTE).sort(), [...STATES].sort());
  assert.deepEqual(Object.keys(LABELS).sort(), [...STATES].sort());
  const hex = /^#[0-9A-F]{6}$/;
  for (const s of STATES) {
    assert.match(PALETTE[s].bg, hex);
    assert.match(PALETTE[s].fg, hex);
  }
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, , b1] = rgb(PALETTE['muy-reciente'].bg);
  const [r2, , b2] = rgb(PALETTE.reciente.bg);
  const [r3, , b3] = rgb(PALETTE['sin-movimiento'].bg);
  const [r4, , b4] = rgb(PALETTE['muy-antigua'].bg);
  assert.ok(r1 > b1 && r2 > b2, 'cálidos: más rojo que azul (naranja y amarillo)');
  assert.ok(b3 > r3 && b4 > r4, 'fríos: más azul que rojo (azul y plomo azulado)');
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('PALETTE: contraste WCAG >= 4.5 entre fondo y texto de cada estado', () => {
  for (const s of STATES) {
    const ratio = contrast(PALETTE[s].bg, PALETTE[s].fg);
    assert.ok(ratio >= 4.5, `${s}: contraste ${ratio.toFixed(2)}`);
  }
  // Comprobación de la propia fórmula con casos conocidos.
  assert.ok(Math.abs(contrast('#000000', '#FFFFFF') - 21) < 0.01);
  assert.ok(Math.abs(contrast('#FFFFFF', '#FFFFFF') - 1) < 0.01);
});

// --- treemap.js ------------------------------------------------------------------

const W = 800;
const H = 500;
const area = (r) => r.w * r.h;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
const aspect = (r) => Math.max(r.w / r.h, r.h / r.w);

function sizes(n, f = (i) => 1000 / (i + 1)) {
  return Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(4, '0')}`, size: f(i) }));
}

function checkInvariants(items, rects, { gap = 2, width = W, height = H, tolerance = 0.2 } = {}) {
  const valid = items.filter((it) => Number.isFinite(it.size) && it.size > 0);
  assert.equal(rects.length, valid.length);
  for (const r of rects) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9, 'dentro (origen)');
    assert.ok(r.x + r.w <= width + 1e-6 && r.y + r.h <= height + 1e-6, 'dentro (límites)');
    assert.ok(r.w >= 0 && r.h >= 0);
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]), `${rects[i].id} y ${rects[j].id} se solapan`);
  const total = valid.reduce((s, it) => s + it.size, 0);
  const bySize = new Map(valid.map((it) => [it.id, it.size]));
  for (const r of rects) {
    const ideal = (bySize.get(r.id) / total) * width * height;
    // Con márgenes, el área real es algo menor: cota inferior generosa y nunca mayor que la ideal.
    assert.ok(area(r) <= ideal + 1e-6, `${r.id} más grande que su área ideal`);
    if (ideal > 400 * gap * gap) assert.ok(area(r) >= ideal * (1 - tolerance), `${r.id} demasiado chico: ${area(r)} vs ${ideal}`);
  }
}

test('treemap: 0, 1 y 2 elementos', () => {
  assert.deepEqual(layout([], W, H), []);
  assert.deepEqual(layout(null, W, H), []);
  const one = layout([{ id: 'a', size: 10 }], W, H, { gap: 0 });
  assert.deepEqual(one, [{ id: 'a', x: 0, y: 0, w: W, h: H }]);
  const two = layout([{ id: 'a', size: 30 }, { id: 'b', size: 10 }], W, H, { gap: 0 });
  assert.equal(two.length, 2);
  assert.ok(Math.abs(area(two[0]) / area(two[1]) - 3) < 1e-6);
  assert.ok(Math.abs(area(two[0]) + area(two[1]) - W * H) < 1e-6, 'sin márgenes llena toda el área');
  checkInvariants([{ id: 'a', size: 30 }, { id: 'b', size: 10 }], layout([{ id: 'a', size: 30 }, { id: 'b', size: 10 }], W, H));
});

test('treemap: área proporcional, sin solapes y dentro del límite (20 y 1000 elementos)', () => {
  for (const n of [3, 20, 200, 1000]) {
    const items = sizes(n);
    const rects = layout(items, W, H);
    checkInvariants(items, rects, { tolerance: n >= 200 ? 0.6 : 0.2 });
  }
});

test('treemap: sin márgenes el área es exactamente proporcional y llena el espacio', () => {
  const items = sizes(50, (i) => (i % 7) + 1);
  const rects = layout(items, W, H, { gap: 0 });
  const total = items.reduce((s, it) => s + it.size, 0);
  for (const r of rects) assert.ok(Math.abs(area(r) - (items.find((it) => it.id === r.id).size / total) * W * H) < 1e-6);
  assert.ok(Math.abs(rects.reduce((s, r) => s + area(r), 0) - W * H) < 1e-4);
});

test('treemap: proporciones mucho mejores que un reparto en tiras (20 elementos)', () => {
  const items = sizes(20, (i) => 20000 / (i + 1) ** 0.9);
  const rects = layout(items, W, H, { gap: 0 });
  const squarified = Math.max(...rects.map(aspect));
  // Reparto en tiras: cada elemento es una tira vertical de ancho proporcional.
  const total = items.reduce((s, it) => s + it.size, 0);
  const strips = Math.max(...items.map((it) => aspect({ w: (it.size / total) * W, h: H })));
  assert.ok(squarified * 2 < strips, `squarified ${squarified.toFixed(1)} vs tiras ${strips.toFixed(1)}`);
  assert.ok(squarified < 6, `razón de aspecto máxima ${squarified.toFixed(1)}`);
});

test('treemap: determinista (mismo resultado sin importar el orden de entrada) y empates por id', () => {
  const items = [{ id: 'b', size: 5 }, { id: 'a', size: 5 }, { id: 'c', size: 5 }, { id: 'd', size: 9 }];
  const r1 = layout(items, W, H);
  const r2 = layout([...items].reverse(), W, H);
  assert.deepEqual(r1, r2);
  assert.deepEqual(layout(items, W, H), r1);
  assert.deepEqual(r1.map((r) => r.id), ['d', 'a', 'b', 'c']);
});

test('treemap: descarta tamaños no positivos o inválidos', () => {
  const items = [{ id: 'a', size: 10 }, { id: 'z', size: 0 }, { id: 'n', size: -4 }, { id: 'x', size: NaN }, { id: 'i', size: Infinity }, { id: 's', size: '7' }, null, { id: 'b', size: 5 }];
  const rects = layout(items, W, H);
  assert.deepEqual(rects.map((r) => r.id).sort(), ['a', 'b']);
  assert.deepEqual(layout([{ id: 'z', size: 0 }], W, H), []);
});

test('treemap: un elemento enorme y muchos minúsculos', () => {
  const items = [{ id: 'enorme', size: 1e12 }, ...Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, size: 1 + (i % 3) }))];
  const rects = layout(items, W, H);
  assert.equal(rects.length, 501);
  for (const r of rects) {
    assert.ok(Number.isFinite(r.x + r.y + r.w + r.h));
    assert.ok(r.x + r.w <= W + 1e-6 && r.y + r.h <= H + 1e-6);
    assert.ok(r.w >= 0 && r.h >= 0);
  }
  for (let i = 0; i < rects.length; i += 37) for (let j = i + 1; j < rects.length; j += 41) assert.ok(!overlap(rects[i], rects[j]));
  const big = rects.find((r) => r.id === 'enorme');
  assert.ok(area(big) > 0.99 * W * H * 0.97);
});

test('treemap: tamaños muy dispares (de 1 a 10^12)', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `d${i}`, size: 10 ** (i % 13) }));
  const rects = layout(items, W, H, { gap: 0 });
  assert.equal(rects.length, 30);
  const total = items.reduce((s, it) => s + it.size, 0);
  for (const r of rects) assert.ok(Math.abs(area(r) - (items.find((it) => it.id === r.id).size / total) * W * H) < 1e-3 * W * H / 1e3 + 1e-6);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]));
});

test('treemap: áreas o márgenes degenerados no producen valores negativos ni NaN', () => {
  assert.deepEqual(layout(sizes(5), 0, 100), []);
  assert.deepEqual(layout(sizes(5), 100, -1), []);
  assert.deepEqual(layout(sizes(5), NaN, 100), []);
  const tiny = layout(sizes(100), 40, 30, { gap: 10 });
  for (const r of tiny) assert.ok(r.w >= 0 && r.h >= 0 && Number.isFinite(r.x + r.y + r.w + r.h));
  const rects = layout(sizes(10), 300, 200, { gap: 50 });
  for (const r of rects) assert.ok(r.w >= 0 && r.h >= 0);
});
