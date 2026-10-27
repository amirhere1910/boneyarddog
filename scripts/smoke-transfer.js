'use strict';

/**
 * Lanza la prueba del motor de transferencia en un sistema real (npm run smoke:transfer).
 * Pone BYD_SMOKE=1 de forma portátil y, en Linux sin pantalla, usa xvfb-run (Electron lo necesita
 * aunque aquí no se abra ninguna ventana). Solo para pruebas.
 */

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');

let electronPath;
try {
  electronPath = require('electron');
} catch (err) {
  console.error('No se encontró el programa de Electron. Instálalo con: npm install');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const args = [path.join('src', 'main', 'smoke-transfer.js')];
if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) args.push('--no-sandbox');

let command = electronPath;
let commandArgs = args;
if (process.platform === 'linux' && !process.env.DISPLAY) {
  if (spawnSync('which', ['xvfb-run']).status !== 0) {
    console.error('No hay pantalla (DISPLAY) ni xvfb-run.');
    process.exit(2);
  }
  command = 'xvfb-run';
  commandArgs = ['-a', electronPath, ...args];
}

const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, BYD_SMOKE: '1' } });
const killer = setTimeout(() => {
  console.error('[transferencia] No terminó en 6 minutos: se cierra a la fuerza.');
  child.kill('SIGKILL');
}, 6 * 60 * 1000);
child.on('exit', (code) => {
  clearTimeout(killer);
  process.exit(code === null ? 1 : code);
});
