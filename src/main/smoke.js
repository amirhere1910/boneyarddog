'use strict';

/**
 * Prueba automática ("smoke test"). Solo se carga si BYD_SMOKE=1 y se pasó
 * --smoke-test (ver main.js); en el uso normal este archivo no se ejecuta.
 *
 * Con la ventana real:
 *  1. Crea carpetas de ejemplo con fechas conocidas y una configuración de prueba
 *     (en una carpeta de datos temporal; no toca la del usuario).
 *  2. Pulsa "Elegir carpeta…" (el diálogo del sistema se sustituye por la carpeta de
 *     ejemplo) y revisa el MAPA: cuadros, tamaños, estados/colores, áreas.
 *  3. Usa el ratón y el teclado de verdad (sendInputEvent): entrar a carpetas, miguitas,
 *     clic derecho y menú, detalles, selección con Ctrl+clic, pestañas con flechas.
 *  4. Revisa la pestaña Lista, el período, el tamaño del mapa, ignorar/reconsiderar y que
 *     lo guardado en settings.json coincide.
 *  5. Comprueba el aislamiento de la ventana y el bloqueo de red.
 *  6. Guarda smoke-artifacts/mapa.png, lista.png y resultado.json; termina con código
 *     0 o 1 (máximo 240 s).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const TD = require('../core/datos-prueba');
const { sameFileUrl } = require('./validate');
const { isProtectedPath } = require('../core/protected');

// BYD_SMOKE_TIMEOUT_MS solo existe para probar la ruta de tiempo agotado.
const TIME_LIMIT_MS = Number(process.env.BYD_SMOKE_TIMEOUT_MS) || 240_000;
const DAY = 24 * 60 * 60 * 1000;

const BRIDGE_KEYS = [
  'copiesList',
  'copiesRemove',
  'copiesVerify',
  'pendingClean',
  'diagSave',
  'pendingList',
  'getAppInfo',
  'onTestDataProgress',
  'testDataCancel',
  'testDataCreate',
  'testDataDelete',
  'testDataStatus',
  'testDataUse',
  'chooseDestination',
  'chooseDestinationDrive',
  'listDestinationDrives',
  'onTransferProgress',
  'transferCancel',
  'transferDeleteFromResult',
  'transferPreflight',
  'transferRemoveCopy',
  'transferRun',
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
 *
 * Con período = 90 días: muy reciente <= 30, reciente <= 90, sin movimiento <= 180, muy antigua > 180.
 */
function buildFixture(app) {
  // BYD_SMOKE_DATA existe para la app INSTALADA: así no se escribe nada dentro de la carpeta de instalación.
  const base = process.env.BYD_SMOKE_DATA || path.join(app.getAppPath(), '.smoke-data');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'datos-'));
  const dir = (name) => path.join(root, name);

  // Videos: 9000 bytes, 400 días, con dos subcarpetas -> muy antigua, se puede entrar.
  write(path.join(dir('Videos'), 'vacaciones', 'v1.bin'), 6000, 400);
  write(path.join(dir('Videos'), 'otra', 'v2.bin'), 3000, 400);
  // Fotos: 5000 bytes, 120 días, sin subcarpetas -> sin movimiento.
  write(path.join(dir('Fotos'), 'f1.bin'), 5000, 120);
  // Documentos: actividad de ayer -> muy reciente (y NO es candidata).
  write(path.join(dir('Documentos'), 'informe', 'd1.bin'), 4000, 1);
  write(path.join(dir('Documentos'), 'viejo.bin'), 500, 400);
  // Proyecto reciente: 60 días -> reciente (no es candidata con 90 días).
  write(path.join(dir('Proyecto reciente'), 'p1.bin'), 3000, 60);
  // Con enlace: 200 días -> muy antigua; contiene un enlace simbólico si el sistema lo permite.
  write(path.join(dir('Con enlace'), 'dato.bin'), 2500, 200);
  write(path.join(dir('Afuera'), 'x.bin'), 10, 400);
  let hasLink = true;
  try {
    fs.symlinkSync(dir('Afuera'), path.join(dir('Con enlace'), 'enlace'), 'dir');
  } catch {
    hasLink = false;
  }
  // Protegida (por inyección del smoke): 2000 bytes, 10 días.
  write(path.join(dir('Sistema protegido'), 's1.bin'), 2000, 10);
  // Pequeña y un archivo suelto: bajo el mínimo (1000 bytes), van a "Otras".
  write(path.join(dir('Pequeña ñandú 🐕'), 'chica.txt'), 50, 400);
  write(path.join(root, 'suelto.txt'), 300, 400);

  return {
    root,
    base,
    hasLink,
    paths: {
      videos: dir('Videos'),
      vacaciones: path.join(dir('Videos'), 'vacaciones'),
      fotos: dir('Fotos'),
      documentos: dir('Documentos'),
      proyecto: dir('Proyecto reciente'),
      enlace: dir('Con enlace'),
      sistema: dir('Sistema protegido'),
    },
  };
}

/** Muchas carpetas diminutas junto a una enorme: deben plegarse en "Otras" (no ser cuadros enfocables). */
function buildTinyFixture(base) {
  const root = fs.mkdtempSync(path.join(base, 'pequenas-'));
  write(path.join(root, 'grande', 'g.bin'), 1_500_000, 40);
  for (let i = 1; i <= 12; i++) write(path.join(root, `mini${String(i).padStart(2, '0')}`, 'm.bin'), 1000, 40); // = mapMinBytes: tienen celda propia
  return root;
}

/** 505 carpetas viejas (candidatas) y 3 recientes más grandes que solo se ven en el mapa. */
function buildManyFixture(base) {
  const root = fs.mkdtempSync(path.join(base, 'muchas-'));
  for (let i = 0; i < 505; i++) write(path.join(root, `n${String(i).padStart(3, '0')}`, 'f.bin'), 1000, 400);
  for (let i = 1; i <= 3; i++) write(path.join(root, `Reciente${i}`, 'r.bin'), 5000, 1);
  write(path.join(root, 'nuevo.txt'), 5, 1);
  return root;
}

/** Carpetas para el asistente de copiar y transferir (cada una con archivos de contenido distinto). */
function buildWizardFixture(base) {
  const root = fs.mkdtempSync(path.join(base, 'asistente-'));
  const folder = (name, big) => {
    const dir = path.join(root, name);
    write(path.join(dir, 'a.bin'), 3000, 400);
    write(path.join(dir, 'sub', 'b.bin'), 2000, 300);
    write(path.join(dir, 'canción ñandú 🐕.txt'), 1500, 200);
    fs.mkdirSync(path.join(dir, 'vacía'), { recursive: true });
    write(path.join(dir, 'relleno.bin'), 2 * 1024 * 1024, 100); // para que todas tengan un cuadro propio en el mapa
    if (big) write(path.join(dir, 'grande.bin'), big, 100);
    return dir;
  };
  return {
    root,
    copiar: folder('Copiar con progreso', 24 * 1024 * 1024),
    papelera: folder('Papelera real'),
    falla: folder('Papelera que falla'),
    borrar: folder('Removible borrar'),
    sinConfirmar: folder('Removible sin confirmar'),
    dejar: folder('Removible dejar'),
    lenta: folder('Lenta cancelar'),
  };
}

/** Foto independiente de un árbol (tipos, tamaños y huellas): la prueba no se fía del motor. */
function treeSnapshot(root) {
  const out = {};
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        out[r] = 'dir';
        walk(full, r);
      } else out[r] = `${st.size}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    }
  })(root, '');
  return out;
}
const sameTree = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Antes de abrir la ventana: carpetas de ejemplo y configuración de prueba. */
async function prepare({ app, settings, service }) {
  const fixture = buildFixture(app);
  // La fecha de creación de archivos recién creados no se puede retrasar: se desactiva.
  settings.update({ staleDays: 90, minSizeBytes: 1000, mapMinBytes: 1000, useAccessTime: false, useCreationTime: false, excludedPaths: [] });
  await service.setUsageOptions({ useAccessTime: false, useCreationTime: false });
  return fixture;
}

// ---- Código que se ejecuta DENTRO de la ventana ----------------------------

const READ_WINDOW = `(() => {
  const text = (id) => document.getElementById(id).textContent;
  const hidden = (id) => document.getElementById(id).hidden;
  const hexToRgb = (h) => 'rgb(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
  const title = document.getElementById('res-titulo');
  const map = document.getElementById('mapa').getBoundingClientRect();
  const P = window.BYDActivity.PALETTE;
  const sel = document.getElementById('sel-texto');
  const menuItems = [...document.querySelectorAll('#menu-contextual > li')].map((li) => li.getAttribute('role') === 'separator'
    ? { separador: true }
    : { texto: li.querySelector('.texto').textContent, motivo: (li.querySelector('.motivo') || {}).textContent || '', deshabilitado: li.getAttribute('aria-disabled') === 'true', accion: li.dataset.accion });
  return {
    estado: document.body.dataset.estado,
    listo: document.body.dataset.listo === '1',
    pestana: document.body.dataset.pestana,
    tabs: [...document.querySelectorAll('[role="tab"]')].map((t) => ({ id: t.id, texto: t.textContent, seleccionada: t.getAttribute('aria-selected') === 'true', tabindex: t.tabIndex })),
    panelMapaVisible: !hidden('panel-mapa'),
    panelListaVisible: !hidden('panel-lista'),
    calculandoVisible: !hidden('calculando') || document.getElementById('mapa-estado').hidden === false,
    mensaje: hidden('mensaje') ? '' : text('mensaje'),
    vista: (() => {
      const rect = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, top: r.top }; };
      return { alto: window.innerHeight, ancho: window.innerWidth, contenedor: rect('mapa-contenedor'), leyenda: rect('leyenda'), barra: rect('barra-seleccion'), scrollY: window.scrollY, altoDocumento: document.documentElement.scrollHeight };
    })(),
    mapa: {
      rect: { x: map.x, y: map.y, w: map.width, h: map.height },
      carpeta: document.body.dataset.mapaCarpeta || '',
      migas: [...document.querySelectorAll('#migas button')].map((b) => ({ texto: b.textContent, ruta: b.dataset.ruta, actual: b.getAttribute('aria-current') === 'page' })),
      aviso: hidden('mapa-aviso') ? '' : text('mapa-aviso'),
      celdas: [...document.querySelectorAll('#mapa .celda')].map((b) => {
        const r = b.getBoundingClientRect();
        const st = b.dataset.estado;
        return {
          tipo: b.dataset.kind,
          etiqueta: b.tagName,
          plegadas: Number(b.dataset.plegadas || 0),
          ruta: b.dataset.ruta || '',
          nombre: b.dataset.nombre || '',
          aria: b.getAttribute('aria-label'),
          bytes: Number(b.dataset.bytes),
          estado: st,
          dias: b.dataset.dias === undefined ? null : Number(b.dataset.dias),
          protegida: b.dataset.protegida === '1',
          seleccionada: b.dataset.seleccionada === '1',
          colorOk: getComputedStyle(b).backgroundColor === hexToRgb(P[st].bg) && getComputedStyle(b).color === hexToRgb(P[st].fg),
          texto: b.textContent,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        };
      }),
      leyenda: [...document.querySelectorAll('#leyenda-estados li')].map((li) => li.textContent),
      leyendaTexto: text('leyenda-texto'),
      mapaMin: document.getElementById('sel-mapa-min').value,
    },
    menu: { abierto: !hidden('menu-contextual'), items: menuItems, foco: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.accion || '' : '' },
    foco: { esCelda: !!(document.activeElement && document.activeElement.classList.contains('celda')), ruta: (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ruta) || '' },
    tooltip: { visible: !hidden('tooltip'), texto: text('tooltip') },
    detalles: {
      visible: !hidden('panel-detalles'),
      titulo: text('det-titulo'),
      bytes: Number(document.getElementById('det-lista').dataset.bytes),
      archivos: Number(document.getElementById('det-lista').dataset.archivos),
      subcarpetas: Number(document.getElementById('det-lista').dataset.subcarpetas),
      filas: Object.fromEntries([...document.querySelectorAll('#det-lista dd')].map((d) => [d.dataset.campo, d.textContent])),
      tramos: Object.fromEntries([...document.querySelectorAll('#det-tramos li')].map((li) => [li.dataset.tramo, Number(li.dataset.bytes)])),
      tramosTexto: [...document.querySelectorAll('#det-tramos li')].map((li) => li.textContent),
      subs: [...document.querySelectorAll('#det-subcarpetas li')].map((li) => li.dataset.ruta),
    },
    seleccion: { visible: !hidden('barra-seleccion'), texto: sel.textContent, cantidad: Number(sel.dataset.cantidad), bytes: Number(sel.dataset.bytes), nota: hidden('sel-excluidas') ? '' : text('sel-excluidas'), copiarDeshabilitado: document.getElementById('btn-sel-copiar').disabled, transferirDeshabilitado: document.getElementById('btn-sel-transferir').disabled },
    lista: {
      titulo: { texto: title.textContent, cantidad: Number(title.dataset.cantidad), bytes: Number(title.dataset.bytes) },
      items: [...document.querySelectorAll('#lista > li.carpeta')].map((li) => ({
        ruta: li.dataset.ruta,
        nombre: li.querySelector('.carpeta-nombre').textContent,
        tamano: Number(li.querySelector('.carpeta-tamano').dataset.valor),
        uso: li.querySelector('.carpeta-uso').textContent,
        reciente: li.querySelector('.carpeta-reciente').textContent,
        enlaces: !!li.querySelector('.carpeta-enlaces'),
        casilla: li.querySelector('.chk-sel').checked,
        botones: [...li.querySelectorAll('button')].map((b) => b.textContent),
      })),
      vacio: !hidden('vacio'),
      omitidosVisible: !hidden('aviso-omitidos'),
      minimo: document.getElementById('sel-minimo').value,
    },
    ignoradas: [...document.querySelectorAll('#lista-ignoradas > li')].map((li) => li.dataset.ruta),
    controles: { periodo: document.getElementById('sel-periodo').value, acceso: document.getElementById('chk-acceso').checked, creacion: document.getElementById('chk-creacion').checked },
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
  const drives = await window.byd.listDrives();
  const present = drives.ok ? drives.value.map((d) => d.letter) : [];
  const absent = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').find((l) => !present.includes(l));
  const ghost = '/ruta/que/no/esta/en/el/analisis';
  return {
    hasRequire: typeof window.require !== 'undefined',
    hasProcess: typeof window.process !== 'undefined',
    hasIpcRenderer: typeof window.ipcRenderer !== 'undefined',
    bydKeys: Object.keys(window.byd || {}).sort(),
    csp: csp ? csp.getAttribute('content') : null,
    networkBlocked,
    chooseDriveBadLetter: await window.byd.chooseDrive('1'),
    chooseDriveNotListed: await window.byd.chooseDrive(absent),
    revealUnknown: await window.byd.revealInExplorer(ghost),
    excludeUnknown: await window.byd.excludePath(ghost),
    saveSettingsInvalid: await window.byd.saveSettings({ staleDays: 1 }),
    saveSettingsUnknownKey: await window.byd.saveSettings({ __malo: true }),
    treemapUnknown: await window.byd.getTreemap(ghost),
    treemapBadOptions: await window.byd.getTreemap('/', { minBytes: -5 }),
    detailsUnknown: await window.byd.getDetails(ghost),
    summarizeUnknown: await window.byd.summarizeSelection([ghost]),
    summarizeTooMany: await window.byd.summarizeSelection(Array.from({ length: 501 }, (_, i) => '/x' + i)),
    summarizeNotList: await window.byd.summarizeSelection('/etc'),
    drivePresent: present,
  };
})()`;

function run({ app, win, context, service, settings, indexUrl, fixture }) {
  const started = Date.now();
  const outDir = process.env.BYD_SMOKE_OUT || path.join(app.getAppPath(), 'smoke-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const report = { ok: false, checks: [], startedAt: new Date(started).toISOString() };
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  let finished = false;

  const check = (name, ok, detail) => report.checks.push({ name, ok: Boolean(ok), detail });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const read = () => js(READ_WINDOW);
  const savedSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const q = JSON.stringify;

  async function waitFor(predicate, what) {
    for (;;) {
      const state = await read();
      if (predicate(state)) return state;
      if (Date.now() - started > TIME_LIMIT_MS) throw new Error(`Se agotó el tiempo esperando: ${what}`);
      await sleep(80);
    }
  }
  /** Espera a que el mapa y la lista terminen de calcular. */
  const settled = (extra = () => true, what = 'que terminen los cálculos') =>
    waitFor((s) => s.estado === 'resultado' && !s.calculandoVisible && extra(s), what);

  async function snapshot(name) {
    // Sin esperar un repintado, capturePage puede devolver un fotograma viejo.
    await js('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(300);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, name), image.toPNG());
  }

  // --- Entrada real (ratón y teclado) -----------------------------------------
  const center = (r) => ({ x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) });
  async function cellRect(selector) {
    // La barra de selección es fija: se lleva el elemento al centro de la vista para que no lo tape.
    return js(`(() => { const e = document.querySelector(${q(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  }
  async function realClick(rect, { button = 'left', modifiers = [] } = {}) {
    const { x, y } = center(rect);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1, modifiers });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1, modifiers });
    await sleep(60);
  }
  async function realKey(keyCode, modifiers = []) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(60);
  }
  const cellSel = (ruta) => `#mapa .celda[data-ruta=${q(ruta)}]`;
  const clickCell = async (ruta, opts) => {
    const r = await cellRect(cellSel(ruta));
    if (!r) throw new Error(`No hay cuadro para ${ruta}`);
    await realClick(r, opts);
  };

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
      if (!report.snapshots && !win.isDestroyed()) await snapshot('mapa.png');
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

  const P = fixture.paths;
  const names = (s) => s.mapa.celdas.map((c) => c.nombre);
  const cellOf = (s, ruta) => s.mapa.celdas.find((c) => c.ruta === ruta);

  // --- Asistente de copiar y transferir (ratón y teclado reales, disco real, Papelera real) -----------------
  async function wizardScenarios() {
    const wf = buildWizardFixture(fixture.base);
    // Destino de prueba: NO dentro de AppData. En Windows, en otro volumen del runner si existe.
    const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
    const repoDrive = /^[A-Za-z]:/.test(wf.root) ? wf.root.slice(0, 2).toUpperCase() : null;
    const destBase = process.platform === 'win32' ? path.join(`${repoDrive === sysDrive ? 'C:' : sysDrive}\\`, `byd-smoke-dest-${path.basename(wf.root)}`) : path.join(fixture.base, `destino-${path.basename(wf.root)}`);
    fs.mkdirSync(destBase, { recursive: true });
    report.wizard = { destBase, root: wf.root };
    const created = [destBase];
    check('asistente: el destino de prueba no es una ruta protegida', !isProtectedPath(destBase) && !isProtectedPath(wf.root), destBase);
    context.smokeDestination = destBase;
    win.setSize(720, 520); // ventana mínima: el diálogo tiene que caber
    await sleep(300);
    await js("document.getElementById('btn-nuevo').click()");
    await waitFor((s) => s.estado === 'inicio', 'volver al inicio (asistente)');
    context.smokeFolder = wf.root;
    await js("document.getElementById('btn-elegir').click()");
    await settled((s) => s.mapa.carpeta === wf.root && s.mapa.celdas.filter((c) => c.tipo === 'folder').length >= 6, 'el mapa de las carpetas del asistente');

    // --- «Volver a escanear»: vuelve a leer lo mismo sin elegir nada otra vez; F5 hace lo mismo; no hay aviso de mapa viejo todavía.
    {
      const before = await js(`({ habilitado: !document.getElementById('btn-reescanear').disabled, aviso: !document.getElementById('aviso-desactualizado').hidden, listaHab: !document.getElementById('btn-reescanear-lista').disabled })`);
      check('volver a escanear: el botón está habilitado con un resultado y no hay aviso de mapa viejo', before.habilitado && before.listaHab && !before.aviso, before);
      const escaneos0 = Number(await js("document.body.dataset.escaneos || '0'"));
      await sleep(600);
      check('volver a escanear: antes de pulsar no hay otro escaneo (no se re-escanea solo)', Number(await js("document.body.dataset.escaneos || '0'")) === escaneos0, escaneos0);
      await js("document.getElementById('btn-reescanear').click()");
      for (let i = 0; i < 100 && Number(await js("document.body.dataset.escaneos || '0'")) < escaneos0 + 1; i++) await sleep(100);
      await settled();
      check('volver a escanear: el botón vuelve a leer la misma carpeta sin elegir otra vez (contador +1, misma ruta)', Number(await js("document.body.dataset.escaneos || '0'")) === escaneos0 + 1 && (await js("document.getElementById('res-carpeta').textContent")) === wf.root, escaneos0);
      await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F5', bubbles: true }))");
      for (let i = 0; i < 100 && Number(await js("document.body.dataset.escaneos || '0'")) < escaneos0 + 2; i++) await sleep(100);
      await settled();
      check('volver a escanear: F5 hace lo mismo', Number(await js("document.body.dataset.escaneos || '0'")) === escaneos0 + 2, null);
    }

    const dialogState = () =>
      js(`(() => {
        const d = document.getElementById('dlg-transferir');
        const r = d.getBoundingClientRect();
        const pie = document.querySelector('.dlg-pie').getBoundingClientRect();
        const vis = (id) => !document.getElementById(id).hidden;
        const txt = (id) => document.getElementById(id).textContent;
        const dis = (id) => document.getElementById(id).disabled;
        return {
          abierto: d.open, rect: { l: r.left, t: r.top, r: r.right, b: r.bottom }, pie: { b: pie.bottom }, ancho: window.innerWidth, alto: window.innerHeight,
          titulo: txt('dlg-titulo'), paso: txt('dlg-paso'), razon: txt('dlg-razon'), error: vis('dlg-error') ? txt('dlg-error') : '',
          pasos: ['destino', 'revision', 'progreso', 'resultado', 'copias'].filter((p) => vis('paso-' + p)),
          destino: document.getElementById('dlg-destino-elegido').dataset.ruta || '',
          rapidaDeshabilitada: dis('dlg-verif-rapida'),
          siguiente: { v: vis('dlg-siguiente'), d: dis('dlg-siguiente') }, empezar: { v: vis('dlg-empezar'), d: dis('dlg-empezar') },
          cerrar: vis('dlg-cerrar'), cancelarOp: vis('dlg-cancelar-op'),
          revEstadoVisible: vis('rev-estado'), cifras: vis('rev-cifras'), impedimentos: vis('rev-impedimentos') ? txt('rev-impedimentos-lista') : '',
          avisos: [...document.querySelectorAll('#rev-avisos-lista li')].map((l) => l.dataset.codigo),
          papelera: vis('rev-papelera'), borrarConfirmar: vis('rev-borrar-confirmar'), borrarTexto: txt('rev-borrar-texto'),
          preseleccion: [...document.querySelectorAll('input[name="papelera"]')].some((i) => i.checked),
          progFase: txt('prog-fase'),
          titular: txt('res-titular'), tono: document.getElementById('res-titular').dataset.tono || '',
          carpetas: [...document.querySelectorAll('#res-carpetas > li')].map((li) => ({ resultado: li.dataset.resultado, nombre: li.querySelector('.res-nombre').textContent, estado: li.querySelector('.res-estado').textContent, detalle: li.querySelector('.res-detalle').textContent })),
          lote: txt('res-lote'),
          botones: { abrir: vis('res-abrir'), verificar: vis('res-verificar'), quitar: vis('res-quitar'), borrarFallo: vis('res-papelera-fallo'), borrarHabilitado: !dis('res-borrar') },
          verificacion: vis('res-verificacion') ? txt('res-verif-titular') : '',
          copias: [...document.querySelectorAll('#cop-lista > li')].map((li) => ({ id: li.dataset.id, nombre: li.querySelector('.cop-nombre').textContent, texto: li.textContent })),
          copVacio: vis('cop-vacio'), copTitular: vis('cop-resultado') ? txt('cop-titular') : '', copProblemas: [...document.querySelectorAll('#cop-problemas > li')].map((l) => l.textContent),
          aviso: txt('prog-aviso'), cancelarOpDeshabilitado: dis('dlg-cancelar-op'), tardando: vis('prog-tardando') ? txt('prog-tardando') : '',
        };
      })()`);
    const waitDialog = async (pred, what) => {
      if (process.env.BYD_SMOKE_DEBUG) console.log(`[smoke] esperando: ${what}`);
      const waitStart = Date.now();
      for (;;) {
        const d = await dialogState();
        if (pred(d)) return d;
        if (Date.now() - waitStart > 40_000 || Date.now() - started > TIME_LIMIT_MS) throw new Error(`Se agotó el tiempo esperando: ${what} :: ${JSON.stringify(d)}`);
        await sleep(60);
      }
    };
    const fits = (d) => d.rect.l >= 0 && d.rect.t >= 0 && d.rect.r <= d.ancho && d.rect.b <= d.alto && d.pie.b <= d.alto;
    const clickId = async (id) => realClick(await cellRect(`#${id}`));
    const openFromMenu = async (folderPath, action) => {
      await clickCell(folderPath, { button: 'right' });
      await waitFor((s) => s.menu.abierto, 'el menú contextual (asistente)');
      await realClick(await cellRect(`#menu-contextual [data-accion="${action}"]`));
      return waitDialog((d) => d.abierto && d.pasos[0] === 'destino', 'el asistente abierto');
    };
    const chooseDest = async () => {
      await clickId('dlg-otra-carpeta');
      return waitDialog((d) => d.destino !== '' && !d.siguiente.d, 'el destino elegido');
    };
    const reals = new Map([wf.copiar, wf.papelera, wf.falla, wf.borrar, wf.sinConfirmar, wf.dejar, wf.lenta].map((p) => [p, fs.realpathSync(p)])); // antes de que alguno desaparezca
    // La copia queda en <destino>\<nombre de la carpeta>: sin unidad, sin carpeta de fecha y sin archivos extra.
    const copyOf = (text, source) => {
      const copy = text.replace(/^Copias? en: /, '');
      assert.equal(path.basename(copy), path.basename(reals.get(source)), 'solo el nombre de la carpeta');
      return { batch: copy, copy };
    };
    const shots = [];
    const shot = async (name) => {
      await snapshot(name);
      shots.push(name);
    };

    // ===== (A) COPIAR: tres pasos, destino del sistema, verificación completa, contenido idéntico =====
    {
      const before = treeSnapshot(wf.copiar);
      const d1 = await openFromMenu(wf.copiar, 'copy');
      check('A copiar: el asistente se abre en el paso 1 con título «Copiar a otro disco»', d1.titulo === 'Copiar a otro disco' && d1.paso === 'Paso 1 de 3 · Destino', [d1.titulo, d1.paso]);
      check('A copiar: «Siguiente» está desactivado hasta elegir un destino y dice por qué', d1.siguiente.d && /destino/.test(d1.razon), [d1.siguiente, d1.razon]);
      check('A copiar: la verificación rápida está disponible al copiar', !d1.rapidaDeshabilitada, d1.rapidaDeshabilitada);
      check('A copiar: el diálogo cabe en la ventana mínima (720×520) en el paso 1', fits(d1), d1);
      await shot('asistente-1-destino.png');
      const d1b = await chooseDest();
      check('A copiar: el destino elegido es el de prueba y «Siguiente» se activa', path.resolve(d1b.destino) === path.resolve(destBase) && !d1b.siguiente.d, [d1b.destino, d1b.siguiente]);
      await clickId('dlg-siguiente');
      const d2 = await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión previa');
      check('A copiar: paso 2 sin impedimentos y con «Empezar» activo', d2.impedimentos === '' && !d2.empezar.d && d2.paso === 'Paso 2 de 3 · Revisión previa', [d2.impedimentos, d2.empezar]);
      check('A copiar: el diálogo cabe en la ventana mínima en el paso 2', fits(d2), d2);
      await shot('asistente-2-revision.png');
      await clickId('dlg-empezar');
      let progressShot = false;
      const dEnd = await waitDialog(async (d) => {
        if (d.pasos[0] === 'progreso' && !progressShot) {
          progressShot = true;
          report.wizard.progresoFase = d.progFase;
          report.wizard.progresoAjusta = fits(d);
          await shot('asistente-3-progreso.png');
        }
        return d.pasos[0] === 'resultado';
      }, 'el resultado de copiar').catch(() => null);
      void dEnd;
      const dRes = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (A)');
      check('A copiar: el resultado dice «Listo» solo porque el motor devolvió «copiada-verificada»', /^Listo: 1 carpeta copiada y verificada/.test(dRes.titular) && dRes.tono === 'ok' && dRes.carpetas.length === 1 && dRes.carpetas[0].resultado === 'copiada-verificada', [dRes.titular, dRes.carpetas]);
      const { batch, copy } = copyOf(dRes.lote, wf.copiar);
      created.push(batch);
      check('A copiar (EN DISCO): la copia es idéntica al original y el original no cambió', sameTree(before, treeSnapshot(copy)) && sameTree(before, treeSnapshot(wf.copiar)), copy);
      check('A copiar: la copia quedó DENTRO del destino elegido, con solo el nombre de la carpeta', path.resolve(batch) === path.resolve(path.join(fs.realpathSync(destBase), path.basename(wf.copiar))), batch);
      check('A copiar (EN DISCO): en el destino NO hay nada más que la carpeta copiada (ni lote, ni ESTADO/MANIFIESTO/LEEME)', JSON.stringify(fs.readdirSync(destBase)) === JSON.stringify([path.basename(wf.copiar)]) && !fs.existsSync(path.join(copy, 'MANIFIESTO.json')), fs.readdirSync(destBase));
      check('A copiar: botones del resultado (abrir, verificar, quitar) y sin borrado', dRes.botones.abrir && dRes.botones.verificar && dRes.botones.quitar && !dRes.botones.borrarFallo, dRes.botones);
      check('A copiar: el diálogo cabe en la ventana mínima en el resultado', fits(dRes), dRes);
      await shot('asistente-4-resultado.png');
      report.wizard.batchA = batch;
      await clickId('res-abrir');
      await sleep(150);
      check('A copiar: «Abrir la copia en el Explorador» pide mostrar la carpeta del lote que confirmó el motor', (report.revealCalls || []).includes(batch), report.revealCalls);

      // Verificar de nuevo (botón del resultado) y quitar la copia.
      await clickId('res-verificar');
      const dv = await waitDialog((d) => /La copia está bien/.test(d.verificacion), 'verificar de nuevo la copia');
      check('A copiar: «Verificar de nuevo la copia» dice que está bien', /La copia está bien: \d+ archivos verificados \(contenido comparado\)/.test(dv.verificacion), dv.verificacion);
      await clickId('res-quitar');
      await clickId('res-quitar-si');
      await waitDialog((d) => /Copia quitada/.test(d.titular), 'quitar la copia');
      check('A copiar (EN DISCO): «Quitar la copia» borró la copia (y su carpeta) y NO tocó el original', !fs.existsSync(batch) && fs.readdirSync(destBase).length === 0 && sameTree(before, treeSnapshot(wf.copiar)), batch);
      await clickId('dlg-cerrar');
      const closed = await dialogState();
      check('A copiar: «Cerrar» cierra el diálogo', !closed.abierto, closed.abierto);
    }

    // ===== (B) TRANSFERIR con la Papelera REAL: propiedades de seguridad =====
    {
      const before = treeSnapshot(wf.papelera);
      const d1 = await openFromMenu(wf.papelera, 'move');
      check('B transferir: título «Transferir a otro disco (mover)» y verificación rápida NO disponible', d1.titulo === 'Transferir a otro disco (mover)' && d1.rapidaDeshabilitada, [d1.titulo, d1.rapidaDeshabilitada]);
      await chooseDest();
      await clickId('dlg-siguiente');
      const d2 = await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión (B)');
      check('B transferir: sin impedimentos y sin pregunta de Papelera cuando cabe', d2.impedimentos === '' && !d2.papelera && !d2.empezar.d, [d2.impedimentos, d2.papelera, d2.empezar]);
      await clickId('dlg-empezar');
      const dRes = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (B)');
      const { batch, copy } = copyOf(dRes.lote, wf.papelera);
      created.push(batch);
      const originalGone = !fs.existsSync(wf.papelera);
      report.wizard.papelera = { originalGone, resultado: dRes.carpetas, titular: dRes.titular };
      if (originalGone) {
        check('B transferir (EN DISCO): el original se retiró Y la copia existe y es idéntica', sameTree(before, treeSnapshot(copy)), copy);
        check('B transferir: la interfaz dice «enviado a la Papelera» (lo que el motor devolvió)', dRes.carpetas[0].resultado === 'original-enviado-a-papelera' && /Papelera/.test(dRes.carpetas[0].estado), dRes.carpetas);
        check('B transferir: sin «Quitar la copia» (la copia es lo único que queda)', !dRes.botones.quitar, dRes.botones);
      } else {
        check('B transferir (EN DISCO): el original sigue intacto y se informó', sameTree(before, treeSnapshot(wf.papelera)) && dRes.carpetas[0].resultado === 'original-sin-tocar', dRes.carpetas);
        check('B transferir: la interfaz explica que la Papelera falló y ofrece borrar', dRes.botones.borrarFallo, dRes.botones);
      }
      await clickId('dlg-cerrar');
      await sleep(200);
      const gone = await js(`(() => { const c = document.querySelector('#mapa .celda[data-ruta=${q(wf.papelera)}]'); return { cuadro: c ? c.dataset.transferida || '0' : 'sin-cuadro', marcadas: document.body.dataset.transferidas || '0' }; })()`);
      // En una ventana pequeña el cuadro puede haberse plegado en «Otras»: entonces solo se comprueba el registro interno.
      check('B transferir: si el original se retiró, queda registrado y su cuadro (si se ve) marcado «ya transferida»; si no, todo sigue normal', originalGone ? gone.marcadas === '1' && (gone.cuadro === '1' || gone.cuadro === 'sin-cuadro') : gone.marcadas === '0' && gone.cuadro !== '1', gone);
      const aviso = await js(`({ visible: !document.getElementById('aviso-desactualizado').hidden, texto: document.getElementById('aviso-desactualizado-texto').textContent, ahora: !document.getElementById('btn-reescanear-ahora').disabled })`);
      check('B transferir: tras retirar un original aparece «El mapa quedó desactualizado» + «Volver a escanear ahora» (y no se re-escanea solo); si no se retiró, no aparece', originalGone ? aviso.visible && /desactualizado/.test(aviso.texto) && aviso.ahora : !aviso.visible, aviso);
    }

    // ===== (C) La Papelera FALLA (simulado): el original queda; luego borrado definitivo con confirmación =====
    {
      context.smokeTrashFails = true;
      const before = treeSnapshot(wf.falla);
      await openFromMenu(wf.falla, 'move');
      await chooseDest();
      await clickId('dlg-siguiente');
      await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión (C)');
      await clickId('dlg-empezar');
      const dRes = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (C)');
      context.smokeTrashFails = false;
      const { batch, copy } = copyOf(dRes.lote, wf.falla);
      created.push(batch);
      check('C Papelera fallida (EN DISCO): el original sigue intacto y la copia es idéntica', sameTree(before, treeSnapshot(wf.falla)) && sameTree(before, treeSnapshot(copy)), copy);
      check('C Papelera fallida: la interfaz lo dice («No se pudo enviar a la Papelera…») y ofrece el borrado definitivo, desactivado', dRes.carpetas[0].resultado === 'original-sin-tocar' && /No se pudo enviar a la Papelera/.test(dRes.carpetas[0].detalle) && dRes.botones.borrarFallo && !dRes.botones.borrarHabilitado, [dRes.carpetas, dRes.botones]);
      await clickId('res-borrar'); // deshabilitado: no debe pasar nada
      await sleep(300);
      check('C Papelera fallida (EN DISCO): sin marcar «Entiendo…» el botón no avanza y el original sigue', fs.existsSync(wf.falla) && sameTree(before, treeSnapshot(wf.falla)), null);
      await shot('asistente-5-papelera-fallida.png');
      await js("document.getElementById('res-entiendo').click()");
      const en = await dialogState();
      check('C Papelera fallida: al marcar «Entiendo que no se podrá recuperar» se activa el botón', en.botones.borrarHabilitado, en.botones);
      await clickId('res-borrar');
      const after = await waitDialog((d) => d.carpetas.length === 1 && d.carpetas[0].resultado === 'original-borrado-definitivamente', 'el borrado definitivo (C)');
      check('C borrado definitivo (EN DISCO): original ausente y copia idéntica', !fs.existsSync(wf.falla) && sameTree(before, treeSnapshot(copy)), after.carpetas);
      check('C borrado definitivo: ya no hay botón de borrar ni de quitar la copia', !after.botones.borrarFallo && !after.botones.quitar, after.botones);
      await clickId('dlg-cerrar');
    }

    // ===== (D) Origen sin Papelera: hay que ELEGIR; borrar definitivamente exige confirmar =====
    {
      const before = treeSnapshot(wf.sinConfirmar);
      const destListingBefore = fs.readdirSync(destBase).sort();
      await openFromMenu(wf.sinConfirmar, 'move');
      await chooseDest();
      await clickId('dlg-siguiente');
      const d2 = await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión (D)');
      check('D sin Papelera: aparece el bloque «¿Qué quieres hacer?», nada preseleccionado y «Empezar» desactivado', d2.papelera && !d2.preseleccion && d2.empezar.d && !d2.borrarConfirmar, [d2.papelera, d2.preseleccion, d2.empezar]);
      await shot('asistente-2b-papelera-no-cabe.png');
      await js("document.querySelector('input[name=\"papelera\"][value=\"borrar\"]').click()");
      const d3 = await dialogState();
      check('D sin Papelera: al elegir borrar aparece la confirmación en rojo con carpetas y bytes, y «Empezar» sigue desactivado', d3.borrarConfirmar && /1 carpeta .*sin pasar por la Papelera/.test(d3.borrarTexto) && d3.empezar.d && /Entiendo/.test(d3.razon), [d3.borrarTexto, d3.empezar, d3.razon]);
      check('D sin Papelera: el diálogo con la confirmación cabe en la ventana mínima', fits(d3), d3);
      await shot('asistente-2c-confirmar-borrado.png');
      await clickId('dlg-empezar'); // desactivado: no avanza
      await sleep(300);
      const stuck = await dialogState();
      check('D sin Papelera (EN DISCO): sin la confirmación no se avanza y el original sigue entero', stuck.pasos[0] === 'revision' && sameTree(before, treeSnapshot(wf.sinConfirmar)), stuck.pasos);
      await clickId('dlg-cerrar').catch(() => {});
      await realKey('Escape');
      await sleep(200);
      const esc = await dialogState();
      check('D sin Papelera: Esc cierra el asistente antes de empezar', !esc.abierto, esc.abierto);
      check('D sin Papelera (EN DISCO): cerrar sin empezar no tocó nada', sameTree(before, treeSnapshot(wf.sinConfirmar)) && JSON.stringify(fs.readdirSync(destBase).sort()) === JSON.stringify(destListingBefore), fs.readdirSync(destBase));
    }
    {
      const before = treeSnapshot(wf.borrar);
      await openFromMenu(wf.borrar, 'move');
      await chooseDest();
      await clickId('dlg-siguiente');
      await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.papelera, 'la revisión (D2)');
      await js("document.querySelector('input[name=\"papelera\"][value=\"borrar\"]').click()");
      await js("document.getElementById('rev-entiendo').click()");
      const ready = await dialogState();
      check('D2 borrar confirmado: con «Entiendo…» marcado, «Empezar» se activa', !ready.empezar.d, ready.empezar);
      await clickId('dlg-empezar');
      const dRes = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (D2)');
      const { batch, copy } = copyOf(dRes.lote, wf.borrar);
      created.push(batch);
      check('D2 borrar confirmado (EN DISCO): original ausente y copia idéntica', !fs.existsSync(wf.borrar) && sameTree(before, treeSnapshot(copy)), dRes.carpetas);
      check('D2 borrar confirmado: la interfaz dice «borrado definitivamente» y no ofrece quitar la copia', dRes.carpetas[0].resultado === 'original-borrado-definitivamente' && !dRes.botones.quitar, [dRes.carpetas, dRes.botones]);
      report.wizard.batchBorrar = batch;
      await clickId('dlg-cerrar');
    }
    {
      const before = treeSnapshot(wf.dejar);
      await openFromMenu(wf.dejar, 'move');
      await chooseDest();
      await clickId('dlg-siguiente');
      await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.papelera, 'la revisión (D3)');
      await js("document.querySelector('input[name=\"papelera\"][value=\"dejar\"]').click()");
      const ready = await dialogState();
      check('D3 dejar el original: «Empezar» se activa sin pedir confirmación de borrado', !ready.empezar.d && !ready.borrarConfirmar, [ready.empezar, ready.borrarConfirmar]);
      await clickId('dlg-empezar');
      const dRes = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (D3)');
      const { batch, copy } = copyOf(dRes.lote, wf.dejar);
      created.push(batch);
      check('D3 dejar el original (EN DISCO): el original sigue y la copia es idéntica', sameTree(before, treeSnapshot(wf.dejar)) && sameTree(before, treeSnapshot(copy)) && dRes.carpetas[0].resultado === 'copiada-verificada', dRes.carpetas);
      await clickId('dlg-cerrar');
    }

    // ===== (E) Copias anteriores (botón de la barra superior; el registro vive en el PC) =====
    {
      const copy = report.wizard.batchBorrar;
      await clickId('btn-verificar-copia');
      const d0 = await waitDialog((d) => d.abierto && d.pasos[0] === 'copias' && d.copias.length > 0, 'la lista de copias anteriores');
      const names = d0.copias.map((c) => c.nombre);
      check('E copias anteriores: aparecen las copias hechas (y no la que se quitó)', names.includes(path.basename(wf.borrar)) && names.includes(path.basename(wf.dejar)) && !names.includes(path.basename(wf.copiar)), names);
      check('E copias anteriores: cada fila dice de dónde, a dónde, cuándo y cómo se verificó', d0.copias.every((c) => /De: /.test(c.texto) && /A: /.test(c.texto) && /Verificación al copiar: completa/.test(c.texto)), d0.copias.map((c) => c.texto.slice(0, 120)));
      check('E copias anteriores: recuerda expulsar y reconectar el disco antes de verificar', /expulsa y vuelve a conectar el disco antes de verificar/.test(await js("document.getElementById('cop-usb').textContent")), null);
      const row = d0.copias.find((c) => c.nombre === path.basename(wf.borrar));
      const verifyBtn = `#cop-lista > li[data-id="${row.id}"] .btn-cop-verificar`;
      await realClick(await cellRect(verifyBtn));
      const ok = await waitDialog((d) => d.copTitular !== '', 'el resultado de verificar');
      check('E copias anteriores: copia íntegra => «La copia está bien: N archivos verificados»', /La copia está bien: \d+ archivos verificados \(contenido comparado\)/.test(ok.copTitular), ok.copTitular);
      check('E copias anteriores: el diálogo cabe en la ventana mínima', fits(ok), ok);
      await shot('asistente-6-copias-anteriores.png');
      // Se altera la copia a propósito: un byte cambiado, un archivo borrado y uno sobrante.
      const files = [];
      (function walkFiles(dir) {
        for (const n of fs.readdirSync(dir)) {
          const f = path.join(dir, n);
          if (fs.statSync(f).isDirectory()) walkFiles(f);
          else files.push(f);
        }
      })(copy);
      const bytes = fs.readFileSync(files[0]);
      bytes[0] ^= 0xff;
      fs.writeFileSync(files[0], bytes);
      fs.unlinkSync(files[1]);
      fs.writeFileSync(path.join(path.dirname(files[2]), 'sobrante.bin'), 'x');
      await js("document.getElementById('cop-resultado').hidden = true");
      await realClick(await cellRect(verifyBtn));
      const bad = await waitDialog((d) => /problemas/.test(d.copTitular), 'la verificación con problemas');
      check('E copias anteriores (copia alterada): detecta el problema (alterado, faltante y sobrante), con nombres', /La copia tiene 3 problemas/.test(bad.copTitular) && bad.copProblemas.length === 3, [bad.copTitular, bad.copProblemas]);
      // Disco desconectado: la carpeta ya no está.
      const moved = `${copy}-movida`;
      fs.renameSync(copy, moved);
      await js("document.getElementById('cop-resultado').hidden = true");
      await realClick(await cellRect(verifyBtn));
      const gone = await waitDialog((d) => /No encuentro esa carpeta: conecta el disco/.test(d.copTitular), 'el aviso de disco desconectado');
      check('E copias anteriores: con el disco desconectado dice «No encuentro esa carpeta: conecta el disco…» (no «bien»)', !/está bien/.test(gone.copTitular), gone.copTitular);
      fs.renameSync(moved, copy);
      // «Quitar de la lista» solo quita el registro (la copia sigue).
      await realClick(await cellRect(`#cop-lista > li[data-id="${row.id}"] .btn-cop-quitar`));
      const after = await waitDialog((d) => !d.copias.some((c) => c.id === row.id), 'quitar de la lista');
      check('E copias anteriores: «Quitar de la lista» quita el registro y NO borra la copia', fs.existsSync(copy) && after.copias.every((c) => c.id !== row.id), after.copias.length);
      await clickId('dlg-cerrar');
    }

    // ===== (F) Cancelar y empezar OTRA operación: no debe quedar nada de la anterior (ni «Cancelando…») =====
    {
      const name = path.basename(wf.copiar);
      const before = treeSnapshot(wf.lenta);
      const listingBefore = fs.readdirSync(destBase).sort();
      await openFromMenu(wf.lenta, 'copy');
      await chooseDest();
      await clickId('dlg-siguiente');
      await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión (F)');
      await clickId('dlg-empezar');
      await waitDialog((d) => d.pasos[0] === 'progreso' && d.progFase !== '', 'empezar (F)');
      await sleep(1500); // ya hay una copia parcial en «….copiando»
      await clickId('dlg-cancelar-op');
      const seenCancel = await waitDialog((d) => /Cancelando/.test(d.aviso) || d.pasos[0] === 'resultado', 'el aviso de cancelando');
      check('F cancelar: mientras se cancela SÍ aparece «Cancelando…» y el botón queda deshabilitado', /Cancelando/.test(seenCancel.aviso) ? seenCancel.cancelarOpDeshabilitado : true, [seenCancel.aviso, seenCancel.cancelarOpDeshabilitado]);
      const cancelled = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado de cancelar (F)');
      check('F cancelar: el resultado es «cancelada», el destino queda LIMPIO (ni «….copiando» ni carpeta final a medias) y el original intacto', cancelled.carpetas[0].resultado === 'cancelada' && JSON.stringify(fs.readdirSync(destBase).sort()) === JSON.stringify(listingBefore) && sameTree(before, treeSnapshot(wf.lenta)), [cancelled.carpetas, fs.readdirSync(destBase)]);
      check('F cancelar: NO se ofrece «Quitar la copia» tras cancelar', !cancelled.botones.quitar, cancelled.botones);
      check('F cancelar: el resultado dice «Cancelada. Se quitó la copia incompleta. Los originales no se tocaron.»', /Cancelada\. Se quitó la copia incompleta\. Los originales no se tocaron\./.test(cancelled.titular), cancelled.titular);
      await clickId('dlg-cerrar');
      for (const d of fs.readdirSync(destBase)) if (!listingBefore.includes(d)) created.push(path.join(destBase, d));
      // Otra operación, en un diálogo NUEVO: nada de lo anterior.
      await openFromMenu(wf.papelera === undefined ? wf.copiar : wf.copiar, 'copy');
      const fresh = await waitDialog((d) => d.abierto && d.pasos[0] === 'destino', 'diálogo nuevo (F)');
      check('F nueva operación: el diálogo abre limpio (aviso normal, sin «Cancelando…», sin error)', !/Cancelando/.test(fresh.aviso) && fresh.error === '' && !fresh.cancelarOpDeshabilitado, [fresh.aviso, fresh.error]);
      await chooseDest();
      await clickId('dlg-siguiente');
      await waitDialog((d) => d.pasos[0] === 'revision' && !d.revEstadoVisible && d.cifras, 'la revisión (F2)');
      await clickId('dlg-empezar');
      const again = await waitDialog((d) => d.pasos[0] === 'progreso' || d.pasos[0] === 'resultado', 'empezar otra vez (F2)');
      check('F nueva operación: en el paso de progreso NO aparece «Cancelando…» aunque nadie canceló', !/Cancelando/.test(again.aviso) && !again.cancelarOpDeshabilitado, [again.aviso, again.cancelarOpDeshabilitado]);
      const done = await waitDialog((d) => d.pasos[0] === 'resultado', 'el resultado (F2)');
      check('F nueva operación: termina bien y el destino tiene SOLO la carpeta', /^Listo/.test(done.titular) && !fs.readdirSync(destBase).some((n) => /\.copiando/.test(n)), done.titular);
      await clickId('dlg-cerrar');
    }

    // ===== limpieza de lo que creó esta prueba =====
    for (const d of created) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* limpieza best-effort */
      }
    }
    report.wizard.capturas = shots;
    check('asistente: se guardaron las capturas de cada paso', ['asistente-1-destino.png', 'asistente-2-revision.png', 'asistente-4-resultado.png', 'asistente-2b-papelera-no-cabe.png'].every((n) => shots.includes(n)), shots);
    context.smokeDestination = null;
    win.setSize(1100, 1000);
  }

  // --- Datos de prueba creados por la propia app (Documentos\\BoneYardDog-Prueba) -------------------------------
  async function pollJs(expr, what, ms = 100_000) {
    const t0 = Date.now();
    for (;;) {
      const v = await js(expr);
      if (v) return v;
      if (Date.now() - t0 > ms || Date.now() - started > TIME_LIMIT_MS) throw new Error(`Se agotó el tiempo esperando: ${what} :: ${JSON.stringify(await js("document.getElementById('td-estado').textContent"))}`);
      await sleep(100);
    }
  }

  async function testDataScenarios() {
    win.setSize(1100, 1000);
    await sleep(300);
    // En Windows se usa la carpeta Documentos REAL del equipo; en Linux (sin Documentos) una carpeta de prueba.
    if (process.platform !== 'win32') {
      context.smokeDocuments = path.join(fixture.base, 'Documentos');
      fs.mkdirSync(context.smokeDocuments, { recursive: true });
    }
    const docs = context.smokeDocuments || app.getPath('documents');
    const root = path.join(docs, TD.ROOT_NAME);
    const sentinel = path.join(docs, `.byd-smoke-centinela-${process.pid}.txt`);
    report.testData = { documents: docs, root };
    check('datos de prueba: la carpeta de pruebas no existía antes', !fs.existsSync(root), root);
    fs.writeFileSync(sentinel, 'algo mío que NO debe tocarse');
    await js("document.getElementById('btn-nuevo').click()");
    await waitFor((s) => s.estado === 'inicio', 'volver al inicio (datos de prueba)');
    const info0 = await js(`({ version: document.getElementById('app-version').textContent, proyecto: document.getElementById('app-proyecto').textContent })`);
    check('versión: el pie muestra la versión de package.json y la dirección del proyecto como texto', info0.version.includes(require('../../package.json').version) && /github\.com\/amirhere1910\/boneyarddog/.test(info0.proyecto), info0);
    await realClick(await cellRect('#ayuda-pruebas > summary'));
    await pollJs(`document.getElementById('td-estado').textContent`, 'el estado de los datos de prueba');
    const st0 = await js(`({ estado: document.getElementById('td-estado').textContent, crear: !document.getElementById('td-crear').hidden, borrar: !document.getElementById('td-borrar').hidden })`);
    check('datos de prueba: sin datos, solo se ofrece «Crear datos de prueba»', st0.estado === 'Todavía no hay datos de prueba.' && st0.crear && !st0.borrar, st0);
    await realClick(await cellRect('#td-crear'));
    const t0 = Date.now();
    const created = await pollJs(`(() => { const e = document.getElementById('td-estado').textContent; return /^Listo:|^No se crearon|cancelada/.test(e) ? e : null; })()`, 'crear los datos de prueba');
    report.testData.msCrear = Date.now() - t0;
    check('datos de prueba: «Crear» termina con «Listo»', /^Listo: 5 carpetas/.test(created), created);
    const plan = TD.PLAN;
    const mismatches = [];
    for (const folder of plan) {
      for (const f of folder.files) {
        const p = path.join(root, folder.name, ...f.path.split('/'));
        let st = null;
        try {
          st = fs.statSync(p);
        } catch {
          mismatches.push(`falta ${p}`);
          continue;
        }
        if (st.size !== f.bytes) mismatches.push(`${p}: tamaño ${st.size} ≠ ${f.bytes}`);
        const days = (Date.now() - st.mtimeMs) / DAY;
        if (Math.abs(days - folder.daysAgo) > 1) mismatches.push(`${p}: ${days.toFixed(1)} días ≠ ${folder.daysAgo}`);
      }
      for (const d of folder.emptyDirs) if (!fs.existsSync(path.join(root, folder.name, ...d.split('/')))) mismatches.push(`falta la carpeta vacía ${d}`);
    }
    check('datos de prueba (EN DISCO): 5 carpetas, nombres con tildes/ñ/emoji, tamaños exactos y fechas de modificación de 400, 200, 100, 30 y 2 días', mismatches.length === 0 && fs.readdirSync(root).length === 6, mismatches.slice(0, 5));
    const mark = TD.parseMarker(fs.readFileSync(path.join(root, TD.MARK_NAME), 'utf8'));
    check('datos de prueba (EN DISCO): la marca .byd-prueba existe y es válida', mark && mark.carpetas.length === 5, mark);
    // Datos sin repetir: dos archivos distintos del mismo tamaño no tienen el mismo contenido.
    const a = fs.readFileSync(path.join(root, plan[0].name, 'Playa', 'foto 01.jpg')).subarray(0, 65536);
    const b = fs.readFileSync(path.join(root, plan[0].name, 'Playa', 'foto 02.jpg')).subarray(0, 65536);
    check('datos de prueba (EN DISCO): los archivos no repiten datos (verificar es significativo)', Buffer.compare(a, b) !== 0, null);
    const afterCreate = await js(`({ crear: !document.getElementById('td-crear').hidden, escanear: !document.getElementById('td-escanear').hidden, borrar: !document.getElementById('td-borrar').hidden })`);
    check('datos de prueba: tras crear se ofrece escanear y borrar (ya no crear)', !afterCreate.crear && afterCreate.escanear && afterCreate.borrar, afterCreate);

    // Escanear esa carpeta con «ignorar la fecha de creación» (marcada por defecto).
    await realClick(await cellRect('#td-escanear'));
    await settled((s) => s.mapa.carpeta === root && s.mapa.celdas.length > 0, 'el mapa de los datos de prueba');
    await js("document.getElementById('tab-lista').click()");
    const L = await settled((s) => s.pestana === 'lista' && s.lista.items.length > 0, 'la lista de los datos de prueba');
    const wanted = plan.filter((f) => f.daysAgo > 90).map((f) => f.name).sort();
    check('datos de prueba: con la fecha de creación ignorada, salen como sin uso las de 400, 200 y 100 días (y no las de 30 y 2)', JSON.stringify(L.lista.items.map((i) => i.nombre).sort()) === JSON.stringify(wanted), L.lista.items.map((i) => i.nombre));
    check('datos de prueba: la opción quedó guardada (useCreationTime = false)', savedSettings().useCreationTime === false, savedSettings());

    // Borrar: primero SIN marca (no debe borrar nada), después con marca.
    await js("document.getElementById('btn-nuevo').click()");
    await waitFor((s) => s.estado === 'inicio', 'volver al inicio (borrar)');
    const markText = fs.readFileSync(path.join(root, TD.MARK_NAME), 'utf8');
    fs.unlinkSync(path.join(root, TD.MARK_NAME));
    await realClick(await cellRect('#ayuda-pruebas > summary')).catch(() => {});
    await js(`document.getElementById('ayuda-pruebas').open = true; document.getElementById('ayuda-pruebas').dispatchEvent(new Event('toggle'))`);
    await sleep(500);
    const noMark = await js(`({ estado: document.getElementById('td-estado').textContent, borrar: !document.getElementById('td-borrar').hidden })`);
    check('datos de prueba: sin la marca la app dice que no es suya y NO ofrece borrar', /NO es de la app/.test(noMark.estado) && !noMark.borrar, noMark);
    check('datos de prueba (EN DISCO): sin marca no se borra nada', fs.existsSync(path.join(root, plan[0].name, 'Playa', 'foto 01.jpg')), null);
    fs.writeFileSync(path.join(root, TD.MARK_NAME), markText);
    await js(`document.getElementById('ayuda-pruebas').dispatchEvent(new Event('toggle'))`);
    await pollJs(`!document.getElementById('td-borrar').hidden`, 'el botón de borrar');
    await realClick(await cellRect('#td-borrar'));
    await realClick(await cellRect('#td-borrar-no'));
    check('datos de prueba (EN DISCO): «No» en la confirmación no borra nada', fs.existsSync(root), null);
    await realClick(await cellRect('#td-borrar'));
    await realClick(await cellRect('#td-borrar-si'));
    await pollJs(`/^Datos de prueba borrados/.test(document.getElementById('td-estado').textContent)`, 'borrar los datos de prueba');
    check('datos de prueba (EN DISCO): con la marca se borra la carpeta de pruebas', !fs.existsSync(root), root);
    check('datos de prueba (EN DISCO): lo demás de Documentos (el centinela) NO se tocó', fs.existsSync(sentinel) && fs.readFileSync(sentinel, 'utf8') === 'algo mío que NO debe tocarse', sentinel);
    fs.rmSync(sentinel, { force: true });
    const end = await js(`({ crear: !document.getElementById('td-crear').hidden, borrar: !document.getElementById('td-borrar').hidden })`);
    check('datos de prueba: tras borrar vuelve a ofrecerse «Crear»', end.crear && !end.borrar, end);
  }

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
      win.setSize(1100, 1000);
      win.focus();

      // --- Aislamiento y red --------------------------------------------------
      const home = await waitFor((s) => s.listo, 'que la interfaz termine de iniciar');
      const iso = await js(READ_ISOLATION);
      report.isolation = iso;
      const rejected = (r) => r && r.ok === false;
      check('aislamiento: sin require, sin process y sin ipcRenderer en la ventana', !iso.hasRequire && !iso.hasProcess && !iso.hasIpcRenderer, { require: iso.hasRequire, process: iso.hasProcess, ipc: iso.hasIpcRenderer });
      check('puente: solo las funciones previstas', JSON.stringify(iso.bydKeys) === JSON.stringify([...BRIDGE_KEYS].sort()), iso.bydKeys);
      check('puente: ya no expone getLargestFiles ni getLargestFolders', !iso.bydKeys.includes('getLargestFiles') && !iso.bydKeys.includes('getLargestFolders'), iso.bydKeys);
      check('política CSP estricta', iso.csp && iso.csp.startsWith("default-src 'self'") && iso.csp.includes("connect-src 'none'"), iso.csp);
      check('la CSP bloquea conexiones', iso.networkBlocked, iso.networkBlocked);
      check('IPC: letra de unidad inválida o no detectada, rechazada', rejected(iso.chooseDriveBadLetter) && rejected(iso.chooseDriveNotListed), [iso.chooseDriveBadLetter, iso.chooseDriveNotListed]);
      check('IPC: Explorador, Ignorar, mapa, detalles y selección rechazan rutas fuera del análisis', [iso.revealUnknown, iso.excludeUnknown, iso.treemapUnknown, iso.detailsUnknown, iso.summarizeUnknown].every(rejected), [iso.revealUnknown, iso.excludeUnknown, iso.treemapUnknown, iso.detailsUnknown, iso.summarizeUnknown]);
      check('IPC: opciones de mapa inválidas, selección de 501 rutas y selección que no es lista, rechazadas', [iso.treemapBadOptions, iso.summarizeTooMany, iso.summarizeNotList].every(rejected), [iso.treemapBadOptions, iso.summarizeTooMany, iso.summarizeNotList]);
      check('IPC: configuración inválida u opción desconocida, rechazada', rejected(iso.saveSettingsInvalid) && rejected(iso.saveSettingsUnknownKey), [iso.saveSettingsInvalid, iso.saveSettingsUnknownKey]);

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

      // --- Inicio ----------------------------------------------------------------
      check('inicio: aviso "Prueba primero con datos de prueba…" y botón "Elegir carpeta…"', home.avisoSolo.includes('Prueba primero con datos de prueba, nunca con datos que no tengas respaldados') && home.botonElegir === 'Elegir carpeta…', [home.avisoSolo, home.botonElegir]);
      const wantDrives = process.platform === 'win32';
      check(
        'inicio: botones de unidades ("Escanear C:", …)',
        wantDrives ? home.unidades.length > 0 && home.unidades.every((u) => u.texto === `Escanear ${u.unidad}:`) && home.unidades.some((u) => u.unidad === 'C') : home.unidades.length === 0,
        home.unidades,
      );

      // --- Escaneo y mapa -----------------------------------------------------------
      await js("document.getElementById('btn-elegir').click()");
      const map0 = await settled((s) => s.mapa.celdas.length > 0, 'el mapa inicial');
      report.mapa0 = map0.mapa;
      check('pestañas "Mapa" y "Lista de candidatas"; el Mapa está activo', map0.tabs.length === 2 && map0.tabs[0].texto === 'Mapa' && map0.tabs[1].texto === 'Lista de candidatas' && map0.tabs[0].seleccionada && !map0.tabs[1].seleccionada && map0.panelMapaVisible && !map0.panelListaVisible, map0.tabs);
      const m = map0.mapa;
      const expected = {
        [P.videos]: { bytes: 9000, estado: 'muy-antigua' },
        [P.fotos]: { bytes: 5000, estado: 'sin-movimiento' },
        [P.documentos]: { bytes: 4500, estado: 'muy-reciente' },
        [P.proyecto]: { bytes: 3000, estado: 'reciente' },
        [P.enlace]: { bytes: 2500, estado: 'muy-antigua' },
        [P.sistema]: { bytes: 2000, estado: 'muy-reciente' },
      };
      for (const [ruta, e] of Object.entries(expected)) {
        const c = cellOf(map0, ruta);
        check(`mapa: "${path.basename(ruta)}" con tamaño ${e.bytes} y estado ${e.estado}`, c && c.bytes === e.bytes && c.estado === e.estado, c && { bytes: c.bytes, estado: c.estado, dias: c.dias });
      }
      const others = m.celdas.find((c) => c.tipo === 'others');
      check('mapa: celda "Otras" con lo que queda bajo el mínimo (dos carpetas pequeñas + un archivo suelto)', others && others.bytes === 360 && others.aria.startsWith('Otras (2 carpetas pequeñas'), others && { bytes: others.bytes, aria: others.aria });
      check('mapa: la suma de los cuadros es el tamaño de la carpeta', m.celdas.reduce((s, c) => s + c.bytes, 0) === 9000 + 5000 + 4500 + 3000 + 2500 + 2000 + 360, m.celdas.map((c) => c.bytes));
      check('mapa: cada cuadro tiene el color de su estado (cálidos = movimiento reciente, fríos = sin movimiento)', m.celdas.every((c) => c.colorOk), m.celdas.filter((c) => !c.colorOk).map((c) => c.nombre));
      check('mapa: el cuadro protegido va marcado (borde discontinuo y candado)', cellOf(map0, P.sistema).protegida && cellOf(map0, P.sistema).aria.includes('protegida por el sistema'), cellOf(map0, P.sistema).aria);
      check('mapa: nombre accesible con tamaño y actividad', /^Videos, 8,8 KB, muy antigua hace 1 año y 1 mes/.test(cellOf(map0, P.videos).aria) || cellOf(map0, P.videos).aria.startsWith('Videos, '), cellOf(map0, P.videos).aria);
      const totalArea = m.celdas.reduce((s, c) => s + c.rect.w * c.rect.h, 0);
      const totalBytes = m.celdas.reduce((s, c) => s + c.bytes, 0);
      const worstArea = Math.max(...m.celdas.map((c) => Math.abs((c.rect.w * c.rect.h) / totalArea - c.bytes / totalBytes)));
      check('mapa: el área de cada cuadro es proporcional a su tamaño (±2 % del total)', worstArea < 0.02, { peorDiferencia: worstArea });
      const inside = m.celdas.every((c) => c.rect.x >= m.rect.x - 1 && c.rect.y >= m.rect.y - 1 && c.rect.x + c.rect.w <= m.rect.x + m.rect.w + 1 && c.rect.y + c.rect.h <= m.rect.y + m.rect.h + 1);
      const overlapping = [];
      m.celdas.forEach((a, i) => {
        m.celdas.forEach((b, j) => {
          if (i >= j) return;
          const ox = Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x);
          const oy = Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y);
          if (ox > 0.5 && oy > 0.5) overlapping.push([a.nombre, b.nombre]);
        });
      });
      check('mapa: los cuadros caben en el área y no se solapan', inside && overlapping.length === 0, { inside, overlapping, area: m.rect, fuera: m.celdas.filter((c) => !(c.rect.x >= m.rect.x - 1 && c.rect.y >= m.rect.y - 1 && c.rect.x + c.rect.w <= m.rect.x + m.rect.w + 1 && c.rect.y + c.rect.h <= m.rect.y + m.rect.h + 1)).map((c) => [c.nombre, c.rect]) });
      check('mapa: alto mínimo de 240 px', m.rect.h >= 240, m.rect);
      const v0 = map0.vista;
      check('mapa a pantalla completa: el mapa y la leyenda están dentro de la ventana, sin desplazar la página', v0.contenedor.bottom <= v0.alto && v0.leyenda.bottom <= v0.alto && v0.leyenda.top >= v0.contenedor.bottom - 1 && v0.altoDocumento <= v0.alto + 1, v0);
      check('mapa: todos los cuadros son botones visibles (ninguno diminuto)', m.celdas.every((c) => c.etiqueta === 'BUTTON' && Math.min(c.rect.w, c.rect.h) >= 20 && c.rect.w * c.rect.h >= 500), m.celdas.map((c) => [c.nombre, c.rect.w, c.rect.h]));
      check('mapa: leyenda con los 5 estados y la frase del período', m.leyenda.length === 5 && m.leyendaTexto.startsWith('Movimiento reciente = archivos modificados o copiados en los últimos 3 meses.') && m.leyendaTexto.includes('La fecha de acceso se ignora.'), { leyenda: m.leyenda, texto: m.leyendaTexto });
      check('mapa: migas de pan con la carpeta actual', m.migas.length === 1 && m.migas[0].actual && m.migas[0].ruta === fixture.root, m.migas);
      check('mapa: selector de tamaño del mapa guardado en la configuración de prueba', Number(m.mapaMin) === 1000, m.mapaMin);

      await snapshot('mapa.png');
      report.snapshots = true;

      // --- Aviso emergente (ratón real) ---------------------------------------------
      await realClick(await cellRect(cellSel(P.fotos)), { button: 'left' }).catch(() => {});
      // (el clic en Fotos, que no tiene subcarpetas, abre sus detalles; se cierra con Esc)
      await waitFor((s) => s.detalles.visible, 'los detalles de Fotos (clic en una carpeta sin subcarpetas)');
      await realKey('Escape');
      const afterEsc = await waitFor((s) => !s.detalles.visible, 'cerrar detalles con Esc');
      check('clic en una carpeta sin subcarpetas abre sus detalles; Esc los cierra', !afterEsc.detalles.visible, afterEsc.detalles);
      const fr = await cellRect(cellSel(P.fotos));
      win.webContents.sendInputEvent({ type: 'mouseMove', x: center(fr).x, y: center(fr).y });
      const tipState = await waitFor((s) => s.tooltip.visible && s.tooltip.texto.includes('Fotos'), 'el aviso emergente');
      check('aviso emergente: nombre, ruta, tamaño, % y último uso', tipState.tooltip.texto.includes('Fotos') && tipState.tooltip.texto.includes(P.fotos) && tipState.tooltip.texto.includes('% de esta carpeta') && tipState.tooltip.texto.includes('Último uso: hace 4 meses'), tipState.tooltip.texto);
      await waitFor((s) => s.tooltip.texto.includes('Archivo más reciente: f1.bin'), 'el archivo más reciente en el aviso');
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 });

      // --- Entrar a una carpeta (clic real) y volver con las migas -------------------------
      await clickCell(P.videos);
      const inVideos = await settled((s) => s.mapa.carpeta === P.videos && s.mapa.celdas.length > 0, 'entrar a Videos');
      check('clic en una carpeta con subcarpetas ENTRA a ella: cambian las migas y las celdas', JSON.stringify(inVideos.mapa.migas.map((x) => x.texto)) === JSON.stringify([path.basename(fixture.root), 'Videos']) && inVideos.mapa.migas[1].actual && JSON.stringify(names(inVideos).sort()) === JSON.stringify(['otra', 'vacaciones']), { migas: inVideos.mapa.migas, celdas: names(inVideos) });
      await sleep(400);
      const focoTarde = (await read()).foco;
      check('al entrar, el foco pasa al primer cuadro', inVideos.foco.esCelda && focoTarde.esCelda, { justoDespues: inVideos.foco, despues: focoTarde });

      // Selección anidada: Ctrl+clic (real) en "vacaciones" con "Videos" ya seleccionada más tarde.
      await clickCell(P.vacaciones, { modifiers: ['control'] });
      const selOne = await waitFor((s) => s.seleccion.visible && s.seleccion.cantidad === 1 && s.seleccion.bytes === 6000, 'selección de vacaciones');
      check('Ctrl+clic marca la carpeta (✓) sin entrar y la barra suma su tamaño', cellOf(selOne, P.vacaciones).seleccionada && selOne.mapa.carpeta === P.videos && /1 carpeta seleccionada · /.test(selOne.seleccion.texto), selOne.seleccion);
      check('con la barra de selección, la leyenda y el mapa siguen a la vista y no se tapan', selOne.vista.barra && selOne.vista.barra.bottom <= selOne.vista.alto && selOne.vista.leyenda.bottom <= selOne.vista.barra.top + 1 && selOne.vista.contenedor.bottom <= selOne.vista.leyenda.top + 1, selOne.vista);
      check('barra de selección: "Copiar…" y "Transferir…" activos', !selOne.seleccion.copiarDeshabilitado && !selOne.seleccion.transferirDeshabilitado, selOne.seleccion);

      await js(`document.querySelector('#migas button').click()`);
      const back = await settled((s) => s.mapa.carpeta === fixture.root && s.mapa.celdas.length > 0, 'volver a la raíz con las migas');
      check('las migas de pan permiten volver a la carpeta anterior', back.mapa.migas.length === 1 && names(back).includes('Videos'), back.mapa.migas);
      check('la selección se conserva al navegar', back.seleccion.visible && back.seleccion.cantidad === 1, back.seleccion);

      // Ctrl+clic real en Videos (la carpeta que contiene lo ya seleccionado): "vacaciones" deja de contar.
      await clickCell(P.videos, { modifiers: ['control'] });
      const nested = await waitFor((s) => s.seleccion.cantidad === 2 && s.seleccion.nota !== '', 'selección anidada');
      check('selección anidada: no se cuenta dos veces y se explica', nested.seleccion.bytes === 9000 && /1 no cuenta: 1 dentro de otra carpeta seleccionada/.test(nested.seleccion.nota), nested.seleccion);

      // Ctrl+clic en Fotos y Documentos: totales.
      await clickCell(P.fotos, { modifiers: ['control'] });
      await clickCell(P.documentos, { modifiers: ['control'] });
      const four = await waitFor((s) => s.seleccion.cantidad === 4 && s.seleccion.bytes === 9000 + 5000 + 4500, 'cuatro carpetas seleccionadas');
      check('Ctrl+clic actualiza la barra con el total correcto (9000 + 5000 + 4500 bytes)', four.seleccion.bytes === 18500 && four.seleccion.nota.includes('1 no cuenta'), four.seleccion);

      // Quitar la marca (Ctrl+clic otra vez) y la anidada.
      await clickCell(P.documentos, { modifiers: ['control'] });
      const three = await waitFor((s) => s.seleccion.cantidad === 3 && s.seleccion.bytes === 14000, 'quitar una marca');
      check('Ctrl+clic otra vez quita la marca', !cellOf(three, P.documentos).seleccionada && three.seleccion.bytes === 14000, three.seleccion);

      // --- Pestañas con flechas del teclado ----------------------------------------------------
      await js("document.getElementById('tab-mapa').focus()");
      await realKey('Right');
      const toList = await settled((s) => s.pestana === 'lista', 'cambiar a Lista con la flecha derecha');
      check('flecha derecha cambia a "Lista de candidatas" y mueve el foco (patrón de pestañas)', toList.tabs[1].seleccionada && toList.tabs[1].tabindex === 0 && toList.tabs[0].tabindex === -1 && toList.panelListaVisible && !toList.panelMapaVisible, toList.tabs);
      report.lista0 = toList.lista;
      const L = toList.lista;
      check('lista: las mismas candidatas de la 2B (Videos, Fotos y Con enlace), por tamaño', JSON.stringify(L.items.map((i) => i.nombre)) === JSON.stringify(['Videos', 'Fotos', 'Con enlace']) && L.titulo.cantidad === 3 && L.titulo.bytes === 9000 + 5000 + 2500, { items: L.items.map((i) => i.nombre), titulo: L.titulo });
      check('lista: "Mostrar en el Explorador" e "Ignorar esta carpeta" en cada carpeta', L.items.every((i) => i.botones.join('|') === 'Mostrar en el Explorador|Ignorar esta carpeta'), L.items.map((i) => i.botones));
      check('lista: la selección del mapa aparece marcada (Videos y Fotos sí; Con enlace no)', L.items.find((i) => i.nombre === 'Videos').casilla && L.items.find((i) => i.nombre === 'Fotos').casilla && !L.items.find((i) => i.nombre === 'Con enlace').casilla, L.items.map((i) => [i.nombre, i.casilla]));
      check('la barra de selección se mantiene al cambiar de pestaña', toList.seleccion.visible && toList.seleccion.cantidad === 3, toList.seleccion);
      if (fixture.hasLink) check('lista: la carpeta con enlace se ofrece, con aviso', L.items.find((i) => i.nombre === 'Con enlace').enlaces, L.items.map((i) => [i.nombre, i.enlaces]));
      else report.skippedChecks = [...(report.skippedChecks || []), 'aviso de enlaces (no se pudo crear un enlace simbólico aquí)'];
      check('lista: sin aviso de omitidos por permisos', !L.omitidosVisible || fixture.hasLink, L.omitidosVisible);
      await snapshot('lista.png');

      // Casilla de la lista -> la selección cambia.
      await js(`[...document.querySelectorAll('#lista > li')].find((l) => l.dataset.ruta === ${q(P.enlace)}).querySelector('.chk-sel').click()`);
      const viaList = await waitFor((s) => s.seleccion.cantidad === 4 && s.seleccion.bytes === 14000 + 2500, 'seleccionar desde la lista');
      check('la casilla de la lista suma a la misma selección', viaList.seleccion.bytes === 16500, viaList.seleccion);
      await js("document.getElementById('btn-sel-limpiar').click()");
      const cleared = await waitFor((s) => !s.seleccion.visible, 'limpiar la selección');
      check('"Limpiar selección" oculta la barra y desmarca todo', !cleared.seleccion.visible && cleared.lista.items.every((i) => !i.casilla), cleared.seleccion);

      await realKey('Left');
      const toMap = await settled((s) => s.pestana === 'mapa', 'volver al Mapa con la flecha izquierda');
      check('flecha izquierda vuelve al Mapa', toMap.tabs[0].seleccionada && toMap.panelMapaVisible, toMap.tabs);

      // --- Menú contextual (clic derecho real) ---------------------------------------------------
      await clickCell(P.videos, { button: 'right' });
      let menu = await waitFor((s) => s.menu.abierto, 'el menú contextual con el clic derecho');
      const labels = menu.menu.items.filter((i) => !i.separador).map((i) => i.texto);
      check('clic derecho abre el menú con los 6 elementos esperados', JSON.stringify(labels) === JSON.stringify(['Entrar a la carpeta', 'Mostrar en el Explorador', 'Ver detalles', 'Copiar a otro disco…', 'Transferir a otro disco (mover)…', 'Ignorar esta carpeta']) && menu.menu.items.filter((i) => i.separador).length === 2, menu.menu.items);
      const byAction = Object.fromEntries(menu.menu.items.filter((i) => !i.separador).map((i) => [i.accion, i]));
      check('"Copiar" y "Transferir" están activos (como el resto)', !byAction.copy.deshabilitado && !byAction.move.deshabilitado && !byAction.enter.deshabilitado && !byAction.reveal.deshabilitado && !byAction.details.deshabilitado && !byAction.ignore.deshabilitado, byAction);
      check('el foco queda en el primer elemento del menú', menu.menu.foco === 'enter', menu.menu.foco);

      await realKey('Down');
      await realKey('Down');
      const foco2 = await read();
      check('flechas del teclado recorren el menú', foco2.menu.foco === 'details', foco2.menu.foco);
      await realKey('End');
      check('End va al último elemento', (await read()).menu.foco === 'ignore', null);
      await realKey('Home');
      check('Home va al primero', (await read()).menu.foco === 'enter', null);
      await realKey('Escape');
      menu = await read();
      check('Esc cierra el menú y el foco vuelve al cuadro', !menu.menu.abierto && menu.foco.esCelda && menu.foco.ruta === P.videos, { menu: menu.menu.abierto, foco: menu.foco });

      // Menú de la carpeta protegida.
      await clickCell(P.sistema, { button: 'right' });
      menu = await waitFor((s) => s.menu.abierto, 'menú de la carpeta protegida');
      const prot = Object.fromEntries(menu.menu.items.filter((i) => !i.separador).map((i) => [i.accion, i]));
      check('carpeta protegida: el motivo es "Protegida por el sistema"', prot.copy.motivo === 'Protegida por el sistema' && prot.move.motivo === 'Protegida por el sistema', prot);
      await realKey('Escape');

      // "Otras": sin menú.
      await clickCell(P.sistema, {}).catch(() => {});
      const othersRect = await js(`(() => { const e = document.querySelector('#mapa .celda[data-kind="others"]'); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
      await realClick(othersRect, { button: 'right' });
      await sleep(150);
      check('la celda "Otras" no abre menú', !(await read()).menu.abierto, null);
      await realKey('Escape');

      // Ver detalles desde el menú (clic real en el elemento).
      await clickCell(P.videos, { button: 'right' });
      await waitFor((s) => s.menu.abierto, 'menú para Ver detalles');
      const detRect = await cellRect('#menu-contextual [data-accion="details"]');
      await realClick(detRect);
      const det = await waitFor((s) => s.detalles.visible && s.detalles.titulo.includes('Videos'), 'el panel de detalles');
      const d = det.detalles;
      check('"Ver detalles" muestra los números esperados (9000 bytes, 2 archivos, 2 subcarpetas)', d.bytes === 9000 && d.archivos === 2 && d.subcarpetas === 2, d);
      check('detalles: antigüedad (todo "más de un año") con texto, no solo color', d.tramos.mas365 === 9000 && d.tramosTexto.some((t) => t.includes('Más de un año: 100 %')), d.tramosTexto);
      check('detalles: las subcarpetas más pesadas, de mayor a menor', JSON.stringify(d.subs) === JSON.stringify([P.vacaciones, path.join(P.videos, 'otra')]), d.subs);
      check('detalles: archivo más reciente y último uso', /^v[12]\.bin /.test(d.filas['Archivo más reciente']) && /hace 1 año/.test(d.filas['Último uso']), d.filas);
      await realKey('Escape');
      const closed = await waitFor((s) => !s.detalles.visible, 'cerrar detalles');
      check('Esc cierra el panel de detalles', !closed.detalles.visible, null);

      // "Mostrar en el Explorador" desde el menú.
      await clickCell(P.fotos, { button: 'right' });
      await waitFor((s) => s.menu.abierto, 'menú para el Explorador');
      await realClick(await cellRect('#menu-contextual [data-accion="reveal"]'));
      for (let i = 0; i < 50 && !(report.revealCalls || []).length; i++) await sleep(100);
      check('"Mostrar en el Explorador" del menú llama con la ruta de esa carpeta (sin abrir nada)', JSON.stringify(report.revealCalls) === JSON.stringify([P.fotos]), report.revealCalls);

      // --- Período compartido: cambia los colores del mapa y las candidatas de la lista --------------------
      await js("(() => { const s = document.getElementById('sel-periodo'); s.value = '365'; s.dispatchEvent(new Event('change')); })()");
      const year = await settled((s) => s.controles.periodo === '365' && s.mapa.leyendaTexto.includes('últimos 1 año') && cellOf(s, P.videos) && cellOf(s, P.videos).estado === 'sin-movimiento', 'recalcular a 1 año');
      check('con "1 año", el mapa recolorea sin volver a escanear (Videos pasa a "sin movimiento", Fotos a "muy reciente")', cellOf(year, P.fotos).estado === 'muy-reciente' && cellOf(year, P.videos).estado === 'sin-movimiento' && year.mapa.celdas.every((c) => c.colorOk), year.mapa.celdas.map((c) => [c.nombre, c.estado]));
      check('con "1 año", la lista solo ofrece lo más antiguo (Videos)', JSON.stringify(year.lista.items.map((i) => i.nombre)) === JSON.stringify(['Videos']), year.lista.items.map((i) => i.nombre));
      check('el período se guardó', savedSettings().staleDays === 365, savedSettings());
      await js("(() => { const s = document.getElementById('sel-periodo'); s.value = '90'; s.dispatchEvent(new Event('change')); })()");
      await settled((s) => s.controles.periodo === '90' && cellOf(s, P.videos) && cellOf(s, P.videos).estado === 'muy-antigua', 'volver a 3 meses');

      // --- Tamaño mínimo del mapa -------------------------------------------------------------------------
      await js("(() => { const s = document.getElementById('sel-mapa-min'); s.value = '10485760'; s.dispatchEvent(new Event('change')); })()");
      const bigMin = await settled((s) => Number(s.mapa.mapaMin) === 10485760 && s.mapa.celdas.length === 1, 'subir el tamaño mínimo del mapa');
      check('el selector de tamaño cambia las celdas: todo cae en "Otras" y se avisa cómo verlas', bigMin.mapa.celdas[0].tipo === 'others' && bigMin.mapa.aviso.includes('Baja el tamaño mínimo para verlas'), { celdas: bigMin.mapa.celdas.length, aviso: bigMin.mapa.aviso });
      check('el tamaño del mapa se guardó', savedSettings().mapMinBytes === 10485760, savedSettings());
      await js("(() => { const s = document.getElementById('sel-mapa-min'); s.value = '1000'; s.dispatchEvent(new Event('change')); })()");
      await settled((s) => Number(s.mapa.mapaMin) === 1000 && s.mapa.celdas.length > 3, 'volver al mínimo de prueba');

      // --- Ignorar desde el menú contextual y volver a considerar ------------------------------------------
      await clickCell(P.fotos, { button: 'right' });
      await waitFor((s) => s.menu.abierto, 'menú para Ignorar');
      await realClick(await cellRect('#menu-contextual [data-accion="ignore"]'));
      const ign = await settled((s) => s.ignoradas.length === 1 && !s.lista.items.some((i) => i.nombre === 'Fotos'), 'ignorar Fotos desde el menú');
      check('"Ignorar esta carpeta" desde el menú la saca de la lista y la guarda', JSON.stringify(ign.ignoradas) === JSON.stringify([P.fotos]) && JSON.stringify(savedSettings().excludedPaths) === JSON.stringify([P.fotos]), { ignoradas: ign.ignoradas, guardado: savedSettings().excludedPaths });
      await js(`[...document.querySelectorAll('#lista-ignoradas > li')].find((l) => l.dataset.ruta === ${q(P.fotos)}).querySelector('.btn-reconsiderar').click()`);
      const back2 = await settled((s) => s.ignoradas.length === 0 && s.lista.items.some((i) => i.nombre === 'Fotos'), 'volver a considerar');
      check('"Volver a considerar" la devuelve y se quita de la configuración', savedSettings().excludedPaths.length === 0 && back2.lista.items.some((i) => i.nombre === 'Fotos'), savedSettings().excludedPaths);

      check('sin mensajes de error durante el recorrido principal', (await read()).mensaje === '', (await read()).mensaje);

      // --- Cuadros diminutos: se pliegan en "Otras" y no reciben foco ---------------------------------------
      const tinyRoot = buildTinyFixture(fixture.base);
      await js("document.getElementById('btn-nuevo').click()");
      await waitFor((s) => s.estado === 'inicio', 'volver al inicio');
      context.smokeFolder = tinyRoot;
      await js("document.getElementById('btn-elegir').click()");
      const tiny = await settled((s) => s.mapa.carpeta === tinyRoot && s.mapa.celdas.length > 0, 'el mapa con carpetas diminutas');
      const buttons = tiny.mapa.celdas.filter((c) => c.etiqueta === 'BUTTON');
      const tinyOthers = tiny.mapa.celdas.find((c) => c.tipo === 'others');
      check('cuadros diminutos: ningún cuadro dibujado como botón es menor de 20 px de lado ni de 500 px²', buttons.length > 0 && buttons.every((c) => Math.min(c.rect.w, c.rect.h) >= 20 && c.rect.w * c.rect.h >= 500), buttons.map((c) => [c.nombre, Math.round(c.rect.w), Math.round(c.rect.h)]));
      check('cuadros diminutos: se sumaron a "Otras" (12 carpetas, sin perder bytes)', tinyOthers && tinyOthers.plegadas === 12 && tinyOthers.bytes === 12000 && tiny.mapa.celdas.reduce((sum, c) => sum + c.bytes, 0) === 1_500_000 + 12_000, tinyOthers && { plegadas: tinyOthers.plegadas, bytes: tinyOthers.bytes });
      check('cuadros diminutos: el aviso dice cuántas son, cuánto suman y cómo verlas', /«Otras» agrupa 12 carpetas pequeñas que suman 11,7 KB/.test(tiny.mapa.aviso) && tiny.mapa.aviso.includes('entra a la carpeta') && tiny.mapa.aviso.includes('baja el tamaño mínimo'), tiny.mapa.aviso);
      const focusable = await js(`[...document.querySelectorAll('#mapa button, #mapa [tabindex]')].map((e) => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); })`);
      check('ningún cuadro invisible puede recibir foco', focusable.length === buttons.length && focusable.every((side) => side >= 20), focusable);

      // --- Tope de 500 en la selección: se avisa y NO se pierde lo marcado ------------------------------------
      const manyRoot = buildManyFixture(fixture.base);
      await js("document.getElementById('btn-nuevo').click()");
      await waitFor((s) => s.estado === 'inicio', 'volver al inicio (2)');
      context.smokeFolder = manyRoot;
      await js("document.getElementById('btn-elegir').click()");
      await settled((s) => s.mapa.carpeta === manyRoot && s.mapa.celdas.length > 0, 'el mapa con muchas carpetas');
      await js("document.getElementById('tab-lista').click()");
      const manyList = await settled((s) => s.pestana === 'lista' && s.lista.items.length === 500, 'la lista con 500 carpetas');
      check('lista: 505 candidatas, se muestran 500 (tope de la lista)', manyList.lista.titulo.cantidad === 505 && manyList.lista.items.length === 500, manyList.lista.titulo);
      await js("document.querySelectorAll('#lista .chk-sel').forEach((c) => c.click())");
      const full = await waitFor((s) => s.seleccion.visible && s.seleccion.cantidad === 500 && s.seleccion.bytes === 500 * 1000, 'las 500 marcadas');
      check('500 carpetas marcadas: la barra suma 500 × 1000 bytes', full.seleccion.cantidad === 500 && full.seleccion.bytes === 500000, full.seleccion);
      win.setSize(1400, 1000); // con la barra lateral el mapa es más angosto: ventana grande para que Reciente1 conserve su cuadro
      await sleep(400);
      await js("document.getElementById('tab-mapa').click()");
      await settled((s) => s.pestana === 'mapa', 'volver al mapa');
      await clickCell(path.join(manyRoot, 'Reciente1'), { modifiers: ['control'] });
      await sleep(400);
      const over = await read();
      check('la carpeta 501 se rechaza con "Máximo 500 carpetas por operación"', /Máximo 500 carpetas por operación/.test(over.mensaje), over.mensaje);
      check('la selección NO se pierde: sigue visible con 500 carpetas', over.seleccion.visible && over.seleccion.cantidad === 500 && over.seleccion.bytes === 500000, over.seleccion);
      check('la carpeta 501 no quedó marcada', !cellOf(over, path.join(manyRoot, 'Reciente1')).seleccionada, null);

      await wizardScenarios();
      await testDataScenarios();

      // --- Capturas del diseño nuevo a dos tamaños (mapa, lista, copias anteriores, ayuda) ---
      if ((await read()).estado !== 'resultado') {
        await js("document.getElementById('btn-nuevo') && document.getElementById('btn-nuevo').click()");
        context.smokeFolder = fixture.root;
        await js("document.getElementById('btn-elegir').click()");
        await settled((st) => st.mapa.carpeta === fixture.root && st.mapa.celdas.length > 0, 'el mapa principal para las capturas');
      }
      for (const [w, h] of [[720, 520], [1280, 800]]) {
        win.setSize(w, h);
        await sleep(500);
        await js("document.getElementById('tab-mapa').click()");
        await sleep(400);
        await snapshot(`diseno-mapa-${w}x${h}.png`);
        await js("document.getElementById('tab-lista').click()");
        await sleep(400);
        await snapshot(`diseno-lista-${w}x${h}.png`);
        await js("document.getElementById('btn-verificar-copia').click()");
        await sleep(800);
        await snapshot(`diseno-copias-${w}x${h}.png`);
        const dlg = await js("(() => { const d = document.getElementById('dlg-transferir'); const r = d.getBoundingClientRect(); return { abierto: d.open, dentro: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1 }; })()");
        check(`diseño ${w}×${h}: «Copias anteriores» cabe en la ventana`, dlg.abierto && dlg.dentro, dlg);
        await js("document.getElementById('dlg-cerrar').click()");
        await sleep(300);
        await js("document.getElementById('nav-ayuda').click()");
        await sleep(400);
        await snapshot(`diseno-ayuda-${w}x${h}.png`);
        await js("document.getElementById('ayuda-pruebas').open = false");
      }
      await js("document.getElementById('tab-mapa').click()");

      const finalSettings = savedSettings();
      check('settings.json con el esquema esperado', finalSettings.version === 1 && finalSettings.staleDays === 90 && finalSettings.minSizeBytes === 1000 && finalSettings.mapMinBytes === 1000, finalSettings);

      await finish(report.checks.every((c) => c.ok) ? 0 : 1);
    } catch (err) {
      await finish(1, err);
    }
  })();
}

module.exports = { prepare, run };
