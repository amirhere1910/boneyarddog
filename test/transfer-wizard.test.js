'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const W = require('../src/shared/transfer-wizard');

const review = (extra = {}) => ({ planId: '0123456789abcdef', blockers: [], warnings: [], ...extra });
const warn = (code) => ({ code, message: code });

// ------------------------------------------------------------------ las cuatro reglas mínimas

test('NO se puede avanzar (empezar) con impedimentos, por pocos que sean', () => {
  const base = { mode: 'copy', review: review() };
  assert.equal(W.canStart(base).ok, true);
  const con = { ...base, review: review({ blockers: [{ code: 'sin-espacio', message: 'No hay espacio' }] }) };
  assert.equal(W.canStart(con).ok, false);
  assert.match(W.canStart(con).reason, /impedimentos/);
  // Sin revisión, o sin plan, tampoco.
  assert.equal(W.canStart({ mode: 'copy', review: null }).ok, false);
  assert.equal(W.canStart({ mode: 'copy' }).ok, false);
  assert.equal(W.canStart({ mode: 'copy', review: review({ planId: null }) }).ok, false);
  // Un impedimento gana sobre cualquier otra elección.
  const elegido = { mode: 'move', recycleChoice: 'dejar', understood: true, review: review({ blockers: [{ code: 'origen-protegido' }], warnings: [warn('papelera-no-cabe')] }) };
  assert.equal(W.canStart(elegido).ok, false);
});

test('NO se puede borrar definitivamente sin la confirmación «Entiendo que no se podrá recuperar»', () => {
  const r = review({ warnings: [warn('papelera-no-cabe')] });
  assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: 'borrar', understood: false }).ok, false);
  assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: 'borrar' }).ok, false);
  for (const falso of ['true', 1, 'sí', {}, null]) assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: 'borrar', understood: falso }).ok, false, String(falso));
  assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: 'borrar', understood: true }).ok, true);
  // También sin el aviso de la Papelera: si el usuario eligió borrar, hace falta confirmar.
  assert.equal(W.canStart({ mode: 'move', review: review(), recycleChoice: 'borrar', understood: false }).ok, false);
  // Y la petición al motor solo lleva confirmPermanentDelete=true si se marcó.
  const sources = ['C:\\Datos\\A'];
  assert.equal(W.buildPreflightRequest({ mode: 'move', sources, recycleChoice: 'borrar', understood: false }).confirmPermanentDelete, false);
  assert.equal(W.buildPreflightRequest({ mode: 'move', sources, recycleChoice: 'borrar', understood: 'true' }).confirmPermanentDelete, false);
  assert.equal(W.buildPreflightRequest({ mode: 'move', sources, recycleChoice: 'borrar', understood: true }).confirmPermanentDelete, true);
});

test('«Probablemente no cabe en la Papelera»: hay que ELEGIR (nada preseleccionado); dejar el original no pide confirmación', () => {
  const r = review({ warnings: [warn('papelera-no-cabe')] });
  assert.equal(W.needsRecycleChoice('move', r), true);
  assert.equal(W.needsRecycleChoice('copy', r), false, 'al copiar no hay Papelera que preguntar');
  assert.equal(W.needsRecycleChoice('move', review()), false);
  for (const sin of [undefined, null, '', 'papelera', 'nada']) assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: sin }).ok, false, String(sin));
  assert.equal(W.canStart({ mode: 'move', review: r, recycleChoice: 'dejar' }).ok, true);
  // Sin el aviso, transferir a la Papelera se puede empezar sin preguntar nada.
  assert.equal(W.canStart({ mode: 'move', review: review() }).ok, true);
});

test('la verificación RÁPIDA no está disponible para transferir (sí para copiar)', () => {
  const quick = (mode) => W.verifyOptions(mode).find((o) => o.id === 'quick');
  const full = (mode) => W.verifyOptions(mode).find((o) => o.id === 'full');
  assert.equal(quick('move').available, false);
  assert.match(quick('move').detail, /No disponible al transferir/);
  assert.equal(quick('copy').available, true);
  assert.equal(full('move').available, true);
  assert.match(full('copy').label, /recomendada/);
  assert.match(quick('copy').label, /solo tamaño y fecha; no comprueba el contenido/);
  // Aunque algo intente pedirla, al transferir siempre sale completa.
  assert.equal(W.effectiveVerify('move', 'quick'), 'full');
  assert.equal(W.effectiveVerify('copy', 'quick'), 'quick');
  assert.equal(W.effectiveVerify('copy', undefined), 'full');
  assert.equal(W.buildPreflightRequest({ mode: 'move', verify: 'quick', sources: ['/a'] }).verify, 'full');
  assert.equal(W.buildPreflightRequest({ mode: 'copy', verify: 'quick', sources: ['/a'] }).verify, 'quick');
  // Y el paso 1 tampoco deja pasar un transferir con verificación rápida.
  assert.equal(W.canGoToReview({ mode: 'move', verify: 'quick', destination: { path: 'D:\\' }, sources: ['a'] }).ok, false);
});

test('el tope de 500 carpetas: se aceptan hasta 500 y lo que sobra se rechaza SIN perder lo ya elegido', () => {
  assert.equal(W.MAX_SOURCES, 500);
  assert.deepEqual(W.limitSelection(0, ['a', 'b']), { accepted: ['a', 'b'], rejected: [] });
  assert.deepEqual(W.limitSelection(499, ['a', 'b', 'c']), { accepted: ['a'], rejected: ['b', 'c'] });
  assert.deepEqual(W.limitSelection(500, ['a']), { accepted: [], rejected: ['a'] });
  assert.deepEqual(W.limitSelection(900, ['a']), { accepted: [], rejected: ['a'] });
  const muchas = Array.from({ length: 501 }, (_, i) => `C:\\c${i}`);
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', destination: { path: 'D:\\' }, sources: muchas }).ok, false);
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', destination: { path: 'D:\\' }, sources: muchas.slice(0, 500) }).ok, true);
  assert.equal(W.buildPreflightRequest({ mode: 'copy', sources: muchas }).sources.length, 500);
});

// ------------------------------------------------------------------ paso 1 y petición al motor

test('paso 1: hace falta destino y al menos una carpeta; la petición NUNCA lleva un destino', () => {
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', sources: ['a'] }).ok, false);
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', destination: null, sources: ['a'] }).ok, false);
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', destination: { path: 'D:\\' }, sources: [] }).ok, false);
  assert.equal(W.canGoToReview({ mode: 'copy', verify: 'full', destination: { path: 'D:\\' }, sources: ['a'] }).ok, true);
  for (const s of [
    { mode: 'copy', sources: ['C:\\A'], destination: { path: 'D:\\' } },
    { mode: 'move', sources: ['C:\\A'], recycleChoice: 'borrar', understood: true, destination: 'D:\\' },
    { mode: 'move', sources: ['C:\\A'], recycleChoice: 'dejar' },
  ]) {
    const req = W.buildPreflightRequest(s);
    assert.deepEqual(Object.keys(req).sort(), ['confirmPermanentDelete', 'disposal', 'mode', 'sources', 'verify']);
    assert.doesNotMatch(JSON.stringify(req), /D:\\\\/);
  }
});

test('petición al motor según lo elegido', () => {
  const sources = ['C:\\A'];
  assert.deepEqual(W.buildPreflightRequest({ mode: 'copy', sources }), { mode: 'copy', verify: 'full', disposal: 'ninguna', confirmPermanentDelete: false, sources });
  assert.deepEqual(W.buildPreflightRequest({ mode: 'move', sources }), { mode: 'move', verify: 'full', disposal: 'papelera', confirmPermanentDelete: false, sources });
  assert.deepEqual(W.buildPreflightRequest({ mode: 'move', sources, recycleChoice: 'dejar' }), { mode: 'copy', verify: 'full', disposal: 'ninguna', confirmPermanentDelete: false, sources }, 'dejar el original = solo copiar, verificado por completo');
  assert.deepEqual(W.buildPreflightRequest({ mode: 'move', sources, recycleChoice: 'borrar', understood: true }), { mode: 'move', verify: 'full', disposal: 'borrar', confirmPermanentDelete: true, sources });
});

test('el diálogo no se puede cerrar a medias', () => {
  assert.equal(W.canClose({ running: true }), false);
  assert.equal(W.canClose({ running: false }), true);
  assert.equal(W.canClose({}), true);
  assert.equal(W.canClose(undefined), true);
});

// ------------------------------------------------------------------ formato

test('formatBytes, formatDuration y formatSpeed', () => {
  assert.equal(W.formatBytes(0), '0 bytes');
  assert.match(W.formatBytes(1023), /^1\.?023 bytes$/);
  assert.match(W.formatBytes(1024), /^1 KB$/);
  assert.match(W.formatBytes(1536), /^1,5 KB$/);
  assert.match(W.formatBytes(5 * 1024 ** 3), /^5 GB$/);
  assert.match(W.formatBytes(1.5 * 1024 ** 4), /^1,5 TB$/);
  for (const mal of [-1, NaN, Infinity, null, undefined, '5']) assert.equal(W.formatBytes(mal), '–', String(mal));
  assert.equal(W.formatDuration(0), '0 s');
  assert.equal(W.formatDuration(59), '59 s');
  assert.equal(W.formatDuration(60), '1 min 0 s');
  assert.equal(W.formatDuration(75), '1 min 15 s');
  assert.equal(W.formatDuration(3700), '1 h 1 min');
  for (const mal of [-5, NaN, null, undefined, Infinity]) assert.equal(W.formatDuration(mal), 'calculando…', String(mal));
  assert.equal(W.formatSpeed(1024 * 1024), '1 MB/s');
  for (const mal of [0, -1, NaN, null, undefined]) assert.equal(W.formatSpeed(mal), 'calculando…');
});

test('truncateMiddle: acorta por el medio y conserva el texto completo para el título', () => {
  assert.deepEqual(W.truncateMiddle('corto.txt', 60), { shown: 'corto.txt', full: 'corto.txt' });
  const largo = `C:\\${'carpeta\\'.repeat(20)}archivo-final.bin`;
  const r = W.truncateMiddle(largo, 40);
  assert.equal(r.shown.length, 40);
  assert.ok(r.shown.includes('…'));
  assert.equal(r.full, largo);
  assert.ok(r.shown.endsWith('archivo-final.bin'.slice(-10)));
  assert.deepEqual(W.truncateMiddle(undefined), { shown: '', full: '' });
  assert.deepEqual(W.truncateMiddle(null), { shown: '', full: '' });
});

// ------------------------------------------------------------------ errores en llano

test('translateError: los errores del sistema pasan a lenguaje llano y lo desconocido se dice como tal', () => {
  const casos = [
    ['ENOSPC: no space left on device, write', /No hay espacio/],
    ['EACCES: permission denied, open', /no dio permiso/],
    ['EPERM: operation not permitted, unlink', /no dio permiso/],
    ['EBUSY: resource busy or locked, rm', /en uso/],
    ['ENOENT: no such file or directory', /No se encontró/],
    ['EIO: i/o error', /dejó de responder/],
    ['ENODEV', /dejó de responder/],
    ['EROFS: read-only file system', /solo lectura/],
    ['EEXIST: file already exists', /nunca sobrescribe/],
    ['ENAMETOOLONG', /demasiado larga/],
    ['Windows rechazó enviar a la Papelera (E_ABORT)', /Papelera/],
    ['Ya hay una transferencia en curso', /en curso/],
    ['Remitente no autorizado', /seguridad/],
    ['Plan desconocido: hay que revisar de nuevo antes de ejecutar', /ya no es válida/],
  ];
  for (const [entrada, esperado] of casos) assert.match(W.translateError(entrada), esperado, entrada);
  assert.match(W.translateError(new Error('EACCES: permission denied')), /no dio permiso/);
  assert.equal(W.translateError('algo muy raro'), 'Ocurrió un problema inesperado: algo muy raro');
  for (const vacio of ['', null, undefined]) assert.equal(W.translateError(vacio), 'Ocurrió un problema inesperado.');
  // Una palabra normal que contiene letras de un código no se confunde con él.
  assert.match(W.translateError('Seleccionaste varias carpetas'), /problema inesperado/);
  // Ninguna traducción conserva jerga técnica como «ENOSPC».
  for (const [entrada] of casos.slice(0, 11)) assert.doesNotMatch(W.translateError(entrada), /\bE[A-Z]{3,}\b/);
});

test('cada impedimento del motor tiene un «qué hacer» en llano', () => {
  const { createTransferEngine } = require('../src/core/transfer');
  void createTransferEngine;
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'transfer.js'), 'utf8');
  const codes = [...source.matchAll(/\bblock\('([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.ok(codes.length >= 20);
  const generic = W.blockerAdvice('no-existe-este-codigo');
  assert.equal(generic, 'Corrige eso y vuelve a revisar.');
  for (const code of new Set(codes)) assert.notEqual(W.blockerAdvice(code), generic, `falta el consejo para «${code}»`);
});

// ------------------------------------------------------------------ progreso

test('progreso: fase, porcentaje (completa recorre los bytes dos veces), texto cortado y título completo', () => {
  const ev = { fase: 'copiando', overallBytesDone: 500, totalBytes: 1000, overallFilesDone: 3, totalFiles: 10, archivo: `C:\\${'x\\'.repeat(60)}final.bin`, bytesPerSecond: 2 * 1024 * 1024, etaSeconds: 90 };
  const v = W.progressView(ev, 'full');
  assert.equal(v.phase, 'Copiando');
  assert.equal(v.percent, 25, 'full: 500 de 2000');
  assert.equal(W.progressView(ev, 'quick').percent, 50, 'quick: 500 de 1000');
  assert.equal(v.filesText, '3 de 10 archivos');
  assert.ok(v.currentFile.length <= 60);
  assert.equal(v.currentFileFull, ev.archivo);
  assert.equal(v.speedText, '2 MB/s');
  assert.equal(v.etaText, '1 min 30 s');
  assert.equal(W.progressView({ ...ev, fase: 'verificando' }, 'full').phase, 'Verificando');
  assert.equal(W.progressView({ ...ev, fase: 'retirando original' }, 'full').phase, 'Retirando el original');
  assert.equal(W.progressView({ fase: 'rara' }, 'full').phase, 'Trabajando');
  assert.equal(W.progressView(undefined, 'full').percent, 0);
});

test('progreso: nunca marca 100 % antes de terminar, nunca pasa de 100 ni baja de 0, y los archivos de 0 bytes avanzan', () => {
  assert.equal(W.progressPercent({ fase: 'copiando', overallBytesDone: 5000, totalBytes: 1000 }, 'quick'), 99);
  assert.equal(W.progressPercent({ fase: 'terminado' }, 'full'), 100);
  assert.equal(W.progressPercent({ fase: 'copiando', overallBytesDone: -5, totalBytes: 1000 }, 'full'), 0);
  assert.equal(W.progressPercent({ fase: 'copiando', overallBytesDone: 0, totalBytes: 0, overallFilesDone: 5, totalFiles: 10 }, 'full'), 50);
  assert.equal(W.progressPercent({ fase: 'copiando', totalBytes: 'x' }, 'full'), 0);
  assert.equal(W.progressPercent(null, 'full'), 0);
});

// ------------------------------------------------------------------ resultado

const carpeta = (resultado, extra = {}) => ({ origen: 'C:\\Datos\\A', solicitado: 'C:\\Datos\\A', destino: 'D:\\A', registroId: '0123456789abcdef', resultado, verificada: true, errores: [], ...extra });

test('NUNCA hay titular «Listo» sin el resultado del motor', () => {
  for (const nada of [undefined, null, {}, { carpetas: 'x' }, 'listo']) assert.equal(W.resultHeadline(nada), null, JSON.stringify(nada));
  assert.equal(W.resultHeadline({ carpetas: [carpeta('copiada-verificada')], estado: 'completo' }).tone, 'ok');
  assert.match(W.resultHeadline({ carpetas: [carpeta('copiada-verificada')], estado: 'completo' }).text, /^Listo: 1 carpeta copiada y verificada\./);
});

test('titular según lo que pasó: problemas, cancelación, parada, o solo algunas verificadas', () => {
  const ok = carpeta('copiada-verificada');
  assert.equal(W.resultHeadline({ estado: 'con-errores', carpetas: [ok, carpeta('con-errores', { verificada: false })] }).tone, 'error');
  assert.match(W.resultHeadline({ estado: 'con-errores', carpetas: [ok, carpeta('con-errores', { verificada: false })] }).text, /problemas en 1 carpeta de 2/);
  assert.equal(W.resultHeadline({ estado: 'cancelado', carpetas: [carpeta('cancelada', { verificada: false })] }).tone, 'aviso');
  assert.match(W.resultHeadline({ estado: 'cancelado', carpetas: [carpeta('cancelada', { verificada: false })] }).text, /Los originales no se tocaron/);
  const parada = W.resultHeadline({ estado: 'con-errores', abortada: { message: 'Sin espacio en el destino', code: 'ENOSPC' }, carpetas: [carpeta('con-errores', { verificada: false })] });
  assert.equal(parada.tone, 'error');
  assert.match(parada.text, /se detuvo/);
  assert.equal(W.resultHeadline({ estado: 'completo', carpetas: [carpeta('borrado-parcial')] }).tone, 'error');
  assert.equal(W.resultHeadline({ estado: 'completo', carpetas: [ok, carpeta('original-sin-tocar', { verificada: false })] }).tone, 'aviso');
  // Todas las carpetas del lote están contadas.
  assert.match(W.resultHeadline({ estado: 'completo', carpetas: [ok, ok, ok] }).text, /3 carpetas copiadas y verificadas/);
});

test('cada estado de carpeta tiene icono, etiqueta y explicación (el color nunca va solo)', () => {
  const estados = ['copiada-verificada', 'original-enviado-a-papelera', 'original-borrado-definitivamente', 'borrado-parcial', 'original-sin-tocar', 'con-errores', 'cancelada'];
  const iconos = new Set();
  for (const e of estados) {
    const s = W.folderStatus(carpeta(e));
    assert.ok(s.icon && s.label && s.detail && ['ok', 'aviso', 'error'].includes(s.tone), e);
    iconos.add(`${s.icon}${s.tone}`);
  }
  assert.ok(iconos.size >= 4);
  assert.equal(W.folderStatus(carpeta('copiada-verificada')).label, 'Copiada y verificada');
  assert.match(W.folderStatus(carpeta('original-enviado-a-papelera')).label, /Papelera/);
  assert.match(W.folderStatus(carpeta('original-borrado-definitivamente')).label, /borrado definitivamente/);
  assert.equal(W.folderStatus(carpeta('algo-raro')).label, 'Estado desconocido');
  assert.equal(W.folderStatus(undefined).label, 'Estado desconocido');
});

test('original sin tocar: el motivo se dice en lenguaje llano', () => {
  const k = (codigo, extra = {}) => W.folderStatus(carpeta('original-sin-tocar', { motivoCodigo: codigo, ...extra })).detail;
  assert.match(k('papelera-fallo', { errorPapelera: 'EBUSY: resource busy' }), /No se pudo enviar a la Papelera.*en uso/);
  assert.match(k('papelera-no-cabe'), /no quepa en la Papelera/);
  assert.match(k('origen-cambio'), /cambió/);
  assert.match(k('copia-incompleta'), /ya no está completa/);
  assert.match(k('con-enlaces'), /accesos directos/);
  assert.match(k('protegida'), /protegida/);
  assert.match(k(null, { motivo: 'Pedido: dejar el original donde está' }), /Elegiste dejar el original/);
  assert.match(k(null, { motivo: 'Cancelada antes de retirar el original' }), /Cancelada antes/);
  assert.match(k(null), /se quedó donde estaba/);
});

test('botones del resultado: quitar la copia SOLO tras una copia completa, nunca tras cancelar ni si un original se retiró', () => {
  const lote = (carpetas, extra = {}) => ({ estado: 'completo', carpetas, ...extra });
  const copia = W.resultButtons(lote([carpeta('copiada-verificada')]));
  assert.deepEqual(copia, { openCopy: true, verifyAgain: true, removeCopy: true, deleteAfterRecycleFail: false, needsRescan: false });
  for (const gone of ['original-enviado-a-papelera', 'original-borrado-definitivamente', 'borrado-parcial']) {
    const b = W.resultButtons(lote([carpeta('copiada-verificada'), carpeta(gone)]));
    assert.equal(b.removeCopy, false, `${gone}: la copia es lo único que queda`);
    assert.equal(b.needsRescan, true);
    assert.equal(b.openCopy, true);
  }
  // Cancelada: la app ya limpió sola; NO se ofrece «Quitar la copia» (se vería como un error).
  const canc = W.resultButtons(lote([carpeta('cancelada', { verificada: false, registroId: null, limpieza: { limpia: true, pendientes: [] } })], { estado: 'cancelado' }));
  assert.deepEqual(canc, { openCopy: false, verifyAgain: false, removeCopy: false, deleteAfterRecycleFail: false, needsRescan: false });
  // Una cancelada que no se pudo limpiar: se puede abrir la carpeta provisional que quedó, pero no «quitar».
  const sucia = W.resultButtons(lote([carpeta('cancelada', { verificada: false, registroId: null, limpieza: { limpia: false, pendientes: ['E:\\Fotos.copiando'] } })], { estado: 'cancelado' }));
  assert.equal(sucia.openCopy, true);
  assert.equal(sucia.removeCopy, false);
  assert.equal(W.revealTarget(lote([carpeta('cancelada', { verificada: false, limpieza: { limpia: false, pendientes: ['E:\\Fotos.copiando'] } })], { estado: 'cancelado' })), 'E:\\Fotos.copiando');
  // Original sin tocar por una Papelera fallida: la copia sigue, pero «Quitar» solo se ofrece tras COPIAR.
  assert.equal(W.resultButtons(lote([carpeta('original-sin-tocar', { motivoCodigo: 'papelera-fallo' })])).removeCopy, false);
  assert.deepEqual(W.resultButtons(undefined), { openCopy: false, verifyAgain: false, removeCopy: false, deleteAfterRecycleFail: false, needsRescan: false });
});

test('«borrar definitivamente» aparece SOLO si la Papelera falló y la copia está verificada', () => {
  const lote = (carpetas) => ({ batchFolder: 'D:\\x', carpetas });
  const falla = carpeta('original-sin-tocar', { motivoCodigo: 'papelera-fallo' });
  assert.equal(W.resultButtons(lote([falla])).deleteAfterRecycleFail, true);
  assert.equal(W.resultButtons(lote([carpeta('original-sin-tocar', { motivoCodigo: 'papelera-no-cabe' })])).deleteAfterRecycleFail, true);
  for (const otro of [
    carpeta('original-sin-tocar', { motivoCodigo: 'origen-cambio' }),
    carpeta('original-sin-tocar', { motivoCodigo: 'con-enlaces' }),
    carpeta('original-sin-tocar', { motivoCodigo: null }),
    carpeta('original-sin-tocar', { motivoCodigo: 'papelera-fallo', verificada: false }),
    carpeta('copiada-verificada'),
    carpeta('con-errores', { motivoCodigo: 'papelera-fallo' }),
    carpeta('original-borrado-definitivamente'),
  ]) {
    assert.equal(W.resultButtons(lote([otro])).deleteAfterRecycleFail, false, JSON.stringify(otro.resultado + otro.motivoCodigo));
  }
  assert.deepEqual(W.deletableIndices(lote([carpeta('copiada-verificada'), falla, carpeta('original-sin-tocar', { motivoCodigo: 'papelera-no-cabe' })])), [1, 2]);
  assert.deepEqual(W.deleteTotals({}, [1, 2], { 1: 100, 2: 50 }), { folders: 2, bytes: 150 });
  assert.match(W.deleteConfirmationText(2, 150), /2 carpetas.*150 bytes.*sin pasar por la Papelera.*No se podrá recuperar/);
  assert.match(W.deleteConfirmationText(1, 0), /1 carpeta /);
});

test('carpetas retiradas: se listan las que desaparecieron para quitarlas de las vistas', () => {
  const r = { carpetas: [carpeta('original-enviado-a-papelera', { solicitado: 'C:\\atajo\\A', origen: 'C:\\real\\A' }), carpeta('copiada-verificada', { origen: 'C:\\B', solicitado: 'C:\\B' }), carpeta('original-borrado-definitivamente', { origen: 'C:\\C', solicitado: 'C:\\C' }), carpeta('borrado-parcial', { origen: 'C:\\D', solicitado: 'C:\\D' })] };
  assert.deepEqual(W.removedSources(r), ['C:\\atajo\\A', 'C:\\real\\A', 'C:\\C']);
  assert.deepEqual(W.removedSources(undefined), []);
});

test('verificar una copia: titular y problemas en llano (faltantes, alterados, sobrantes)', () => {
  const ok = W.verifyView({ ok: true, verificados: 12, problemas: [], modo: 'full' });
  assert.equal(ok.tone, 'ok');
  assert.match(ok.headline, /La copia está bien: 12 archivos verificados \(contenido comparado\)/);
  assert.match(W.verifyView({ ok: true, verificados: 1, problemas: [], modo: 'quick' }).headline, /1 archivo verificado \(solo tamaño y fecha\)/);
  const mal = W.verifyView({
    ok: false,
    verificados: 5,
    modo: 'full',
    problemas: [
      { ruta: 'C/A/x.txt', problema: 'falta' },
      { ruta: 'C/A/y.txt', problema: 'huella' },
      { ruta: 'C/A/z.txt', problema: 'sobrante' },
      { ruta: 'C/A/w.txt', problema: 'sin-huella-en-el-manifiesto', aviso: true },
      { ruta: 'C/A/v.txt', problema: 'error-EIO' },
    ],
  });
  assert.equal(mal.tone, 'error');
  assert.equal(mal.headline, 'La copia tiene 4 problemas.');
  assert.deepEqual(mal.counts, { falta: 1, huella: 1, sobrante: 1, 'error-EIO': 1 });
  assert.match(mal.lines.find((l) => l.ruta.endsWith('y.txt')).texto, /alterado/);
  assert.match(mal.lines.find((l) => l.ruta.endsWith('v.txt')).texto, /dejó de responder/);
  const muchos = W.verifyView({ ok: false, verificados: 0, modo: 'full', problemas: Array.from({ length: 80 }, (_, i) => ({ ruta: `f${i}`, problema: 'falta' })) });
  assert.equal(muchos.lines.length, 50);
  assert.equal(muchos.hidden, 30);
  assert.equal(W.verifyView(null), null);
});

// ------------------------------------------- el estado del asistente: nada sobrevive de una operación anterior

test('abrir, cancelar, cerrar, abrir de nuevo y empezar otra operación: NO queda nada de la anterior (ni «Cancelando…»)', () => {
  const items = [{ path: 'C:\\Datos\\Fotos', name: 'Fotos' }];
  // Primera vez: se elige destino, se revisa, se empieza y se CANCELA a mitad.
  let a = W.newWizard('transfer', 'move', items);
  a = W.reduce(a, { type: 'set-destination', destination: { path: 'E:\\', fileSystem: 'exFAT' } });
  a = W.reduce(a, { type: 'review', review: { planId: '0123456789abcdef', blockers: [], warnings: [{ code: 'papelera-no-cabe' }] } });
  a = W.reduce(a, { type: 'recycle-choice', choice: 'borrar' });
  a = W.reduce(a, { type: 'understood', value: true });
  a = W.reduce(a, { type: 'start-operation' });
  a = W.reduce(a, { type: 'progress', event: { fase: 'copiando', overallBytesDone: 500, totalBytes: 1000, overallFilesDone: 1, totalFiles: 3, archivo: 'C:\\Datos\\Fotos\\a.jpg', bytesPerSecond: 1e6, etaSeconds: 30 } });
  a = W.reduce(a, { type: 'cancel' });
  const viewCancelling = W.wizardView(a);
  assert.equal(viewCancelling.notice, 'Cancelando… Los originales no se tocan.');
  assert.equal(viewCancelling.cancelDisabled, true);
  assert.equal(viewCancelling.progress.percent, 25);
  a = W.reduce(a, { type: 'finished', result: { runId: 'aaaaaaaaaaaaaaaa', estado: 'cancelado', carpetas: [] } });
  a = W.reduce(a, { type: 'error', text: 'un error viejo' });
  a = W.reduce(a, { type: 'result-confirm', value: true });
  assert.equal(a.result.estado, 'cancelado');

  // Se cierra y se vuelve a abrir: estado NUEVO (idéntico a uno recién creado).
  const b = W.newWizard('transfer', 'move', items);
  assert.deepEqual(b, W.newWizard('transfer', 'move', items), 'abrir siempre parte de cero');
  assert.equal(b.phase, 'idle');
  assert.equal(b.progress, null);
  assert.equal(b.result, null);
  assert.equal(b.error, '');
  assert.equal(b.recycleChoice, null, 'ninguna opción elegida');
  assert.equal(b.understood, false, 'ninguna confirmación de borrado marcada');
  assert.equal(b.destination, null);
  assert.equal(b.resultConfirm, false);
  const viewNew = W.wizardView(b);
  assert.equal(viewNew.notice, 'Si cancelas, los originales no se tocan.');
  assert.equal(viewNew.cancelDisabled, false);
  assert.equal(viewNew.errorText, '');
  assert.equal(viewNew.showResult, false);
  assert.equal(viewNew.progress.percent, 0);
  assert.equal(viewNew.progress.currentFile, '');

  // Se empieza otra operación: nada de «Cancelando…», ni progreso, ni error, ni resultado de la anterior.
  let c = W.reduce(b, { type: 'set-destination', destination: { path: 'E:\\', fileSystem: 'exFAT' } });
  c = W.reduce(c, { type: 'start-operation' });
  const viewC = W.wizardView(c);
  assert.equal(viewC.notice, 'Si cancelas, los originales no se tocan.');
  assert.doesNotMatch(JSON.stringify(viewC), /Cancelando/);
  assert.equal(viewC.cancelDisabled, false);
  assert.equal(viewC.cancelVisible, true);
  assert.equal(viewC.progress.percent, 0);
  assert.equal(c.progress, null);
  assert.equal(c.error, '');
  assert.equal(c.result, null);

  // Aun dentro del MISMO diálogo, empezar de nuevo después de cancelar reinicia todo lo de la operación.
  let d = W.reduce(W.newWizard('transfer', 'copy', items), { type: 'start-operation' });
  d = W.reduce(d, { type: 'progress', event: { fase: 'copiando', overallBytesDone: 10, totalBytes: 100 } });
  d = W.reduce(d, { type: 'cancel' });
  d = W.reduce(d, { type: 'failed', error: 'algo falló' });
  d = W.reduce(d, { type: 'start-operation' });
  assert.equal(d.phase, 'running');
  assert.equal(d.error, '');
  assert.equal(d.progress, null);
  assert.equal(W.wizardView(d).notice, 'Si cancelas, los originales no se tocan.');
});

test('el estado: cancelar solo vale mientras corre, un progreso tardío no resucita una operación terminada, y terminar limpia elecciones y confirmaciones', () => {
  let s = W.newWizard('transfer', 'move', []);
  assert.equal(W.reduce(s, { type: 'cancel' }).phase, 'idle', 'cancelar sin operación no hace nada');
  assert.equal(W.reduce(s, { type: 'progress', event: { fase: 'copiando' } }).progress, null, 'un aviso de progreso fuera de una operación se ignora');
  s = W.reduce(s, { type: 'recycle-choice', choice: 'borrar' });
  s = W.reduce(s, { type: 'understood', value: true });
  s = W.reduce(s, { type: 'start-operation' });
  s = W.reduce(s, { type: 'finished', result: { runId: 'bbbbbbbbbbbbbbbb', carpetas: [] } });
  assert.equal(s.recycleChoice, null);
  assert.equal(s.understood, false);
  assert.equal(W.reduce(s, { type: 'progress', event: { fase: 'copiando' } }).progress, null, 'ya terminó: el avance tardío no cuenta');
  assert.equal(W.reduce(W.reduce(s, { type: 'recycle-choice', choice: 'dejar' }), { type: 'understood', value: 'true' }).understood, false, 'solo un true verdadero confirma');
  // Elegir «dejar» quita una confirmación de borrado ya marcada.
  const marcada = W.reduce(W.reduce(W.newWizard('transfer', 'move', []), { type: 'recycle-choice', choice: 'borrar' }), { type: 'understood', value: true });
  assert.equal(W.reduce(marcada, { type: 'recycle-choice', choice: 'dejar' }).understood, false);
  // Cambiar el destino invalida la revisión y las elecciones.
  const conRev = W.reduce(W.reduce(marcada, { type: 'review', review: { planId: 'x' } }), { type: 'set-destination', destination: { path: 'F:\\' } });
  assert.equal(conRev.review, null);
  assert.equal(conRev.recycleChoice, null);
  assert.equal(conRev.understood, false);
});

test('aviso de «tardando» a los 15 s sin avance de bytes, con la etapa y los segundos', () => {
  let s = W.reduce(W.newWizard('transfer', 'copy', []), { type: 'start-operation' });
  s = W.reduce(s, { type: 'progress', event: { fase: 'copiando', etapa: 'guardando en el disco', sinAvanceSegundos: 14, overallBytesDone: 0, totalBytes: 100 } });
  assert.equal(W.wizardView(s).stalledNotice, '');
  s = W.reduce(s, { type: 'progress', event: { fase: 'copiando', etapa: 'guardando en el disco', sinAvanceSegundos: 15, overallBytesDone: 0, totalBytes: 100 } });
  assert.equal(W.wizardView(s).stalledNotice, 'El disco o el antivirus está tardando… (etapa: guardando en el disco, hace 15 s)');
  s = W.reduce(s, { type: 'progress', event: { fase: 'copiando', etapa: 'copiando', sinAvanceSegundos: 0, overallBytesDone: 5, totalBytes: 100 } });
  assert.equal(W.wizardView(s).stalledNotice, '', 'al volver a avanzar, el aviso desaparece');
});

test('progreso: textos separados «Copiado X de Y» / «Verificado X de Y» y etapa; la rápida no finge verificar', () => {
  const W = require('../src/shared/transfer-wizard');
  const GB = 1024 ** 3;
  const v = W.progressView({ fase: 'verificando', copiadoBytes: 5.8 * GB, verificadoBytes: 1.4 * GB, totalVerificarBytes: 5.8 * GB, totalBytes: 5.8 * GB, etapa: 'verificando destino' }, 'full');
  assert.match(v.copiedText, /^Copiado 5,8 GB de 5,8 GB$/);
  assert.match(v.verifiedText, /^Verificado 1,4 GB de 5,8 GB$/);
  assert.equal(v.stageText, 'Etapa: verificando destino');
  const q = W.progressView({ fase: 'copiando', copiadoBytes: 10, totalVerificarBytes: 0, totalBytes: 100 }, 'quick');
  assert.match(q.verifiedText, /rápida/);
});

test('resultado forzado por el perro guardián: titular con el aviso exacto, sin botones de copia', () => {
  const W = require('../src/shared/transfer-wizard');
  const r = { estado: 'cancelada', abortada: true, forzada: true, aviso: 'Cancelada a la fuerza porque el disco no respondía. Puede quedar la carpeta «E:\\x.copiando».', carpetas: [] };
  const h = W.resultHeadline(r);
  assert.equal(h.tone, 'error');
  assert.match(h.text, /Cancelada a la fuerza/);
  assert.match(h.text, /x\.copiando/);
});
