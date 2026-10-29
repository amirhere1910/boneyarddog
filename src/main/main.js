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
 *  - El DESTINO de una copia SOLO sale del diálogo del sistema o de una unidad que este proceso detecta;
 *    se guarda aquí y la interfaz nunca manda una ruta de destino. Los orígenes los confirma el análisis
 *    (service.getNode) uno por uno.
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
const { listDrives, listDestinationDrives } = require('./drives');
const { volumeInfoForPath } = require('./volume-info');
const { TransferService } = require('../service/transfer-service');
const { createTestDataService } = require('./datos-prueba-service');
const TD = require('../core/datos-prueba');
const TR = require('../core/transfer-rules');

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
const context = {
  chosenFolder: null,
  smokeFolder: null,
  revealHook: null,
  // Copiar y transferir.
  destination: null, // { path, letter, driveType, fileSystem, sizeBytes, freeBytes }: lo fija la función setDestination
  revealable: new Set(), // rutas que el motor confirmó (carpeta del lote y copias): se pueden mostrar en el Explorador
  transferBusy: false,
  closeConfirmed: false,
  // Solo la prueba automática los usa (en el uso normal siguen en null):
  smokeDestination: null,
  smokeTrashFails: false,
  smokeDocuments: null, // solo la prueba automática en Linux (no hay carpeta Documentos real)
  testDataBusy: false,
  testDataAbort: null,
  testRunIds: new Set(), // transferencias hechas en esta sesión cuyos orígenes son solo los datos de prueba
  closeDialogHook: null,
};
let mainWindow = null;
let service = null;
let transferService = null;
let testData = null;
let settings = null;

/** Único lugar donde se fija la carpeta a escanear: viene del diálogo o de una unidad que el principal reconoce. */
function setChosenFolder(p) {
  context.chosenFolder = V.validateAbsolutePath(p);
  return { path: context.chosenFolder };
}

/** Único lugar donde se fija el destino: viene del diálogo o de una unidad que el principal reconoce. */
async function setDestination(p) {
  const dest = V.validateDestinationPath(p);
  const info = await volumeInfoForPath(dest);
  const letter = /^[A-Za-z]:/.test(dest) ? dest[0].toUpperCase() : null;
  context.destination = { path: dest, letter, driveType: info.driveType, fileSystem: info.fileSystem, sizeBytes: info.sizeBytes, freeBytes: info.freeBytes };
  return { ...context.destination };
}

/** Recuerda las rutas que el motor confirmó (para «Abrir la copia en el Explorador»). */
function rememberRevealable(result) {
  if (!result) return;
  for (const c of result.carpetas || []) if (typeof c.destino === 'string' && c.verificada) context.revealable.add(c.destino);
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
  // Con una copia en curso, cerrar la ventana pide confirmación (y cancela la operación si se confirma).
  win.on('close', (event) => {
    if (!context.transferBusy || context.closeConfirmed) return;
    event.preventDefault();
    const ask = context.closeDialogHook || ((options) => dialog.showMessageBox(win, options));
    Promise.resolve(
      ask({
        type: 'warning',
        title: 'BoneYardDog',
        message: 'Hay una copia en curso',
        detail: 'Si cierras ahora, la operación se cancelará y la copia quedará incompleta. Los originales no se tocan.',
        buttons: ['Seguir esperando', 'Cancelar la operación y cerrar'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }),
    ).then(async (answer) => {
      if (!answer || answer.response !== 1) return;
      context.closeConfirmed = true;
      try {
        await transferService.cancel();
      } catch {
        /* se cierra de todos modos */
      }
      win.close();
    });
  });
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
    if (context.revealable.has(p)) {
      // Una ruta que el motor de transferencias confirmó (carpeta del lote o de una copia).
      (context.revealHook || shell.showItemInFolder)(p);
      return { path: p };
    }
    const node = await service.getNode(p); // solo rutas que el servicio confirma en su árbol
    // Solo se muestra en el Explorador: nunca se abre ni se ejecuta nada.
    (context.revealHook || shell.showItemInFolder)(node.path);
    return { path: node.path };
  });

  // ---------------------------------------------------------------- copiar y transferir

  handle(V.CHANNELS.chooseDestination, async (...args) => {
    V.validateNoArgs(args);
    let chosen;
    if (context.smokeDestination) {
      chosen = context.smokeDestination; // solo existe en la prueba automática
    } else {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Elegir la carpeta de destino de la copia',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      chosen = result.filePaths[0];
    }
    return setDestination(chosen);
  });

  handle(V.CHANNELS.listDestinationDrives, async (...args) => {
    V.validateNoArgs(args);
    return listDestinationDrives();
  });

  handle(V.CHANNELS.chooseDestinationDrive, async (letter, ...rest) => {
    V.validateNoArgs(rest);
    const wanted = V.validateDriveLetter(letter);
    // El principal solo acepta letras que ÉL mismo detecta.
    const drive = (await listDestinationDrives()).find((d) => d.letter === wanted);
    if (!drive) throw new V.ValidationError(`La unidad ${wanted}: no está disponible como destino`);
    return setDestination(drive.path);
  });

  handle(V.CHANNELS.transferPreflight, async (options, ...rest) => {
    V.validateNoArgs(rest);
    const valid = V.validateTransferPreflight(options);
    if (!context.destination) throw new V.ValidationError('Primero hay que elegir el destino');
    // Cada origen lo confirma el análisis; se usa la ruta que ÉL conoce (y deben ser carpetas).
    const nodes = await Promise.all(valid.sources.map((p) => service.getNode(p)));
    const sources = [];
    for (const node of nodes) {
      if (node.type !== 'folder') throw new V.ValidationError('Solo se pueden copiar carpetas');
      if (!sources.includes(node.path)) sources.push(node.path);
    }
    return transferService.preflight({
      sources,
      destinationRoot: context.destination.path,
      mode: valid.mode,
      verify: valid.verify,
      disposal: valid.disposal,
      confirmPermanentDelete: valid.confirmPermanentDelete,
    });
  });

  handle(V.CHANNELS.transferRun, async (planId, ...rest) => {
    V.validateNoArgs(rest);
    V.validateOpaqueId(planId);
    context.transferBusy = true;
    try {
      const result = await transferService.run(planId);
      rememberRevealable(result);
      // Si TODO lo copiado eran datos de prueba, se recuerda para poder quitar esa copia al borrarlos (si el usuario lo pide).
      if (result.carpetas.length > 0 && result.carpetas.every((c) => TR.isInside(c.origen, testData.rootPath()))) context.testRunIds.add(result.runId);
      return result;
    } finally {
      context.transferBusy = false;
    }
  });

  handle(V.CHANNELS.transferCancel, async (...args) => {
    V.validateNoArgs(args);
    return transferService.cancel();
  });

  handle(V.CHANNELS.transferDeleteFromResult, async (runId, indices, confirm, ...rest) => {
    V.validateNoArgs(rest);
    const valid = V.validateDeleteFromResult(runId, indices, confirm);
    context.transferBusy = true;
    try {
      const out = await transferService.eliminarDefinitivamente(valid.runId, valid.indices, true);
      rememberRevealable(out.resumen);
      return out;
    } finally {
      context.transferBusy = false;
    }
  });

  handle(V.CHANNELS.transferRemoveCopy, async (runId, ...rest) => {
    V.validateNoArgs(rest);
    V.validateOpaqueId(runId);
    return transferService.quitarCopiado(runId);
  });

  // --------------------------------------------------------------- copias anteriores (registro en el PC)

  handle(V.CHANNELS.copiesList, async (...args) => {
    V.validateNoArgs(args);
    return transferService.listRecords();
  });

  handle(V.CHANNELS.copiesVerify, async (id, options, ...rest) => {
    V.validateNoArgs(rest);
    V.validateOpaqueId(id);
    const valid = V.validateVerifyOptions(options);
    context.transferBusy = true;
    try {
      return await transferService.verifyRecord(id, { mode: valid.mode });
    } finally {
      context.transferBusy = false;
    }
  });

  handle(V.CHANNELS.copiesRemove, async (id, ...rest) => {
    V.validateNoArgs(rest);
    V.validateOpaqueId(id);
    return transferService.removeRecord(id); // solo quita el registro del PC, nunca la copia
  });

  handle(V.CHANNELS.pendingList, async (...args) => {
    V.validateNoArgs(args);
    return transferService.listPending();
  });

  handle(V.CHANNELS.pendingClean, async (ruta, ...rest) => {
    V.validateNoArgs(rest);
    V.validateAbsolutePath(ruta);
    return transferService.cleanPending(ruta); // el hilo comprueba que el diario de BoneYardDog la anotó
  });

  // ------------------------------------------------------------------- datos de prueba

  handle(V.CHANNELS.appInfo, async (...args) => {
    V.validateNoArgs(args);
    return { name: 'BoneYardDog', version: app.getVersion(), project: 'https://github.com/amirhere1910/boneyarddog' };
  });

  handle(V.CHANNELS.testDataStatus, async (...args) => {
    V.validateNoArgs(args);
    return testData.status();
  });

  handle(V.CHANNELS.testDataCreate, async (...args) => {
    V.validateNoArgs(args);
    if (context.testDataBusy) throw new V.ValidationError('Ya se están creando los datos de prueba');
    context.testDataBusy = true;
    context.testDataAbort = new AbortController();
    try {
      return await testData.create({
        signal: context.testDataAbort.signal,
        onProgress: (p) => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(V.CHANNELS.testDataProgress, p);
        },
      });
    } finally {
      context.testDataBusy = false;
      context.testDataAbort = null;
    }
  });

  handle(V.CHANNELS.testDataCancel, async (...args) => {
    V.validateNoArgs(args);
    if (context.testDataAbort) context.testDataAbort.abort();
    return { cancelled: Boolean(context.testDataAbort) };
  });

  handle(V.CHANNELS.testDataDelete, async (options, ...rest) => {
    V.validateNoArgs(rest);
    const valid = V.validateTestDataDelete(options);
    if (context.testDataBusy) throw new V.ValidationError('Se están creando los datos de prueba: espera a que termine o cancela');
    const copies = { quitadas: 0, rechazadas: [] };
    if (valid.removeCopies) {
      // Solo copias hechas en ESTA sesión cuyos orígenes eran únicamente datos de prueba; el motor se niega si ya se retiró algún original.
      for (const runId of [...context.testRunIds]) {
        try {
          await transferService.quitarCopiado(runId);
          copies.quitadas++;
          context.testRunIds.delete(runId);
        } catch (err) {
          copies.rechazadas.push({ runId, motivo: err && err.message ? err.message : String(err) });
        }
      }
    }
    await testData.removeRoot(); // solo con la marca y sin nada ajeno dentro; si no, lanza y no borra nada
    return { borrado: true, copias: copies };
  });

  handle(V.CHANNELS.testDataUse, async (...args) => {
    V.validateNoArgs(args);
    const st = await testData.status();
    if (!st.exists || !st.marked) throw new V.ValidationError('No hay datos de prueba creados por BoneYardDog');
    return setChosenFolder(st.path);
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
  testData = createTestDataService({ documentsDir: () => context.smokeDocuments || app.getPath('documents'), version: app.getVersion() });
  // La Papelera real solo existe aquí (shell.trashItem); el hilo de transferencias se la pide a este proceso.
  const registryDir = path.join(app.getPath('userData'), 'registros');
  const trash = (p) => (context.smokeTrashFails ? Promise.reject(new Error('Simulado por la prueba: Windows rechazó enviar a la Papelera (E_ABORT)')) : shell.trashItem(p));
  transferService = new TransferService(
    SMOKE
      ? // Solo en la prueba automática: carpetas «Removible …» se tratan como discos sin Papelera.
        { trash, workerFactory: () => new Worker(path.join(__dirname, '..', 'service', 'transfer-worker.js'), { workerData: { hasTrash: true, progressIntervalMs: 100, smokeRemovablePrefix: 'Removible ', smokeSlowPrefix: 'Lenta ', registryDir } }) }
      : { trash, registryDir },
  );
  transferService.on('progress', (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(V.CHANNELS.transferProgress, progress);
  });
  registerIpc();
  // Se carga solo en modo prueba: en el uso normal este código ni se lee.
  const smoke = SMOKE ? require('./smoke') : null;
  const smokeFixture = smoke ? await smoke.prepare({ app, settings, service }) : null;
  mainWindow = createWindow();
  if (smoke) smoke.run({ app, win: mainWindow, context, service, transferService, settings, indexUrl: INDEX_URL, fixture: smokeFixture });
}

app.on('window-all-closed', () => {
  if (service) service.close();
  if (transferService) transferService.close();
  app.quit();
});

start().catch((err) => {
  console.error(err);
  app.exit(1);
});
