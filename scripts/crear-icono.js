'use strict';

/**
 * Crea assets/icon.ico a partir de assets/logo.svg SIN dependencias nuevas: Electron dibuja el SVG en una
 * ventana oculta, se captura como imagen y se arma el .ico a mano (cada tamaño va como PNG dentro del .ico).
 * Uso: electron scripts/crear-icono.js   (en Linux sin pantalla: xvfb-run -a electron scripts/crear-icono.js --no-sandbox)
 * El .ico generado está en el repositorio; este script solo hace falta si cambia el logo.
 */

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SVG = path.join(__dirname, '..', 'assets', 'logo.svg');
const OUT = path.join(__dirname, '..', 'assets', 'icon.ico');

/** Un .ico con imágenes PNG: cabecera (6) + directorio (16 por imagen) + datos. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reservado
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o); // ancho (0 = 256)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1); // alto
    dir.writeUInt8(0, o + 2); // colores
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); // planos
    dir.writeUInt16LE(32, o + 6); // bits por píxel
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 512, height: 512, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: false } });
    // El SVG va dentro de la página (una página «data:» no puede cargar archivos locales).
    const svg = fs.readFileSync(SVG, 'utf8').replace('<svg ', '<svg width="512" height="512" ');
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body>`)}`);
    await new Promise((r) => setTimeout(r, 300));
    const big = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    const images = SIZES.map((size) => ({ size, png: big.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
    fs.writeFileSync(OUT, buildIco(images));
    console.log(`[icono] ${OUT}: ${images.map((i) => `${i.size}px`).join(', ')} (${fs.statSync(OUT).size} bytes)`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
});
