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
  getLargestFiles: (n) => ipcRenderer.invoke('byd:largest-files', n),
  getLargestFolders: (n) => ipcRenderer.invoke('byd:largest-folders', n),
  /** Suscribe a los avisos de progreso. Devuelve una función para darse de baja. */
  onProgress: (callback) => {
    if (typeof callback !== 'function') throw new TypeError('onProgress necesita una función');
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('byd:progress', listener);
    return () => ipcRenderer.removeListener('byd:progress', listener);
  },
});
