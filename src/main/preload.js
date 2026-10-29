'use strict';

/**
 * Puente entre la interfaz y el proceso principal.
 * Expone SOLO funciones concretas (nunca ipcRenderer completo).
 * Nota: un preload con sandbox no puede cargar otros archivos locales, por
 * eso los nombres de canal se repiten aquí (validate.js tiene la lista oficial
 * y una prueba comprueba que coinciden).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('byd', {
  chooseFolder: () => ipcRenderer.invoke('byd:choose-folder'),
  startScan: () => ipcRenderer.invoke('byd:start-scan'),
  cancelScan: () => ipcRenderer.invoke('byd:cancel-scan'),
  getSettings: () => ipcRenderer.invoke('byd:get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('byd:save-settings', patch),
  getStaleFolders: () => ipcRenderer.invoke('byd:stale-folders'),
  excludePath: (p) => ipcRenderer.invoke('byd:exclude-path', p),
  includePath: (p) => ipcRenderer.invoke('byd:include-path', p),
  listDrives: () => ipcRenderer.invoke('byd:list-drives'),
  chooseDrive: (letter) => ipcRenderer.invoke('byd:choose-drive', letter),
  revealInExplorer: (p) => ipcRenderer.invoke('byd:reveal', p),
  getTreemap: (p, options) => ipcRenderer.invoke('byd:treemap', p, options),
  getDetails: (p) => ipcRenderer.invoke('byd:details', p),
  summarizeSelection: (paths) => ipcRenderer.invoke('byd:summarize-selection', paths),
  // Copiar y transferir. NINGUNA de estas funciones recibe una ruta de destino: el destino lo fija el
  // proceso principal (diálogo del sistema o unidad detectada) y se usa «el destino elegido».
  chooseDestination: () => ipcRenderer.invoke('byd:choose-destination'),
  chooseDestinationDrive: (letter) => ipcRenderer.invoke('byd:choose-destination-drive', letter),
  listDestinationDrives: () => ipcRenderer.invoke('byd:list-destination-drives'),
  transferPreflight: (options) => ipcRenderer.invoke('byd:transfer-preflight', options),
  transferRun: (planId) => ipcRenderer.invoke('byd:transfer-run', planId),
  transferCancel: () => ipcRenderer.invoke('byd:transfer-cancel'),
  transferDeleteFromResult: (runId, indices, confirm) => ipcRenderer.invoke('byd:transfer-delete-from-result', runId, indices, confirm),
  transferRemoveCopy: (runId) => ipcRenderer.invoke('byd:transfer-remove-copy', runId),
  // Copias anteriores (registro en el PC): solo el id de una copia, nunca una ruta de destino.
  copiesList: () => ipcRenderer.invoke('byd:copies-list'),
  copiesVerify: (id, options) => ipcRenderer.invoke('byd:copies-verify', id, options),
  copiesRemove: (id) => ipcRenderer.invoke('byd:copies-remove', id),
  pendingList: () => ipcRenderer.invoke('byd:pending-list'),
  pendingClean: (ruta) => ipcRenderer.invoke('byd:pending-clean', ruta),
  diagSave: () => ipcRenderer.invoke('byd:diag-save'),
  // Datos de prueba: ninguna función recibe una ruta (la carpeta es fija y la conoce el proceso principal).
  testDataStatus: () => ipcRenderer.invoke('byd:test-data-status'),
  testDataCreate: () => ipcRenderer.invoke('byd:test-data-create'),
  testDataCancel: () => ipcRenderer.invoke('byd:test-data-cancel'),
  testDataDelete: (options) => ipcRenderer.invoke('byd:test-data-delete', options),
  testDataUse: () => ipcRenderer.invoke('byd:test-data-use'),
  getAppInfo: () => ipcRenderer.invoke('byd:app-info'),
  /** Suscribe a los avisos de progreso. Devuelve una función para darse de baja. */
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onProgress necesita una función');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('byd:progress', listener);
    return () => ipcRenderer.removeListener('byd:progress', listener);
  },
  /** Avisos de progreso de la creación de datos de prueba. Devuelve una función para darse de baja. */
  onTestDataProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onTestDataProgress necesita una función');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('byd:test-data-progress', listener);
    return () => ipcRenderer.removeListener('byd:test-data-progress', listener);
  },
  /** Avisos de progreso de una copia o de una verificación. Devuelve una función para darse de baja. */
  onTransferProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onTransferProgress necesita una función');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('byd:transfer-progress', listener);
    return () => ipcRenderer.removeListener('byd:transfer-progress', listener);
  },
});
