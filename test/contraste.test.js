'use strict';

// Contraste de los pares de colores del diseño (WCAG): texto normal >= 4,5:1; componentes de interfaz >= 3:1.
// Los valores se leen de src/renderer/styles.css, así que un cambio de color que rompa el contraste falla aquí.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PALETTE } = require('../src/shared/activity');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

function tokens(block) {
  const out = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const light = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)')));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const dark = { ...light, ...tokens(css.slice(darkStart, css.indexOf('* { box-sizing', darkStart))) };

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

// [texto, fondo, mínimo, descripción]
const PAIRS = [
  ['texto', 'fondo', 4.5, 'texto sobre el fondo'],
  ['texto', 'panel', 4.5, 'texto sobre tarjetas'],
  ['suave', 'fondo', 4.5, 'texto secundario sobre el fondo'],
  ['suave', 'panel', 4.5, 'texto secundario sobre tarjetas'],
  ['acento-texto', 'acento', 4.5, 'texto del botón principal'],
  ['acento-texto', 'acento-hover', 4.5, 'botón principal al pasar el ratón'],
  ['acento-texto', 'acento-activo', 4.5, 'botón principal pulsado'],
  ['acento', 'panel', 4.5, 'texto azul de botones secundarios sobre tarjetas'],
  ['acento', 'seleccion', 4.5, 'azul sobre fondo de selección'],
  ['texto', 'seleccion', 4.5, 'texto sobre selección'],
  ['peligro', 'peligro-fondo', 4.5, 'rojo sobre fondo de peligro'],
  ['texto', 'peligro-fondo', 4.5, 'texto sobre fondo de peligro'],
  ['aviso-texto', 'aviso-fondo', 4.5, 'texto de aviso ámbar'],
  ['ok-texto', 'ok-fondo', 4.5, 'texto de éxito'],
  ['ambar', 'aviso-fondo', 3, 'borde/icono ámbar (no es texto)'],
  ['ok', 'ok-fondo', 3, 'icono verde (no es texto)'],
  ['ok', 'panel', 4.5, 'verde de éxito sobre tarjetas'],
  ['peligro', 'panel', 4.5, 'rojo de error sobre tarjetas'],
  ['foco', 'panel', 3, 'anillo de foco sobre tarjetas'],
  ['foco', 'fondo', 3, 'anillo de foco sobre el fondo'],
  ['acento', 'panel', 3, 'borde de componentes seleccionados'],
];

for (const [name, theme] of [['claro', light], ['oscuro', dark]]) {
  test(`contraste (tema ${name}): todos los pares de tokens cumplen`, () => {
    const bad = [];
    for (const [fg, bg, min, why] of PAIRS) {
      assert.ok(theme[fg] && theme[bg], `falta el token ${fg} o ${bg}`);
      const r = ratio(theme[fg], theme[bg]);
      if (r < min) bad.push(`${why}: ${fg} ${theme[fg]} sobre ${bg} ${theme[bg]} = ${r.toFixed(2)} (< ${min})`);
    }
    assert.deepEqual(bad, []);
  });
}

test('los tokens del diseño tienen los valores pedidos (tema claro)', () => {
  assert.equal(light.fondo, '#f4f6f9');
  assert.equal(light.panel, '#ffffff');
  assert.equal(light.borde, '#e2e7ee');
  assert.equal(light.texto, '#0f172a');
  assert.equal(light.suave, '#5b6b82');
  assert.equal(light.acento, '#1f5fe0');
  assert.equal(light['acento-hover'], '#184cb8');
  assert.equal(light['acento-activo'], '#143f99');
  assert.equal(light.seleccion, '#eaf1ff');
  assert.equal(light.peligro, '#c62828');
    assert.equal(light['aviso-fondo'], '#fff4e0');
  assert.equal(light.ambar, '#b26a00', 'el ámbar pedido sigue siendo el de bordes e iconos');
  assert.equal(light.ok, '#1b7f4b');
  assert.equal(light['ok-fondo'], '#e6f6ec');
});

test('el mapa: cada estado mantiene contraste >= 4,5:1 entre su fondo y su texto, y los cuadros no se parecen a botones', () => {
  for (const [estado, { bg, fg }] of Object.entries(PALETTE)) assert.ok(ratio(bg, fg) >= 4.5, `${estado}: ${ratio(bg, fg).toFixed(2)}`);
  assert.doesNotMatch(css.slice(css.indexOf('.celda {'), css.indexOf('.celda:hover')), /box-shadow|linear-gradient/, 'los cuadros del mapa no llevan relieve ni degradado');
});

test('objetivos táctiles/clic de al menos 32 px y foco visible de 2 px', () => {
  assert.match(css, /button \{[^}]*min-height: 36px/);
  assert.match(css, /\.lateral-nav button \{[^}]*min-height: 40px/);
  assert.match(css, /button:focus-visible[^{]*\{ outline: 2px solid var\(--foco\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test('la hoja de estilos no usa recursos externos ni estilos en línea en el HTML', () => {
  assert.doesNotMatch(css, /https?:\/\/|@import|url\(/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /\sstyle=/);
});
