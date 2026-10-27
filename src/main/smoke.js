'use strict';

/**
 * Prueba automática ("smoke test"). Solo se carga si BYD_SMOKE=1 y se pasó
 * --smoke-test (ver main.js); en el uso normal este archivo no se ejecuta.
 *
 * Qué hace:
 *  1. Crea una carpeta temporal con archivos de tamaños conocidos (algunos con
 *     fechas viejas).
 *  2. Pulsa "Elegir carpeta…" en la ventana real (el diálogo del sistema se
 *     sustituye por esa carpeta) y espera a que termine el escaneo.
 *  3. Lee lo que se VE en la ventana y lo compara con lo esperado.
 *  4. Comprueba el aislamiento de la ventana (sin require, sin process, sin
 *     ipcRenderer, sin red).
 *  5. Guarda smoke-artifacts/ventana.png y smoke-artifacts/resultado.json y
 *     termina con código 0 (todo bien) o 1 (algo falló o pasaron 90 s).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sameFileUrl } = require('./validate');

// BYD_SMOKE_TIMEOUT_MS solo existe para probar la ruta de tiempo agotado.
const TIME_LIMIT_MS = Number(process.env.BYD_SMOKE_TIMEOUT_MS) || 90_000;
const DAY = 24 * 60 * 60 * 1000;

function write(file, bytes, daysAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  if (daysAgo) {
    const d = new Date(Date.now() - daysAgo * DAY);
    fs.utimesSync(file, d, d);
  }
}

/** Carpeta de ejemplo con tamaños conocidos. */
function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'byd-smoke-'));
  const files = [
    ['grande.iso', 3_000_000, 800],
    ['medio.bin', 1_000_000, 400],
    ['nota.txt', 1_234, 0],
    ['vacio.txt', 0, 0],
    [path.join('sub', 'c.dat'), 500_000, 900],
    [path.join('sub', 'profunda', 'd.dat'), 250_000, 30],
    [path.join('canción 🐕', 'ñandú.txt'), 77, 10],
  ];
  for (const [rel, bytes, days] of files) write(path.join(root, rel), bytes, days);
  const total = files.reduce((s, f) => s + f[1], 0);
  // Orden esperado en la tabla: por tamaño, de mayor a menor.
  const order = files
    .map(([rel, bytes]) => ({ name: path.basename(rel), bytes }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    root,
    expected: {
      files: files.length,
      folders: 3, // sub, sub/profunda, canción 🐕 (sin contar la carpeta elegida)
      bytes: total,
      skipped: 0,
      tableNames: order.map((o) => o.name),
      tableSizes: order.map((o) => o.bytes),
    },
  };
}

// Se ejecuta DENTRO de la ventana: lee lo que se ve.
const READ_WINDOW = `(() => {
  const num = (id) => Number(document.getElementById(id).dataset.valor);
  const rows = [...document.querySelectorAll('#tabla-top tr')].map((tr) => ({
    name: tr.children[0].textContent,
    where: tr.children[1].textContent,
    bytes: Number(tr.children[2].dataset.valor),
    shownSize: tr.children[2].textContent,
  }));
  return {
    estado: document.body.dataset.estado,
    files: num('res-archivos'),
    folders: num('res-carpetas'),
    bytes: num('res-tamano'),
    skipped: num('res-omitidos'),
    shownBytes: document.getElementById('res-tamano').textContent,
    atimeMessage: document.getElementById('res-atime').textContent,
    mensaje: document.getElementById('mensaje').textContent,
    rows,
  };
})()`;

// También DENTRO de la ventana: aislamiento y red.
const READ_ISOLATION = `(async () => {
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  let networkBlocked = false;
  try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { networkBlocked = true; }
  return {
    hasRequire: typeof window.require !== 'undefined',
    hasProcess: typeof window.process !== 'undefined',
    hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
    bydKeys: Object.keys(window.byd || {}).sort(),
    csp: csp ? csp.getAttribute('content') : null,
    networkBlocked,
  };
})()`;

function run({ app, win, context, service, indexUrl }) {
  const started = Date.now();
  const outDir = path.join(app.getAppPath(), 'smoke-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ok: false, checks: [], startedAt: new Date(started).toISOString() };
  let finished = false;

  const check = (name, ok, detail) => report.checks.push({ name, ok: Boolean(ok), detail });

  async function finish(code, error) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    report.ok = code === 0;
    if (error) report.error = String(error && error.stack ? error.stack : error);
    report.durationMs = Date.now() - started;
    report.platform = `${process.platform} ${process.arch}`;
    report.versions = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
    try {
      if (!win.isDestroyed()) {
        // Sin esperar un repintado, capturePage puede devolver un fotograma viejo.
        await win.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
        await new Promise((r) => setTimeout(r, 300));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'ventana.png'), image.toPNG());
      }
    } catch (err) {
      report.captureError = String(err);
    }
    fs.writeFileSync(path.join(outDir, 'resultado.json'), JSON.stringify(report, null, 2));
    console.log(`[smoke] ${code === 0 ? 'OK' : 'FALLÓ'} en ${report.durationMs} ms`);
    for (const c of report.checks) console.log(`[smoke] ${c.ok ? 'ok   ' : 'FALLA'} ${c.name}${c.ok ? '' : ` -> ${JSON.stringify(c.detail)}`}`);
    if (report.error) console.log(`[smoke] error: ${report.error}`);
    try {
      await service.close();
    } catch {
      /* se cierra igual */
    }
    app.exit(code);
  }

  const timer = setTimeout(() => {
    report.checks.push({ name: 'tiempo máximo', ok: false, detail: 'se agotó el tiempo' });
    finish(1, `Se superó el tiempo máximo (${TIME_LIMIT_MS / 1000} s)`);
  }, TIME_LIMIT_MS);

  (async () => {
    const fixture = buildFixture();
    report.fixture = { root: fixture.root, expected: fixture.expected };
    context.smokeFolder = fixture.root;
    try {
      await new Promise((resolve, reject) => {
        if (!win.webContents.isLoading()) return resolve();
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`No cargó la ventana: ${desc} (${code})`)));
      });
      check('la ventana cargó la página propia', sameFileUrl(win.webContents.getURL(), indexUrl), win.webContents.getURL());

      const iso = await win.webContents.executeJavaScript(READ_ISOLATION);
      report.isolation = iso;
      check('aislamiento: sin require en la ventana', !iso.hasRequire, iso.hasRequire);
      check('aislamiento: sin process en la ventana', !iso.hasProcess, iso.hasProcess);
      check('aislamiento: ipcRenderer no está expuesto', !iso.hasIpcRenderer, iso.hasIpcRenderer);
      check(
        'puente: solo las funciones previstas',
        JSON.stringify(iso.bydKeys) === JSON.stringify(['cancelScan', 'chooseFolder', 'getLargestFiles', 'getLargestFolders', 'onProgress', 'startScan']),
        iso.bydKeys,
      );
      check('política CSP estricta', iso.csp && iso.csp.startsWith("default-src 'self'") && iso.csp.includes("connect-src 'none'"), iso.csp);
      check('la CSP bloquea conexiones', iso.networkBlocked, iso.networkBlocked);

      // Bloqueo de la SESIÓN (lockDownSession en main.js), probado desde el proceso principal:
      // la petición debe fallar por el bloqueo y no por falta de internet.
      const { session } = require('electron');
      if (typeof session.defaultSession.fetch !== 'function') {
        check('la sesión bloquea la red (session.fetch)', true, 'session.fetch no existe en esta versión de Electron: no se pudo comprobar');
      } else {
        let blockedMessage = null;
        try {
          await session.defaultSession.fetch('https://example.com/');
        } catch (err) {
          blockedMessage = String(err && err.message ? err.message : err);
        }
        report.sessionFetch = blockedMessage;
        check('la sesión bloquea la red (session.fetch)', blockedMessage !== null && /ERR_BLOCKED_BY_CLIENT/.test(blockedMessage), blockedMessage);
      }

      await win.webContents.executeJavaScript("document.getElementById('btn-elegir').click()");

      // Espera a que termine el escaneo (o falle).
      let actual;
      for (;;) {
        actual = await win.webContents.executeJavaScript(READ_WINDOW);
        if (actual.estado === 'listo' || actual.estado === 'error' || actual.estado === 'cancelado') break;
        if (Date.now() - started > TIME_LIMIT_MS) throw new Error('El escaneo no terminó a tiempo');
        await new Promise((r) => setTimeout(r, 150));
      }
      report.actual = actual;
      const e = fixture.expected;
      check('el escaneo terminó bien', actual.estado === 'listo', { estado: actual.estado, mensaje: actual.mensaje });
      check('archivos', actual.files === e.files, { esperado: e.files, visto: actual.files });
      check('carpetas', actual.folders === e.folders, { esperado: e.folders, visto: actual.folders });
      check('tamaño total (bytes)', actual.bytes === e.bytes, { esperado: e.bytes, visto: actual.bytes });
      check('omitidos', actual.skipped === e.skipped, { esperado: e.skipped, visto: actual.skipped });
      check('mensaje de fiabilidad de atime visible', actual.atimeMessage.length > 10, actual.atimeMessage);
      check('tabla: nombres en orden', JSON.stringify(actual.rows.map((r) => r.name)) === JSON.stringify(e.tableNames), { esperado: e.tableNames, visto: actual.rows.map((r) => r.name) });
      check('tabla: tamaños', JSON.stringify(actual.rows.map((r) => r.bytes)) === JSON.stringify(e.tableSizes), { esperado: e.tableSizes, visto: actual.rows.map((r) => r.bytes) });
      check('tabla: ubicación de grande.iso es la carpeta elegida', actual.rows[0] && actual.rows[0].where === fixture.root, actual.rows[0] && actual.rows[0].where);

      await finish(report.checks.every((c) => c.ok) ? 0 : 1);
    } catch (err) {
      await finish(1, err);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  })();
}

module.exports = { run };
