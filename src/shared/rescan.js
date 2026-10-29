'use strict';

/**
 * Estado del botón «Volver a escanear» (lógica pura; módulo UMD como activity.js).
 * - Se puede pulsar solo si hay un resultado, no se está escaneando y no hay una copia/transferencia en curso.
 * - Cuando se retiró algún original (Papelera o borrado), el mapa queda desactualizado: se avisa, pero NUNCA se
 *   vuelve a escanear solo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYDRescan = factory();
})(typeof self !== 'undefined' ? self : this, () => {
  const STALE_TEXT = 'El mapa quedó desactualizado: se retiró el original de alguna carpeta.';

  /**
   * @param {{hasResult:boolean, scanning:boolean, transferring:boolean, transferredCount:number, folder:string|null}} s
   */
  function rescanView(s) {
    const x = s || {};
    let reason = '';
    if (x.scanning) reason = 'Ya se está escaneando.';
    else if (x.transferring) reason = 'Espera a que termine la copia o la transferencia.';
    else if (!x.hasResult || !x.folder) reason = 'Primero elige una unidad o carpeta.';
    const stale = Boolean(x.hasResult) && Number(x.transferredCount) > 0;
    return { disabled: reason !== '', reason, stale, staleText: stale ? STALE_TEXT : '', label: 'Volver a escanear' };
  }

  /** F5 (o Ctrl+R) solo cuenta si el botón está habilitado y no se está escribiendo en un campo. */
  function shouldHandleKey(event, view, typing) {
    if (!event || view.disabled || typing) return false;
    return event.key === 'F5' || Boolean((event.ctrlKey || event.metaKey) && (event.key === 'r' || event.key === 'R'));
  }

  return { rescanView, shouldHandleKey, STALE_TEXT };
});
