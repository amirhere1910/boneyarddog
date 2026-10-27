'use strict';

// Revisiones estáticas de la configuración de seguridad de Electron.
// No sustituyen a la prueba automática (smoke), que comprueba lo mismo con la
// ventana real; estas corren en cualquier lugar sin el binario de Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../src/main/validate');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const main = read('src', 'main', 'main.js');
const preload = read('src', 'main', 'preload.js');
const html = read('src', 'renderer', 'index.html');
const appJs = read('src', 'renderer', 'app.js');
const css = read('src', 'renderer', 'styles.css');

test('la ventana usa contextIsolation, sin nodeIntegration y con sandbox', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /contextIsolation:\s*false/);
  assert.doesNotMatch(main, /nodeIntegration:\s*true/);
  assert.doesNotMatch(main, /sandbox:\s*false/);
  assert.doesNotMatch(main, /webSecurity:\s*false/);
  assert.doesNotMatch(main, /enableRemoteModule|nodeIntegrationInWorker|nodeIntegrationInSubFrames/);
});

test('navegación, ventanas nuevas, permisos y red están bloqueados', () => {
  assert.match(main, /will-navigate/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /onBeforeRequest/);
});

test('el preload no expone ipcRenderer completo ni nada genérico', () => {
  assert.doesNotMatch(preload, /exposeInMainWorld\(\s*'ipcRenderer'/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /ipcRenderer\.send\b/);
  assert.doesNotMatch(preload, /require\((?!'electron')/);
  assert.equal((preload.match(/exposeInMainWorld/g) || []).length, 1);
});

test('los canales del preload coinciden con la lista oficial de validate.js', () => {
  const used = [...preload.matchAll(/'(byd:[a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), Object.values(V.CHANNELS).sort());
});

test('cada manejador IPC pasa por handle(): comprueba remitente y valida', () => {
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1, 'ipcMain.handle solo dentro de handle()');
  assert.match(main, /if \(!trusted\(event\)\)/);
  for (const channel of Object.keys(V.CHANNELS).filter((c) => c !== 'progress')) {
    assert.match(main, new RegExp(`handle\\(V\\.CHANNELS\\.${channel}`), channel);
  }
  assert.match(main, /validateNoArgs/);
  assert.match(main, /validateAbsolutePath/);
});

test('la ruta a escanear solo viene del diálogo o de una unidad que el principal reconoce', () => {
  // startScan no recibe la ruta: la toma del estado interno.
  assert.match(main, /handle\(V\.CHANNELS\.startScan, async \(\.\.\.args\) => \{\s*V\.validateNoArgs\(args\)/);
  assert.match(main, /service\.startScan\(context\.chosenFolder\)/);
  assert.match(preload, /startScan: \(\) =>/);
  // Ese estado se fija en UN solo lugar, desde el diálogo o desde una unidad detectada.
  assert.equal((main.match(/context\.chosenFolder\s*=/g) || []).length, 1);
  assert.match(main, /setChosenFolder\(chosen\)/);
  assert.match(main, /setChosenFolder\(drive\.path\)/);
  assert.match(main, /\(await listDrives\(\)\)\.find\(\(d\) => d\.letter === wanted\)/);
  assert.equal((main.match(/setChosenFolder\(/g) || []).length, 3, 'definición + diálogo + unidad');
});

test('"Mostrar en el Explorador" y "Ignorar" solo aceptan rutas que el servicio confirma', () => {
  assert.match(main, /handle\(V\.CHANNELS\.reveal[\s\S]*?await service\.getNode\(p\)[\s\S]*?showItemInFolder/);
  assert.match(main, /handle\(V\.CHANNELS\.excludePath[\s\S]*?await service\.getNode\(p\)/);
  assert.doesNotMatch(main, /shell\.openPath|shell\.openExternal|child_process|\bexec(Sync|File)?\(|\bspawn\(/, 'nunca abre ni ejecuta archivos');
});

test('el código de la prueba automática solo se carga con BYD_SMOKE=1 y --smoke-test', () => {
  assert.match(main, /process\.env\.BYD_SMOKE === '1' && process\.argv\.includes\('--smoke-test'\)/);
  assert.equal((main.match(/require\('\.\/smoke'\)/g) || []).length, 1);
  assert.match(main, /const smoke = SMOKE \? require\('\.\/smoke'\) : null;/);
  assert.match(main, /if \(smoke\) smoke\.run\(/);
  assert.match(main, /smokeFolder/);
});

test('la página tiene CSP estricta, sin contenido remoto ni código en línea', () => {
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp, 'falta la política CSP');
  assert.match(csp[1], /^default-src 'self'/);
  assert.match(csp[1], /connect-src 'none'/);
  assert.match(csp[1], /object-src 'none'/);
  assert.doesNotMatch(csp[1], /unsafe-inline|unsafe-eval|https?:|\*/);

  assert.doesNotMatch(html, /https?:\/\//, 'sin direcciones de red en el HTML');
  assert.doesNotMatch(css, /https?:\/\/|@import/, 'sin recursos remotos en el CSS');
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, 'sin scripts en línea');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'sin manejadores de eventos en línea');
  assert.doesNotMatch(html, /<style/i, 'sin estilos en línea');
  assert.doesNotMatch(html, /\sstyle\s*=/i);
});

test('la interfaz no usa innerHTML ni eval (los nombres de archivo no son de fiar)', () => {
  assert.doesNotMatch(appJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(appJs, /fetch\(|XMLHttpRequest|WebSocket/);
});

test('package.json: electron fijado a una versión exacta, solo como devDependency', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/, 'sin ^ ni ~');
  assert.equal(pkg.dependencies, undefined, 'sin dependencias de ejecución');
  assert.deepEqual(Object.keys(pkg.devDependencies), ['electron']);
  assert.equal(pkg.scripts.test, 'node --test');
});

test('la prueba de transferencia real solo corre con BYD_SMOKE=1 y no usa child_process ni borra por su cuenta nada fuera de lo suyo', () => {
  const src = read('src', 'main', 'smoke-transfer.js');
  assert.match(src, /if \(process\.env\.BYD_SMOKE !== '1'\) \{[\s\S]*?process\.exit\(2\)/);
  assert.doesNotMatch(src, /child_process/);
  const launcher = read('scripts', 'smoke-transfer.js');
  assert.match(launcher, /BYD_SMOKE: '1'/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['smoke:transfer'], 'node scripts/smoke-transfer.js');
  // El motor no se carga desde la app normal todavía (Fase 3B): solo lo usa esta prueba y su servicio.
  const main = read('src', 'main', 'main.js');
  assert.doesNotMatch(main, /transfer/i);
  assert.doesNotMatch(read('src', 'main', 'preload.js'), /transfer|trash/i);
});
