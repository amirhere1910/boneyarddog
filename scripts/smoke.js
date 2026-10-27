'use strict';

/**
 * Lanza la prueba automática de la app (npm run smoke).
 * Pone BYD_SMOKE=1 de forma portátil (Windows/Linux) y, en Linux sin pantalla,
 * usa xvfb-run. Solo para pruebas; la app normal se abre con `npm start`.
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

let electronPath;
try {
  electronPath = require('electron');
} catch (err) {
  console.error('No se encontró el programa de Electron. Instálalo con: npm install');
  console.error(String(err.message || err));
  process.exit(2);
}

const root = path.join(__dirname, '..');
const args = ['.', '--smoke-test'];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
  args.push('--no-sandbox'); // Chromium no arranca como root con su sandbox
}

let command = electronPath;
let commandArgs = args;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  const hasXvfb = spawnSync('which', ['xvfb-run']).status === 0;
  if (!hasXvfb) {
    console.error('No hay pantalla (DISPLAY) ni xvfb-run: no se puede abrir la ventana.');
    process.exit(2);
  }
  command = 'xvfb-run';
  commandArgs = ['-a', electronPath, ...args];
}

const child = spawn(command, commandArgs, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, BYD_SMOKE: '1' },
});
// Red de seguridad por si la app se cuelga antes de poder medir su propio tiempo.
const killer = setTimeout(() => {
  console.error('[smoke] La app no terminó en 200 s: se cierra a la fuerza.');
  child.kill('SIGKILL');
}, 200_000);
child.on('exit', (code, signal) => {
  clearTimeout(killer);
  process.exit(code === null ? 1 : code);
});
