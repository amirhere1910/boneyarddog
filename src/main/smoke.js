'use strict';

/**
 * Prueba automática ("smoke test"). Solo se carga si BYD_SMOKE=1 y se pasó
 * --smoke-test (ver main.js); en el uso normal este archivo no se ejecuta.
 *
 * Qué hace, con la ventana real:
 *  1. Crea carpetas de ejemplo con fechas conocidas (utimes) y una configuración
 *     de prueba (en una carpeta de datos temporal; no toca la del usuario).
 *  2. Pulsa "Elegir carpeta…" (el diálogo del sistema se sustituye por la carpeta
 *     de ejemplo) y comprueba que se VEN las carpetas esperadas y no las otras.
 *  3. Cambia el período, el tamaño mínimo y las opciones avanzadas, ignora y vuelve
 *     a considerar una carpeta, y comprueba que lo guardado en settings.json coincide.
 *  4. Comprueba el aislamiento de la ventana y el bloqueo de red.
 *  5. Guarda smoke-artifacts/ventana.png (pantalla de resultados) y
 *     smoke-artifacts/resultado.json, y termina con código 0 o 1 (máximo 90 s).
 */

const fs = require('node:fs');
const path = require('node:path');
const { sameFileUrl } = require('./validate');
const { isProtectedPath } = require('../core/protected');

// BYD_SMOKE_TIMEOUT_MS solo existe para probar la ruta de tiempo agotado.
const TIME_LIMIT_MS = Number(process.env.BYD_SMOKE_TIMEOUT_MS) || 90_000;
const DAY = 24 * 60 * 60 * 1000;

const BRIDGE_KEYS = [
  'cancelScan',
  'chooseDrive',
  'chooseFolder',
  'excludePath',
  'getDetails',
  'getSettings',
  'getStaleFolders',
  'getTreemap',
  'includePath',
  'listDrives',
  'onProgress',
  'revealInExplorer',
  'saveSettings',
  'startScan',
  'summarizeSelection',
];

function write(file, bytes, mtimeDaysAgo, atimeDaysAgo = mtimeDaysAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  fs.utimesSync(file, new Date(Date.now() - atimeDaysAgo * DAY), new Date(Date.now() - mtimeDaysAgo * DAY));
}

/**
 * Carpetas de ejemplo. Van DENTRO del repositorio (no en la carpeta temporal del
 * sistema): en Windows esa carpeta está dentro de AppData, que está protegida.
 */
function buildFixture(app) {
  const base = path.join(app.getAppPath(), '.smoke-data');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'datos-'));
  const dir = (name) => path.join(root, name);

  // (a) vieja y grande, con tildes, ñ, espacios y emoji
  write(path.join(dir('Proyecto viejo ñandú 🐕'), 'informe final.bin'), 5000, 400);
  // (b) vieja, pero con UN archivo modificado hace 5 días: en uso
  write(path.join(dir('Con archivo reciente'), 'viejo.bin'), 5000, 400);
  write(path.join(dir('Con archivo reciente'), 'nota.txt'), 10, 5);
  // (c) modificada hace 300 días, pero "leída hoy" (antivirus): se ofrece por defecto
  write(path.join(dir('Pasó el antivirus'), 'datos.bin'), 4000, 300, 0);
  // (d) vieja pero pequeña: bajo el tamaño mínimo de la prueba (1000 bytes)
  write(path.join(dir('Pequeña'), 'chica.txt'), 10, 400);
  // (e) fecha intermedia: 200 días (desaparece al subir el período a 1 año)
  write(path.join(dir('Fecha intermedia'), 'medio.bin'), 3000, 200);
  write(path.join(root, 'suelto-reciente.txt'), 5, 1);

  return {
    root,
    base,
    paths: {
      viejo: dir('Proyecto viejo ñandú 🐕'),
      reciente: dir('Con archivo reciente'),
      antivirus: dir('Pasó el antivirus'),
      pequena: dir('Pequeña'),
      intermedia: dir('Fecha intermedia'),
    },
  };
}

/** Antes de abrir la ventana: carpetas de ejemplo y configuración de prueba. */
async function prepare({ app, settings, service }) {
  const fixture = buildFixture(app);
  // La fecha de creación de archivos recién creados no se puede retrasar: se desactiva.
  settings.update({ staleDays: 90, minSizeBytes: 1000, useAccessTime: false, useCreationTime: false, excludedPaths: [] });
  await service.setUsageOptions({ useAccessTime: false, useCreationTime: false });
  return fixture;
}

// ---- Código que se ejecuta DENTRO de la ventana ----------------------------

const READ_WINDOW = `(() => {
  const text = (id) => document.getElementById(id).textContent;
  const hidden = (id) => document.getElementById(id).hidden;
  const title = document.getElementById('res-titulo');
  return {
    estado: document.body.dataset.estado,
    listo: document.body.dataset.listo === '1',
    titulo: { texto: title.textContent, cantidad: Number(title.dataset.cantidad), bytes: Number(title.dataset.bytes) },
    items: [...document.querySelectorAll('#lista > li.carpeta')].map((li) => ({
      ruta: li.dataset.ruta,
      nombre: li.querySelector('.carpeta-nombre').textContent,
      tamano: Number(li.querySelector('.carpeta-tamano').dataset.valor),
      uso: li.querySelector('.carpeta-uso').textContent,
      reciente: li.querySelector('.carpeta-reciente').textContent,
      botones: [...li.querySelectorAll('button')].map((b) => b.textContent),
    })),
    ignoradas: [...document.querySelectorAll('#lista-ignoradas > li')].map((li) => li.dataset.ruta),
    ignoradasVacio: !hidden('ignoradas-vacio'),
    vacioVisible: !hidden('vacio'),
    vacioTexto: text('vacio'),
    calculandoVisible: !hidden('calculando'),
    omitidosVisible: !hidden('aviso-omitidos'),
    mensaje: hidden('mensaje') ? '' : text('mensaje'),
    mover: { deshabilitado: document.getElementById('btn-mover').disabled, texto: text('btn-mover'), ayuda: text('txt-mover') },
    atime: text('res-atime'),
    controles: {
      periodo: document.getElementById('sel-periodo').value,
      minimo: document.getElementById('sel-minimo').value,
      minimoTexto: document.getElementById('sel-minimo').selectedOptions[0].textContent,
      acceso: document.getElementById('chk-acceso').checked,
      creacion: document.getElementById('chk-creacion').checked,
    },
    panelTexto: document.getElementById('como-decide').textContent,
    unidades: [...document.querySelectorAll('#unidades button')].map((b) => ({ texto: b.textContent, unidad: b.dataset.unidad })),
    botonElegir: document.getElementById('btn-elegir').textContent,
    avisoSolo: document.querySelector('.aviso').textContent,
  };
})()`;

const READ_ISOLATION = `(async () => {
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  let networkBlocked = false;
  try { await fetch('https://example.com/', { mode: 'no-cors' }); } catch { networkBlocked = true; }
  const bad = await window.byd.chooseDrive('1');
  const drives = await window.byd.listDrives();
  const present = drives.ok ? drives.value.map((d) => d.letter) : [];
  const absent = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').find((l) => !present.includes(l));
  const notListed = await window.byd.chooseDrive(absent);
  const reveal = await window.byd.revealInExplorer('/ruta/que/no/esta/en/el/analisis');
  const exclude = await window.byd.excludePath('/ruta/que/no/esta/en/el/analisis');
  const badPatch = await window.byd.saveSettings({ staleDays: 1 });
  const unknownKey = await window.byd.saveSettings({ __malo: true });
  return {
    hasRequire: typeof window.require !== 'undefined',
    hasProcess: typeof window.process !== 'undefined',
    hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
    bydKeys: Object.keys(window.byd || {}).sort(),
    csp: csp ? csp.getAttribute('content') : null,
    networkBlocked,
    chooseDriveBadLetter: bad,
    chooseDriveNotListed: notListed,
    revealUnknown: reveal,
    excludeUnknown: exclude,
    saveSettingsInvalid: badPatch,
    saveSettingsUnknownKey: unknownKey,
    drivePresent: present,
  };
})()`;

function run({ app, win, context, service, settings, indexUrl, fixture }) {
  const started = Date.now();
  const outDir = path.join(app.getAppPath(), 'smoke-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ok: false, checks: [], startedAt: new Date(started).toISOString() };
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let finished = false;
  let snapshotTaken = false;

  const check = (name, ok, detail) => report.checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const read = () => js(READ_WINDOW);
  const savedSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));

  async function waitFor(predicate, what) {
    for (;;) {
      const state = await read();
      if (predicate(state)) return state;
      if (Date.now() - started > TIME_LIMIT_MS) throw new Error(`Se agotó el tiempo esperando: ${what}`);
      await sleep(100);
    }
  }
  /** Espera a que termine de recalcular ("Calculando…" desaparece) y haya un estado estable. */
  const settled = (what) => waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible, what);

  async function snapshot(name) {
    // Sin esperar un repintado, capturePage puede devolver un fotograma viejo.
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(300);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), image.toPNG());
  }

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
      if (!snapshotTaken && !win.isDestroyed()) await snapshot('ventana.png');
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
    try {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(fixture.base, { recursive: true, force: true });
    } catch {
      /* limpieza best-effort */
    }
    app.exit(code);
  }

  const timer = setTimeout(() => {
    report.checks.push({ name: 'tiempo máximo', ok: false, detail: 'se agotó el tiempo' });
    finish(1, `Se superó el tiempo máximo (${TIME_LIMIT_MS / 1000} s)`);
  }, TIME_LIMIT_MS);

  const names = (state) => state.items.map((i) => i.nombre);
  const P = fixture.paths;

  (async () => {
    try {
      check('las carpetas de ejemplo no están en una ruta protegida', !isProtectedPath(fixture.root), fixture.root);
      context.smokeFolder = fixture.root;
      context.revealHook = (p) => (report.revealCalls = [...(report.revealCalls || []), p]);

      await new Promise((resolve, reject) => {
        if (!win.webContents.isLoading()) return resolve();
        win.webContents.once('did-finish-load', resolve);
        win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error(`No cargó la ventana: ${desc} (${code})`)));
      });
      check('la ventana cargó la página propia', sameFileUrl(win.webContents.getURL(), indexUrl), win.webContents.getURL());
      win.setSize(980, 1200); // alto suficiente para que la captura muestre toda la lista

      // --- Aislamiento y red --------------------------------------------------
      const home = await waitFor((s) => s.listo, 'que la interfaz termine de iniciar');
      const iso = await js(READ_ISOLATION);
      report.isolation = iso;
      check('aislamiento: sin require en la ventana', !iso.hasRequire, iso.hasRequire);
      check('aislamiento: sin process en la ventana', !iso.hasProcess, iso.hasProcess);
      check('aislamiento: ipcRenderer no está expuesto', !iso.hasIpcRenderer, iso.hasIpcRenderer);
      check('puente: solo las funciones previstas', JSON.stringify(iso.bydKeys) === JSON.stringify(BRIDGE_KEYS), iso.bydKeys);
      check('política CSP estricta', iso.csp && iso.csp.startsWith("default-src 'self'") && iso.csp.includes("connect-src 'none'"), iso.csp);
      check('la CSP bloquea conexiones', iso.networkBlocked, iso.networkBlocked);
      check('IPC: letra de unidad inválida rechazada', iso.chooseDriveBadLetter && iso.chooseDriveBadLetter.ok === false, iso.chooseDriveBadLetter);
      check('IPC: unidad que el principal no detecta, rechazada', iso.chooseDriveNotListed && iso.chooseDriveNotListed.ok === false, iso.chooseDriveNotListed);
      check('IPC: "Mostrar en el Explorador" rechaza rutas fuera del análisis', iso.revealUnknown && iso.revealUnknown.ok === false, iso.revealUnknown);
      check('IPC: "Ignorar" rechaza rutas fuera del análisis', iso.excludeUnknown && iso.excludeUnknown.ok === false, iso.excludeUnknown);
      check('IPC: configuración inválida rechazada', iso.saveSettingsInvalid && iso.saveSettingsInvalid.ok === false, iso.saveSettingsInvalid);
      check('IPC: opción desconocida rechazada', iso.saveSettingsUnknownKey && iso.saveSettingsUnknownKey.ok === false, iso.saveSettingsUnknownKey);

      // Bloqueo de la SESIÓN (lockDownSession en main.js), probado desde el proceso principal.
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

      // --- Pantalla de inicio ---------------------------------------------------
      check('inicio: aviso "solo analiza"', home.avisoSolo.includes('solo analiza. No borra ni mueve nada'), home.avisoSolo);
      check('inicio: botón "Elegir carpeta…"', home.botonElegir === 'Elegir carpeta…', home.botonElegir);
      const wantDrives = process.platform === 'win32';
      check(
        'inicio: botones de unidades ("Escanear C:", …)',
        wantDrives ? home.unidades.length > 0 && home.unidades.every((u) => u.texto === `Escanear ${u.unidad}:`) && home.unidades.some((u) => u.unidad === 'C') : home.unidades.length === 0,
        home.unidades,
      );
      check('la configuración de prueba llegó a la ventana', home.controles.minimoTexto.includes('1000') || home.controles.minimoTexto.includes('1.000'), home.controles);

      // --- Escaneo y lista -------------------------------------------------------
      await js("document.getElementById('btn-elegir').click()");
      const first = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible, 'los resultados del escaneo');
      report.first = first;
      const found = names(first);
      check('aparece la carpeta vieja grande (con ñ, tildes y emoji)', found.includes('Proyecto viejo ñandú 🐕'), found);
      check('aparece la carpeta con atime reciente ("antivirus")', found.includes('Pasó el antivirus'), found);
      check('aparece la de fecha intermedia', found.includes('Fecha intermedia'), found);
      check('NO aparece la que tiene un archivo de hace 5 días', !found.includes('Con archivo reciente'), found);
      check('NO aparece la pequeña bajo el mínimo', !found.includes('Pequeña'), found);
      check('orden por tamaño, de mayor a menor', JSON.stringify(first.items.map((i) => i.tamano)) === JSON.stringify([5000, 4000, 3000]), first.items.map((i) => i.tamano));
      check('encabezado: "3 carpetas sin uso · …"', /^3 carpetas sin uso · /.test(first.titulo.texto) && first.titulo.cantidad === 3 && first.titulo.bytes === 12000, first.titulo);
      const viejo = first.items.find((i) => i.nombre === 'Proyecto viejo ñandú 🐕');
      const anti = first.items.find((i) => i.nombre === 'Pasó el antivirus');
      check('texto "Sin uso hace…" legible', viejo && /^Sin uso hace 1 año y 1 mes/.test(viejo.uso) && anti && /^Sin uso hace 10 meses/.test(anti.uso), { viejo: viejo && viejo.uso, anti: anti && anti.uso });
      check('muestra el archivo más reciente', viejo && viejo.reciente.startsWith('Archivo más reciente: informe final.bin ('), viejo && viejo.reciente);
      check('cada carpeta tiene "Mostrar en el Explorador" e "Ignorar esta carpeta"', first.items.every((i) => i.botones.join('|') === 'Mostrar en el Explorador|Ignorar esta carpeta'), first.items.map((i) => i.botones));
      check('botón "Mover a disco externo…" desactivado con su explicación', first.mover.deshabilitado && first.mover.texto === 'Mover a disco externo…' && first.mover.ayuda === 'Disponible en la próxima versión', first.mover);
      check('panel "Cómo decide BoneYardDog" visible', first.panelTexto.includes('ningún archivo') && first.panelTexto.includes('Limitación'), first.panelTexto.slice(0, 80));
      check('sin carpetas omitidas, no hay aviso de permisos', !first.omitidosVisible, first.omitidosVisible);
      check('sin mensajes de error', first.mensaje === '', first.mensaje);
      check('mensaje de fiabilidad de atime visible (avanzado)', first.atime.length > 10, first.atime);
      check('opciones avanzadas: acceso apagado, creación apagada (configuración de prueba)', !first.controles.acceso && !first.controles.creacion, first.controles);

      await snapshot('ventana.png');
      snapshotTaken = true;

      // --- Cambiar el período (sin volver a escanear) ---------------------------
      await js("(() => { const s = document.getElementById('sel-periodo'); s.value = '365'; s.dispatchEvent(new Event('change')); })()");
      const year = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.titulo.cantidad === 1, 'el recálculo a 1 año');
      check('con "1 año" desaparecen las de fecha intermedia y antivirus', JSON.stringify(names(year)) === JSON.stringify(['Proyecto viejo ñandú 🐕']), names(year));
      check('el período se guardó en el archivo de configuración', savedSettings().staleDays === 365, savedSettings());

      await js("(() => { const s = document.getElementById('sel-periodo'); s.value = '30'; s.dispatchEvent(new Event('change')); })()");
      const month = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.controles.periodo === '30', 'el recálculo a 1 mes');
      check('con "1 mes" siguen sin aparecer las que tienen un archivo reciente', !names(month).includes('Con archivo reciente'), names(month));
      await js("(() => { const s = document.getElementById('sel-periodo'); s.value = '90'; s.dispatchEvent(new Event('change')); })()");
      await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.titulo.cantidad === 3, 'volver a 3 meses');

      // --- Tamaño mínimo y estado vacío -------------------------------------------
      await js("(() => { const s = document.getElementById('sel-minimo'); s.value = '10737418240'; s.dispatchEvent(new Event('change')); })()");
      const empty = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.titulo.cantidad === 0, 'el estado vacío');
      check('estado vacío claro', empty.vacioVisible && empty.vacioTexto === 'No hay carpetas sin uso con estos filtros.', empty.vacioTexto);
      check('el tamaño mínimo se guardó', savedSettings().minSizeBytes === 10737418240, savedSettings());
      await js("(() => { const s = document.getElementById('sel-minimo'); s.value = '1000'; s.dispatchEvent(new Event('change')); })()");
      await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.titulo.cantidad === 3, 'volver al mínimo de prueba');

      // --- Opciones avanzadas ------------------------------------------------------
      await js("document.getElementById('chk-acceso').click()");
      const withAccess = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && s.controles.acceso && !names(s).includes('Pasó el antivirus'), 'usar la fecha de acceso');
      check('con "usar fecha de acceso", la del antivirus pasa a estar en uso', !names(withAccess).includes('Pasó el antivirus'), names(withAccess));
      check('la opción avanzada se guardó', savedSettings().useAccessTime === true, savedSettings());
      await js("document.getElementById('chk-acceso').click()");
      await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && !s.controles.acceso && names(s).includes('Pasó el antivirus'), 'apagar la fecha de acceso');

      // --- Mostrar en el Explorador (sin abrir nada de verdad) -----------------------
      await js(`(() => { const li = [...document.querySelectorAll('#lista > li')].find((l) => l.dataset.ruta === ${JSON.stringify(P.viejo)}); li.querySelector('.btn-mostrar').click(); })()`);
      for (let i = 0; i < 50 && !(report.revealCalls || []).length; i++) await sleep(100);
      check('"Mostrar en el Explorador" llama con la ruta de esa carpeta', JSON.stringify(report.revealCalls) === JSON.stringify([P.viejo]), report.revealCalls);

      // --- Ignorar y volver a considerar --------------------------------------------
      await js(`(() => { const li = [...document.querySelectorAll('#lista > li')].find((l) => l.dataset.ruta === ${JSON.stringify(P.antivirus)}); li.querySelector('.btn-ignorar').click(); })()`);
      const ignored = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && !names(s).includes('Pasó el antivirus') && s.ignoradas.length === 1, 'ignorar una carpeta');
      check('"Ignorar" la quita de la lista y la pasa a "Carpetas ignoradas"', JSON.stringify(ignored.ignoradas) === JSON.stringify([P.antivirus]) && ignored.titulo.cantidad === 2, { ignoradas: ignored.ignoradas, cantidad: ignored.titulo.cantidad });
      check('lo ignorado quedó guardado en el archivo de configuración', JSON.stringify(savedSettings().excludedPaths) === JSON.stringify([P.antivirus]), savedSettings().excludedPaths);
      await js(`(() => { const li = [...document.querySelectorAll('#lista-ignoradas > li')].find((l) => l.dataset.ruta === ${JSON.stringify(P.antivirus)}); li.querySelector('.btn-reconsiderar').click(); })()`);
      const back = await waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && names(s).includes('Pasó el antivirus') && s.ignoradas.length === 0, 'volver a considerar');
      check('"Volver a considerar" la devuelve a la lista', back.titulo.cantidad === 3 && back.ignoradasVacio, { cantidad: back.titulo.cantidad });
      check('y se quita del archivo de configuración', savedSettings().excludedPaths.length === 0, savedSettings().excludedPaths);

      // --- Archivo guardado por completo ------------------------------------------------
      const finalSettings = savedSettings();
      check('settings.json tiene el esquema esperado', finalSettings.version === 1 && finalSettings.staleDays === 90 && finalSettings.minSizeBytes === 1000, finalSettings);

      await finish(report.checks.every((c) => c.ok) ? 0 : 1);
    } catch (err) {
      await finish(1, err);
    }
  })();
}

module.exports = { prepare, run };
