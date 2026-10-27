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

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog, ipcMain, session, Menu } = require('electron');

const { AnalysisService } = require('../service/service');
const V = require('./validate');

const SMOKE = process.env.BYD_SMOKE === '1' && process.argv.includes('--smoke-test');
const INDEX_PATH = path.join(__dirname, '..', 'renderer', 'index.html');
const INDEX_URL = pathToFileURL(INDEX_PATH).href;

if (SMOKE) {
  // Solo en la prueba automática: los servidores de integración no tienen GPU.
  app.disableHardwareAcceleration();
}

/** Estado interno. `smokeFolder` solo lo usa la prueba automática. */
const context = { chosenFolder: null, smokeFolder: null };
let mainWindow = null;
let service = null;

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
    context.chosenFolder = V.validateAbsolutePath(chosen);
    return { path: context.chosenFolder };
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

  handle(V.CHANNELS.largestFiles, async (n, ...rest) => {
    V.validateNoArgs(rest);
    return service.getLargestFiles(V.validateCount(n));
  });

  handle(V.CHANNELS.largestFolders, async (n, ...rest) => {
    V.validateNoArgs(rest);
    return service.getLargestFolders(V.validateCount(n));
  });
}

async function start() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  lockDownSession(session.defaultSession);

  service = new AnalysisService();
  service.on('progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(V.CHANNELS.progress, progress);
  });
  registerIpc();
  mainWindow = createWindow();

  if (SMOKE) {
    // Se carga solo en modo prueba: en el uso normal este código ni se lee.
    require('./smoke').run({ app, win: mainWindow, context, service, indexUrl: INDEX_URL });
  }
}

app.on('window-all-closed', () => {
  if (service) service.close();
  app.quit();
});

start().catch((err) => {
  console.error(err);
  app.exit(1);
});
