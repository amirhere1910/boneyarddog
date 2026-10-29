'use strict';

/**
 * Estados de actividad de una carpeta y sus colores (módulo UMD: sirve con
 * require() en las pruebas y con <script> en la interfaz; sin dependencias).
 *
 * Se mide en días sin uso (ver "qué cuenta como uso" en docs/ALCANCE.md) contra
 * el período que eligió el usuario (P):
 *   muy-reciente    sin uso desde hace  <= P/3     (naranja)
 *   reciente        sin uso desde hace  <= P       (amarillo)
 *   sin-movimiento  sin uso desde hace  <= 2·P     (azul)
 *   muy-antigua     sin uso desde hace  >  2·P     (plomo azulado oscuro)
 *   desconocido     no se sabe                     (gris claro)
 * Familia cálida = movimiento reciente; familia fría = sin movimiento.
 * El color nunca va solo: cada cuadro lleva además texto y la leyenda lo explica.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYDActivity = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const STATES = ['muy-reciente', 'reciente', 'sin-movimiento', 'muy-antigua', 'desconocido'];

  const LABELS = {
    'muy-reciente': 'Muy reciente',
    reciente: 'Reciente',
    'sin-movimiento': 'Sin movimiento',
    'muy-antigua': 'Muy antigua',
    desconocido: 'Desconocido',
  };

  // Fondo y texto por estado. Todos los pares cumplen contraste WCAG >= 4.5 (hay una prueba).
  const PALETTE = {
    'muy-reciente': { bg: '#F4A261', fg: '#241200' },
    reciente: { bg: '#F6DC74', fg: '#241B00' },
    'sin-movimiento': { bg: '#3F6FD8', fg: '#FFFFFF' },
    'muy-antigua': { bg: '#5F6B85', fg: '#FFFFFF' },
    desconocido: { bg: '#E3E7EE', fg: '#1F2937' },
  };

  /**
   * @param {number|null} daysUnused Días sin uso (null/NaN si no se sabe).
   * @param {number} periodDays Período elegido, en días.
   */
  function activityState(daysUnused, periodDays) {
    if (typeof daysUnused !== 'number' || !Number.isFinite(daysUnused)) return 'desconocido';
    if (daysUnused <= periodDays / 3) return 'muy-reciente';
    if (daysUnused <= periodDays) return 'reciente';
    if (daysUnused <= 2 * periodDays) return 'sin-movimiento';
    return 'muy-antigua';
  }

  return { STATES, LABELS, PALETTE, activityState };
});
