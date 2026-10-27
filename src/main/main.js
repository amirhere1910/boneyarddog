'use strict';

/**
 * Proceso principal de BoneYardDog.
 *
 * Seguridad (resumen):
 *  - Ventana con contextIsolation, sin nodeIntegration y con sandbox.
 *  - La interfaz solo puede llamar a las funciones de preload.js; cada mensaje
 *    se valida (validate.js) y se comprueba que venga de nuestra ventana.
 *  - Sin red: se bloquea cualquier petición que no sea un archivo local, no se
 *    permite navegar ni abrir ventanas, y se niegan todos los permisos.
 *  - La carpeta a escanear SOLO sale del diálogo del sistema.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, session, shell, Menu } = require('electron');

const { Worker } = require('node:worker_threads');
const { AnalysisService } = require('../service/service');
const V = require('./validate');
const { SettingsStore, validatePatch } = require('./settings');
const { listDrives } = require('./drives');

const SMOKE = process.env.BYD_SMOKE === '1' && process.argv.includes('--smoke-test');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;

if (SMOKE) {
  // Solo en la prueba automática: los servidores de integración no tienen GPU, y la
  // configuración va a una carpeta temporal para no tocar la del usuario.
  app.disableHardwareAcceleration();
  app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'byd-smoke-userdata-')));
}

/**
 * Estado interno. `smokeFolder` y `revealHook` solo los usa la prueba automática
 * (en el uso normal siguen en null).
 */
const context = { chosenFolder: null, smokeFolder: null, revealHook: null };
let mainWindow = null;
let service = null;
let settings = null;

/** Único lugar donde se fija la carpeta a escanear: viene del diálogo o de una unidad que el principal reconoce. */
function setChosenFolder(p) {
  context.chosenFolder = V.validateAbsolutePath(p);
  return { path: context.chosenFolder };
}

function usageFrom(s) {
  return { useAccessTime: s.useAccessTime, useCreationTime: s.useCreationTime };
}

function lockDownSession(ses) {
  // La app no usa red: solo se permiten archivos locales.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const url = details.url;
    callback({ cancel: !(url.startsWith('file://') || url.startsWith('devtools://')) });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 720,
    minHeight: 520,
    title: 'BoneYardDog',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.loadFile(INDEX_PATH);
  return win;
}

function trusted(event) {
  const frame = event.senderFrame;
  return V.isTrustedSender(
    {
      senderId: event.sender.id,
      frameUrl: frame ? frame.url : '',
      isMainFrame: frame ? frame.parent === null : false,
    },
    { webContentsId: mainWindow ? mainWindow.webContents.id : -1, indexUrl: INDEX_URL },
  );
}

/** Registra un canal: comprueba remitente, valida, ejecuta y devuelve {ok, value|error}. */
function handle(channel, validateAndRun) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!trusted(event)) throw new V.ValidationError('Remitente no autorizado');
      return { ok: true, value: await validateAndRun(...args) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function registerIpc() {
  handle(V.CHANNELS.chooseFolder, async (...args) => {
    V.validateNoArgs(args);
    let chosen;
    if (context.smokeFolder) {
      chosen = context.smokeFolder; // solo existe en la prueba automática
    } else {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Elegir carpeta o disco a revisar',
        properties: ['openDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      chosen = result.filePaths[0];
    }
    return setChosenFolder(chosen);
  });

  handle(V.CHANNELS.listDrives, async (...args) => {
    V.validateNoArgs(args);
    return listDrives();
  });

  handle(V.CHANNELS.chooseDrive, async (letter, ...rest) => {
    V.validateNoArgs(rest);
    const wanted = V.validateDriveLetter(letter);
    // El principal solo acepta letras que ÉL mismo detecta.
    const drive = (await listDrives()).find((d) => d.letter === wanted);
    if (!drive) throw new V.ValidationError(`La unidad ${wanted}: no está disponible`);
    return setChosenFolder(drive.path);
  });

  handle(V.CHANNELS.startScan, async (...args) => {
    V.validateNoArgs(args);
    if (!context.chosenFolder) throw new V.ValidationError('Primero hay que elegir una carpeta');
    return service.startScan(context.chosenFolder);
  });

  handle(V.CHANNELS.cancelScan, async (...args) => {
    V.validateNoArgs(args);
    return service.cancel();
  });

  handle(V.CHANNELS.getSettings, async (...args) => {
    V.validateNoArgs(args);
    return settings.get();
  });

  handle(V.CHANNELS.saveSettings, async (patch, ...rest) => {
    V.validateNoArgs(rest);
    const valid = validatePatch(patch);
    const before = settings.get();
    const next = settings.update(valid);
    if (before.useAccessTime !== next.useAccessTime || before.useCreationTime !== next.useCreationTime) {
      await service.setUsageOptions(usageFrom(next));
    }
    return next;
  });

  handle(V.CHANNELS.staleFolders, async (...args) => {
    V.validateNoArgs(args);
    const s = settings.get();
    return service.getStaleFolders({ olderThanDays: s.staleDays, minSizeBytes: s.minSizeBytes, excludedPaths: s.excludedPaths });
  });

  handle(V.CHANNELS.excludePath, async (p, ...rest) => {
    V.validateNoArgs(rest);
    V.validateAbsolutePath(p);
    // La ruta debe existir en el árbol del servicio, y se guarda la ruta que ÉL conoce.
    const node = await service.getNode(p);
    if (node.type !== 'folder') throw new V.ValidationError('Solo se pueden ignorar carpetas');
    const current = settings.get().excludedPaths;
    return settings.update({ excludedPaths: current.includes(node.path) ? current : [...current, node.path] });
  });

  handle(V.CHANNELS.includePath, async (p, ...rest) => {
    V.validateNoArgs(rest);
    V.validateAbsolutePath(p);
    const current = settings.get().excludedPaths;
    if (!current.includes(p)) throw new V.ValidationError('Esa carpeta no está en la lista de ignoradas');
    return settings.update({ excludedPaths: current.filter((x) => x !== p) });
  });

  handle(V.CHANNELS.treemap, async (p, options, ...rest) => {
    V.validateNoArgs(rest);
    V.validateAbsolutePath(p);
    const valid = V.validateTreemapOptions(options);
    return service.getTreemap(p, { minBytes: settings.get().mapMinBytes, ...valid });
  });

  handle(V.CHANNELS.details, async (p, ...rest) => {
    V.validateNoArgs(rest);
    return service.getDetails(V.validateAbsolutePath(p));
  });

  handle(V.CHANNELS.summarizeSelection, async (paths, ...rest) => {
    V.validateNoArgs(rest);
    return service.summarizeSelection(V.validatePathList(paths));
  });

  handle(V.CHANNELS.reveal, async (p, ...rest) => {
    V.validateNoArgs(rest);
    V.validateAbsolutePath(p);
    const node = await service.getNode(p); // solo rutas que el servicio confirma en su árbol
    // Solo se muestra en el Explorador: nunca se abre ni se ejecuta nada.
    (context.revealHook || shell.showItemInFolder)(node.path);
    return { path: node.path };
  });
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  lockDownSession(session.defaultSession);

  settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'));
  service = new AnalysisService(
    SMOKE
      ? // Solo en la prueba automática: una carpeta de ejemplo que se muestra como protegida.
        { workerFactory: () => new Worker(path.join(__dirname, '..', 'service', 'analysis-worker.js'), { workerData: { smokeProtectedNames: ['Sistema protegido'] } }) }
      : undefined,
  );
  await service.setUsageOptions(usageFrom(settings.get()));
  service.on('progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(V.CHANNELS.progress, progress);
  });
  registerIpc();
  // Se carga solo en modo prueba: en el uso normal este código ni se lee.
  const smoke = SMOKE ? require('./smoke') : null;
  const smokeFixture = smoke ? await smoke.prepare({ app, settings, service }) : null;
  mainWindow = createWindow();
  if (smoke) smoke.run({ app, win: mainWindow, context, service, settings, indexUrl: INDEX_URL, fixture: smokeFixture });
}

app.on('window-all-closed', () => {
  if (service) service.close();
  app.quit();
});

start().catch((err) => {
  console.error(err);
  app.exit(1);
});
