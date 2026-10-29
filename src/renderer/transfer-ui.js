'use strict';

// Asistente de copiar y transferir (Fase 3B): diálogo de 3 pasos + resultado, y «Verificar una copia
// anterior». Solo se usa textContent (los nombres de archivo no son de fiar). La interfaz NUNCA manda una
// ruta de destino: elige entre las unidades que detecta el proceso principal o abre el diálogo del
// sistema, y después solo dice «usar el destino elegido». Las decisiones (qué se puede hacer en cada
// paso, qué botones se muestran, textos) están en src/shared/transfer-wizard.js, que tiene pruebas.

(() => {
  const byd = window.byd;
  const W = window.BYDTransferWizard;
  const $ = (id) => document.getElementById(id);
  const dlg = $('dlg-transferir');

  const ui = {
    open: false,
    kind: 'transfer', // 'transfer' | 'verify'
    mode: 'copy', // 'copy' | 'move'
    verify: 'full',
    items: [], // [{ path, name }]
    totalBytes: null,
    destination: null, // lo que el principal confirmó: { path, letter, driveType, fileSystem, sizeBytes, freeBytes }
    drives: [],
    step: 'destino', // destino | revision | progreso | resultado | verificar
    review: null,
    recycleChoice: null, // null | 'borrar' | 'dejar'
    understood: false,
    running: false,
    result: null,
    runId: null,
    verifyBatch: null,
    token: 0,
    hooks: { onRemoved: () => {}, onClosed: () => {} },
  };
  let unsubscribe = null;

  const el = (tag, className, text) => {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const show = (id, on) => {
    $(id).hidden = !on;
  };
  const plural = W.plural;

  const DRIVE_TYPES = { removable: 'USB / disco extraíble', fixed: 'Disco duro o SSD', unknown: 'Tipo de disco desconocido' };
  const driveTypeText = (t) => DRIVE_TYPES[t] || DRIVE_TYPES.unknown;

  function showError(text) {
    $('dlg-error').textContent = text;
    $('dlg-error').hidden = text === '';
  }

  function setReason(text) {
    $('dlg-razon').textContent = text || '';
  }

  // ------------------------------------------------------------------ pasos

  const TITLES = { copy: 'Copiar a otro disco', move: 'Transferir a otro disco (mover)' };
  const STEP_LABELS = { destino: 'Paso 1 de 3 · Destino', revision: 'Paso 2 de 3 · Revisión previa', progreso: 'Paso 3 de 3 · Progreso', resultado: 'Resultado' };

  function setStep(step, focusHeading = true) {
    ui.step = step;
    for (const s of ['destino', 'revision', 'progreso', 'resultado', 'verificar']) show(`paso-${s}`, s === step);
    $('dlg-titulo').textContent = ui.kind === 'verify' ? 'Verificar una copia anterior' : TITLES[ui.mode];
    $('dlg-paso').textContent = ui.kind === 'verify' ? '' : STEP_LABELS[step] || '';
    updateFooter();
    if (focusHeading) {
      const heading = step === 'resultado' ? $('res-titular') : $('dlg-titulo');
      heading.focus();
    }
  }

  /** Qué botones del pie se ven en cada paso, y cuáles están activos (con su razón a la vista). */
  function updateFooter() {
    const s = ui.step;
    const v = ui.kind === 'verify';
    show('dlg-atras', s === 'revision');
    show('dlg-cancelar', s === 'destino' || s === 'revision');
    show('dlg-siguiente', s === 'destino');
    show('dlg-empezar', s === 'revision');
    show('dlg-cancelar-op', (s === 'progreso' && ui.running) || (s === 'verificar' && ui.running));
    show('dlg-verificar-ya', v && s === 'verificar' && !ui.running);
    show('dlg-cerrar', (s === 'resultado' && !ui.running) || (v && !ui.running));
    $('dlg-cancelar-op').disabled = false;

    let reason = '';
    if (s === 'destino') {
      const can = W.canGoToReview({ mode: ui.mode, verify: ui.verify, destination: ui.destination, sources: ui.items.map((i) => i.path) });
      $('dlg-siguiente').disabled = !can.ok;
      reason = can.ok ? '' : can.reason;
    } else if (s === 'revision') {
      const can = W.canStart({ mode: ui.mode, review: ui.review, recycleChoice: ui.recycleChoice, understood: ui.understood });
      $('dlg-empezar').disabled = !can.ok || ui.running;
      reason = can.ok ? '' : can.reason;
      $('dlg-atras').disabled = ui.running;
    } else if (s === 'verificar') {
      $('dlg-verificar-ya').disabled = !ui.verifyBatch || ui.running;
      reason = ui.verifyBatch ? '' : 'Elige primero la carpeta de la copia.';
    }
    setReason(reason);
  }

  // --------------------------------------------------------------- abrir/cerrar

  function resetState(kind, mode, items) {
    ui.token++;
    ui.kind = kind;
    ui.mode = mode;
    ui.verify = 'full';
    ui.items = items;
    ui.totalBytes = null;
    ui.destination = null;
    ui.drives = [];
    ui.review = null;
    ui.recycleChoice = null;
    ui.understood = false;
    ui.running = false;
    ui.result = null;
    ui.runId = null;
    ui.verifyBatch = null;
    showError('');
    setReason('');
    for (const r of document.querySelectorAll('input[name="papelera"]')) r.checked = false;
    for (const r of document.querySelectorAll('input[name="verif"]')) r.checked = r.value === 'full';
    $('rev-entiendo').checked = false;
    $('res-entiendo').checked = false;
    $('ver-rapida').checked = false;
    $('res-borrar').disabled = true;
    for (const id of ['rev-borrar-confirmar', 'rev-papelera', 'res-quitar-confirmar', 'res-verificacion', 'res-papelera-fallo', 'ver-resultado', 'ver-progreso']) show(id, false);
  }

  function openDialog() {
    ui.open = true;
    if (!dlg.open) dlg.showModal();
    document.body.dataset.asistente = '1';
  }

  function closeDialog() {
    if (!W.canClose(ui)) return;
    unsubscribeProgress();
    ui.open = false;
    delete document.body.dataset.asistente;
    if (dlg.open) dlg.close();
    ui.hooks.onClosed();
  }

  function subscribeProgress(handler) {
    unsubscribeProgress();
    unsubscribe = byd.onTransferProgress(handler);
  }
  function unsubscribeProgress() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
  }

  // ----------------------------------------------------------- paso 1: destino

  function openWizard(mode, items, totalBytes = null) {
    if (ui.open) return;
    const list = items.slice(0, W.MAX_SOURCES);
    resetState('transfer', mode, list);
    ui.totalBytes = totalBytes;
    $('dlg-resumen-origen').textContent = `${plural(list.length, 'carpeta', 'carpetas')} para ${mode === 'move' ? 'transferir (copiar, verificar y retirar el original)' : 'copiar (el original se queda donde está)'}${totalBytes === null ? '' : ` · ${W.formatBytes(totalBytes)}`}.`;
    $('dlg-unidades').replaceChildren();
    $('dlg-unidades-estado').hidden = false;
    $('dlg-unidades-estado').textContent = 'Buscando unidades…';
    renderDestination();
    renderVerifyOptions();
    setStep('destino');
    openDialog();
    loadDrives();
  }

  async function loadDrives() {
    const mine = ui.token;
    const res = await byd.listDestinationDrives();
    if (mine !== ui.token || ui.kind !== 'transfer') return;
    const box = $('dlg-unidades');
    box.replaceChildren();
    if (!res.ok) {
      $('dlg-unidades-estado').textContent = `No se pudieron buscar las unidades: ${W.translateError(res.error)}`;
      return;
    }
    ui.drives = res.value;
    $('dlg-unidades-estado').hidden = res.value.length > 0;
    if (res.value.length === 0) $('dlg-unidades-estado').textContent = 'No se encontraron unidades. Puedes elegir una carpeta con «Elegir otra carpeta…».';
    for (const d of res.value) {
      const label = el('label', 'opcion');
      const radio = el('input');
      radio.type = 'radio';
      radio.name = 'dest';
      radio.value = d.letter;
      radio.dataset.unidad = d.letter;
      const free = d.freeBytes === null ? 'espacio libre desconocido' : `${W.formatBytes(d.freeBytes)} libres de ${W.formatBytes(d.sizeBytes)}`;
      const text = el('span', 'opcion-texto');
      text.append(el('strong', '', `${d.letter}:`), el('span', 'nota', `${driveTypeText(d.driveType)} · ${d.fileSystem} · ${free}`));
      label.append(radio, text);
      radio.addEventListener('change', () => chooseDrive(d.letter));
      if (ui.destination && ui.destination.letter === d.letter && ui.destination.path === `${d.letter}:\\`) radio.checked = true;
      box.append(label);
    }
  }

  async function chooseDrive(letter) {
    showError('');
    const res = await byd.chooseDestinationDrive(letter);
    if (!res.ok) {
      showError(`No se pudo elegir la unidad: ${W.translateError(res.error)}`);
      return;
    }
    ui.destination = res.value;
    invalidateReview();
    renderDestination();
  }

  async function chooseOther() {
    showError('');
    const res = await byd.chooseDestination();
    if (!res.ok) {
      showError(`No se pudo elegir la carpeta: ${W.translateError(res.error)}`);
      return;
    }
    if (!res.value) return; // se cerró el diálogo del sistema sin elegir
    ui.destination = res.value;
    invalidateReview();
    for (const r of document.querySelectorAll('input[name="dest"]')) r.checked = false;
    renderDestination();
  }

  function invalidateReview() {
    ui.review = null;
    ui.recycleChoice = null;
    ui.understood = false;
  }

  function renderDestination() {
    const d = ui.destination;
    const out = $('dlg-destino-elegido');
    const note = $('dlg-nota-formato');
    if (!d) {
      out.textContent = 'Todavía no elegiste un destino.';
      delete out.dataset.ruta;
      note.hidden = true;
    } else {
      const free = d.freeBytes === null ? 'espacio libre desconocido' : `${W.formatBytes(d.freeBytes)} libres`;
      out.textContent = `Destino elegido: ${d.path} (${driveTypeText(d.driveType)}, ${d.fileSystem}, ${free})`;
      out.dataset.ruta = d.path;
      const notes = [];
      if (d.fileSystem === 'FAT32') notes.push('FAT32 no admite archivos de 4 GB o más. Si hay alguno, la revisión te lo dirá.');
      else if (d.fileSystem === 'desconocido' || d.fileSystem === 'otro') notes.push('No se pudo saber el formato de este disco; se aplicarán reglas cautelosas.');
      note.textContent = notes.join(' ');
      note.hidden = notes.length === 0;
    }
    updateFooter();
  }

  function renderVerifyOptions() {
    const opts = W.verifyOptions(ui.mode);
    const quick = opts.find((o) => o.id === 'quick');
    const radio = $('dlg-verif-rapida');
    radio.disabled = !quick.available;
    radio.closest('.opcion').dataset.desactivada = quick.available ? '0' : '1';
    $('dlg-verif-rapida-nota').textContent = quick.detail;
    if (!quick.available && radio.checked) {
      radio.checked = false;
      document.querySelector('input[name="verif"][value="full"]').checked = true;
      ui.verify = 'full';
    }
  }

  // --------------------------------------------------------- paso 2: revisión

  async function goReview() {
    const can = W.canGoToReview({ mode: ui.mode, verify: ui.verify, destination: ui.destination, sources: ui.items.map((i) => i.path) });
    if (!can.ok) return;
    showError('');
    invalidateReview();
    setStep('revision');
    $('rev-estado').hidden = false;
    $('rev-estado').textContent = 'Revisando las carpetas y el destino…';
    for (const id of ['rev-cifras', 'rev-impedimentos', 'rev-avisos', 'rev-papelera', 'rev-borrar-confirmar', 'rev-papelera-nota']) show(id, false);
    for (const r of document.querySelectorAll('input[name="papelera"]')) r.checked = false;
    $('rev-entiendo').checked = false;
    ui.running = true;
    updateFooter();
    const mine = ui.token;
    const res = await byd.transferPreflight(W.buildPreflightRequest({ mode: ui.mode, verify: ui.verify, sources: ui.items.map((i) => i.path) }));
    ui.running = false;
    if (mine !== ui.token) return;
    if (!res.ok) {
      $('rev-estado').textContent = `No se pudo revisar: ${W.translateError(res.error)}`;
      updateFooter();
      return;
    }
    ui.review = res.value;
    renderReview();
  }

  const WARNING_EXAMPLES = { enlaces: 'enlaces', elementos: 'elementos', origenes: 'carpetas', ejemplos: 'ejemplos', archivos: 'archivos', carpetas: 'carpetas' };

  function listExamples(extra) {
    for (const key of Object.keys(WARNING_EXAMPLES)) {
      const v = extra[key];
      if (!Array.isArray(v) || v.length === 0) continue;
      const names = v.slice(0, 5).map((x) => (typeof x === 'string' ? x : x && (x.ruta || x.path) ? x.ruta || x.path : ''));
      const clean = names.filter(Boolean);
      if (clean.length === 0) continue;
      const total = typeof extra.cantidad === 'number' ? extra.cantidad : v.length;
      return `${clean.join('; ')}${total > clean.length ? ` y ${total - clean.length} más` : ''}`;
    }
    return '';
  }

  function renderReview() {
    const r = ui.review;
    $('rev-estado').hidden = true;
    const plan = r.plan;
    const dest = r.destination;
    const cifras = $('rev-cifras');
    cifras.replaceChildren();
    if (plan) {
      const dirs = plan.sources.length;
      const rows = [
        ['Carpetas', String(dirs)],
        ['Archivos', new Intl.NumberFormat('es').format(plan.totals.files)],
        ['Tamaño total', W.formatBytes(plan.totals.bytes)],
        ['Espacio necesario', dest ? W.formatBytes(dest.requiredBytes) : '–'],
        ['Espacio libre en el destino', dest && dest.freeBytes !== null ? W.formatBytes(dest.freeBytes) : 'desconocido'],
      ];
      for (const [k, v] of rows) {
        const box = el('div');
        box.append(el('dt', '', k), el('dd', '', v));
        cifras.append(box);
      }
      cifras.hidden = false;
    } else if (dest) {
      const box = el('div');
      box.append(el('dt', '', 'Espacio libre en el destino'), el('dd', '', dest.freeBytes !== null ? W.formatBytes(dest.freeBytes) : 'desconocido'));
      cifras.append(box);
      cifras.hidden = false;
    }

    const blockers = W.blockersOf(r);
    show('rev-impedimentos', blockers.length > 0);
    $('rev-impedimentos-lista').replaceChildren(
      ...blockers.map((b) => {
        const li = el('li');
        li.dataset.codigo = b.code;
        li.append(el('span', '', b.message));
        const extra = listExamples(b);
        if (extra) li.append(el('span', 'nota', ` (${extra})`));
        li.append(el('span', 'consejo', `Qué hacer: ${W.blockerAdvice(b.code)}`));
        return li;
      }),
    );

    const shown = (r.warnings || []).filter((w) => w.code !== 'papelera-no-cabe'); // ese tiene su propio bloque
    show('rev-avisos', shown.length > 0);
    $('rev-avisos-lista').replaceChildren(
      ...shown.map((w) => {
        const li = el('li');
        li.dataset.codigo = w.code;
        li.append(el('span', '', w.message));
        const extra = listExamples(w);
        if (extra) li.append(el('span', 'nota', ` (${extra})`));
        return li;
      }),
    );

    const needsChoice = W.needsRecycleChoice(ui.mode, r) && blockers.length === 0;
    show('rev-papelera', needsChoice);
    show('rev-papelera-nota', ui.mode === 'move' && !needsChoice && blockers.length === 0 && Boolean(r.planId));
    renderDeleteConfirmation();
    updateFooter();
    if (blockers.length > 0) $('rev-impedimentos').scrollIntoView({ block: 'nearest' });
  }

  function renderDeleteConfirmation() {
    const on = ui.recycleChoice === 'borrar' && ui.review && ui.review.plan;
    show('rev-borrar-confirmar', Boolean(on));
    if (!on) return;
    // Solo se borran las carpetas sin enlaces, ilegibles ni especiales (las demás conservan su original).
    const deletable = ui.review.plan.sources.filter((s) => !s.links && !s.unreadable && !s.special);
    const bytes = deletable.reduce((sum, s) => sum + s.bytes, 0);
    $('rev-borrar-texto').textContent = W.deleteConfirmationText(deletable.length, bytes);
    $('rev-borrar-confirmar').scrollIntoView({ block: 'nearest' });
  }

  function onRecycleChoice(value) {
    ui.recycleChoice = value;
    if (value !== 'borrar') {
      ui.understood = false;
      $('rev-entiendo').checked = false;
    }
    renderDeleteConfirmation();
    updateFooter();
  }

  // ---------------------------------------------------------- paso 3: progreso

  function renderProgress(ev) {
    const v = W.progressView(ev, ui.mode === 'move' ? 'full' : ui.verify);
    $('prog-fase').textContent = v.phase;
    $('prog-barra').setAttribute('aria-valuenow', String(v.percent));
    $('prog-barra').setAttribute('aria-valuetext', `${v.phase}, ${v.percent} %`);
    $('prog-relleno').style.width = `${v.percent}%`;
    $('prog-porcentaje').textContent = `${v.percent} %`;
    $('prog-bytes').textContent = v.bytesText;
    $('prog-archivos').textContent = v.filesText;
    $('prog-velocidad').textContent = v.speedText;
    $('prog-eta').textContent = v.etaText;
    $('prog-archivo').textContent = v.currentFile;
    $('prog-archivo').title = v.currentFileFull;
    document.body.dataset.fase = ev && ev.fase ? ev.fase : '';
  }

  async function start() {
    const can = W.canStart({ mode: ui.mode, review: ui.review, recycleChoice: ui.recycleChoice, understood: ui.understood });
    if (!can.ok || ui.running) return;
    showError('');
    let planId = ui.review.planId;
    const needsChoice = W.needsRecycleChoice(ui.mode, ui.review);
    ui.running = true;
    updateFooter();
    if (needsChoice) {
      // La elección cambia lo que se le pide al motor: se revisa de nuevo y se usa el plan NUEVO.
      $('dlg-empezar').disabled = true;
      const req = W.buildPreflightRequest({ mode: ui.mode, verify: ui.verify, sources: ui.items.map((i) => i.path), recycleChoice: ui.recycleChoice, understood: ui.understood });
      const again = await byd.transferPreflight(req);
      if (!again.ok) {
        ui.running = false;
        showError(`No se pudo preparar la operación: ${W.translateError(again.error)}`);
        updateFooter();
        return;
      }
      if (req.mode === 'copy' && ui.mode === 'move') ui.mode = 'copy'; // «dejar el original» es solo copiar
      if (W.blockersOf(again.value).length > 0 || !again.value.planId) {
        ui.running = false;
        ui.review = again.value;
        ui.recycleChoice = null;
        ui.understood = false;
        renderReview();
        return;
      }
      planId = again.value.planId;
    }
    const runVerify = W.effectiveVerify(ui.mode, ui.verify);
    setStep('progreso');
    renderProgress({ fase: 'planificando', totalBytes: ui.review.plan ? ui.review.plan.totals.bytes : 0, totalFiles: ui.review.plan ? ui.review.plan.totals.files : 0, overallBytesDone: 0, overallFilesDone: 0 });
    subscribeProgress((ev) => {
      if (ui.step === 'progreso') renderProgress(ev);
    });
    const res = await byd.transferRun(planId);
    unsubscribeProgress();
    ui.running = false;
    if (!res.ok) {
      // Sin resultado del motor NO se dice «listo»: se explica que no se pudo saber qué pasó.
      showResultUnknown(res.error);
      return;
    }
    ui.result = res.value;
    ui.runId = res.value.runId;
    ui.verify = runVerify;
    renderResult();
    ui.hooks.onRemoved(W.removedSources(res.value));
  }

  async function cancelOperation() {
    $('dlg-cancelar-op').disabled = true;
    $('prog-aviso').textContent = 'Cancelando… Los originales no se tocan.';
    $('ver-progreso-texto').textContent = 'Cancelando…';
    await byd.transferCancel();
  }

  // --------------------------------------------------------------- resultado

  function showResultUnknown(error) {
    setStep('resultado');
    const t = $('res-titular');
    t.dataset.tono = 'error';
    t.textContent = 'No se pudo saber cómo terminó la operación.';
    $('res-carpetas').replaceChildren(el('li', '', `${W.translateError(error)} Por seguridad, revisa el destino y, si quieres, usa «Verificar una copia anterior». Los originales no se tocaron.`));
    for (const id of ['res-botones', 'res-papelera-fallo', 'res-quitar-confirmar', 'res-verificacion', 'res-aviso-reescanear']) show(id, false);
    show('res-lote', false);
    updateFooter();
  }

  function renderResult() {
    const res = ui.result;
    setStep('resultado', false);
    const head = W.resultHeadline(res);
    const titular = $('res-titular');
    if (!head) {
      showResultUnknown('Resultado no disponible');
      return;
    }
    titular.textContent = head.text;
    titular.dataset.tono = head.tone;
    titular.focus();

    const list = $('res-carpetas');
    list.replaceChildren(
      ...res.carpetas.map((c, i) => {
        const st = W.folderStatus(c);
        const li = el('li');
        li.dataset.indice = String(i);
        li.dataset.resultado = c.resultado;
        li.dataset.tono = st.tone;
        li.append(el('span', 'res-nombre', c.solicitado || c.origen));
        li.append(el('span', 'res-estado', `${st.icon} ${st.label}`));
        li.append(el('span', 'res-detalle', st.detail));
        if (c.borradoParcial) {
          li.append(el('span', 'res-detalle', `Se borraron ${new Intl.NumberFormat('es').format(c.borradoParcial.borradosTotal)} elementos y quedaron ${new Intl.NumberFormat('es').format(c.borradoParcial.restantesTotal)}: ${c.borradoParcial.restantes.slice(0, 5).join('; ')}${c.borradoParcial.restantesTotal > 5 ? '…' : ''}`));
        }
        const errs = c.errores || [];
        if (errs.length) {
          const ul = el('ul', 'res-errores');
          for (const e of errs.slice(0, 50)) ul.append(el('li', '', `${e.ruta || '(carpeta)'}: ${e.mensaje}`));
          li.append(ul);
          const total = c.erroresTotal || errs.length;
          if (total > errs.length) li.append(el('span', 'res-detalle', `…y ${new Intl.NumberFormat('es').format(total - errs.length)} más. Están todos en MANIFIESTO.json, dentro de la carpeta de la copia.`));
        }
        return li;
      }),
    );
    $('res-lote').textContent = res.batchFolder ? `Copia en: ${res.batchFolder}` : '';
    show('res-lote', Boolean(res.batchFolder));

    const b = W.resultButtons(res);
    show('res-abrir', b.openCopy);
    show('res-verificar', b.verifyAgain);
    show('res-quitar', b.removeCopy);
    show('res-botones', b.openCopy || b.verifyAgain || b.removeCopy);
    show('res-aviso-reescanear', b.needsRescan);
    show('res-quitar-confirmar', false);

    const deletable = W.deletableIndices(res);
    show('res-papelera-fallo', b.deleteAfterRecycleFail);
    if (b.deleteAfterRecycleFail) {
      const bytes = deletable.reduce((sum, i) => sum + (ui.plannedBytes && ui.plannedBytes[i] ? ui.plannedBytes[i] : 0), 0);
      $('res-papelera-cifras').textContent = W.deleteConfirmationText(deletable.length, bytes || ui.review.plan.sources.filter((_, i) => deletable.includes(i)).reduce((s, x) => s + x.bytes, 0));
      $('res-entiendo').checked = false;
      $('res-borrar').disabled = true;
    }
    updateFooter();
  }

  async function revealCopy() {
    const res = await byd.revealInExplorer(ui.result.batchFolder);
    if (!res.ok) showError(`No se pudo abrir el Explorador: ${W.translateError(res.error)}`);
  }

  function renderVerification(res, targetIds) {
    const view = W.verifyView(res);
    const titular = $(targetIds.titular);
    const lista = $(targetIds.lista);
    show(targetIds.caja, true);
    titular.textContent = view.headline;
    titular.dataset.tono = view.tone;
    lista.replaceChildren(
      ...view.lines.map((l) => el('li', '', `${l.ruta}: ${l.texto}`)),
      ...(view.hidden > 0 ? [el('li', 'nota', `…y ${view.hidden} más.`)] : []),
    );
  }

  async function verifyAgain() {
    if (ui.running) return;
    showError('');
    ui.running = true;
    updateFooter();
    show('res-verificacion', true);
    $('res-verif-titular').textContent = 'Verificando la copia…';
    $('res-verif-lista').replaceChildren();
    subscribeProgress((ev) => {
      $('res-verif-titular').textContent = `Verificando la copia… ${ev.filesDone || 0} de ${ev.filesTotal || 0} archivos`;
    });
    const res = await byd.verifyBatchRun({ mode: 'full' });
    unsubscribeProgress();
    ui.running = false;
    if (!res.ok) {
      $('res-verif-titular').textContent = `No se pudo verificar: ${W.translateError(res.error)}`;
      updateFooter();
      return;
    }
    renderVerification(res.value, { caja: 'res-verificacion', titular: 'res-verif-titular', lista: 'res-verif-lista' });
    updateFooter();
  }

  function askRemove() {
    show('res-quitar-confirmar', true);
    $('res-quitar-si').focus();
  }

  async function removeCopy() {
    show('res-quitar-confirmar', false);
    ui.running = true;
    updateFooter();
    const res = await byd.transferRemoveCopy(ui.runId);
    ui.running = false;
    if (!res.ok) {
      showError(`No se pudo quitar la copia: ${W.translateError(res.error)}`);
      updateFooter();
      return;
    }
    const r = res.value;
    const omitted = r.omitidos.length;
    const t = $('res-titular');
    t.dataset.tono = omitted === 0 ? 'ok' : 'aviso';
    t.textContent = omitted === 0 ? `Copia quitada: ${plural(r.quitados, 'elemento borrado', 'elementos borrados')} del destino. Tus originales siguen donde estaban.` : `Copia quitada en parte: ${plural(r.quitados, 'elemento borrado', 'elementos borrados')}; ${plural(omitted, 'se dejó', 'se dejaron')} porque no los creó BoneYardDog o ya no estaban.`;
    for (const id of ['res-botones', 'res-carpetas', 'res-lote', 'res-papelera-fallo', 'res-verificacion']) show(id, false);
    t.focus();
    updateFooter();
  }

  async function deleteAfterFailure() {
    if (ui.running || !$('res-entiendo').checked) return;
    const indices = W.deletableIndices(ui.result);
    if (indices.length === 0) return;
    showError('');
    ui.running = true;
    $('res-borrar').disabled = true;
    updateFooter();
    const res = await byd.transferDeleteFromResult(ui.runId, indices, true);
    ui.running = false;
    if (!res.ok) {
      showError(`No se pudo borrar: ${W.translateError(res.error)}`);
      $('res-borrar').disabled = !$('res-entiendo').checked;
      updateFooter();
      return;
    }
    ui.result = res.value.resumen;
    renderResult();
    ui.hooks.onRemoved(W.removedSources(ui.result));
  }

  // ---------------------------------------------- verificar una copia anterior

  function openVerify() {
    if (ui.open) return;
    resetState('verify', 'copy', []);
    $('ver-elegida').textContent = 'Todavía no elegiste ninguna copia.';
    setStep('verificar');
    openDialog();
  }

  async function chooseBatch() {
    showError('');
    const res = await byd.verifyBatchChooseFolder();
    if (!res.ok) {
      showError(W.translateError(res.error));
      return;
    }
    if (!res.value) return;
    ui.verifyBatch = res.value.path;
    $('ver-elegida').textContent = `Copia elegida: ${res.value.path}`;
    show('ver-resultado', false);
    updateFooter();
  }

  async function runVerifyBatch() {
    if (!ui.verifyBatch || ui.running) return;
    showError('');
    ui.running = true;
    show('ver-resultado', false);
    show('ver-progreso', true);
    $('ver-relleno').style.width = '0%';
    $('ver-progreso-texto').textContent = 'Verificando…';
    updateFooter();
    subscribeProgress((ev) => {
      const pct = ev.filesTotal > 0 ? Math.min(99, Math.floor((ev.filesDone / ev.filesTotal) * 100)) : 0;
      $('ver-relleno').style.width = `${pct}%`;
      $('ver-relleno').parentElement.setAttribute('aria-valuenow', String(pct));
      $('ver-progreso-texto').textContent = `${ev.filesDone || 0} de ${ev.filesTotal || 0} archivos`;
    });
    const res = await byd.verifyBatchRun({ mode: $('ver-rapida').checked ? 'quick' : 'full' });
    unsubscribeProgress();
    ui.running = false;
    show('ver-progreso', false);
    if (!res.ok) {
      showError(`No se pudo verificar: ${W.translateError(res.error)}`);
      updateFooter();
      return;
    }
    renderVerification(res.value, { caja: 'ver-resultado', titular: 'ver-titular', lista: 'ver-lista' });
    $('ver-titular').focus();
    updateFooter();
  }

  // ------------------------------------------------------------------ eventos

  $('dlg-otra-carpeta').addEventListener('click', chooseOther);
  $('dlg-siguiente').addEventListener('click', goReview);
  $('dlg-atras').addEventListener('click', () => {
    if (ui.running) return;
    showError('');
    setStep('destino');
  });
  $('dlg-cancelar').addEventListener('click', closeDialog);
  $('dlg-cerrar').addEventListener('click', closeDialog);
  $('dlg-empezar').addEventListener('click', start);
  $('dlg-cancelar-op').addEventListener('click', cancelOperation);
  $('dlg-verificar-ya').addEventListener('click', runVerifyBatch);
  for (const r of document.querySelectorAll('input[name="verif"]')) {
    r.addEventListener('change', () => {
      if (r.checked) ui.verify = r.value;
      updateFooter();
    });
  }
  for (const r of document.querySelectorAll('input[name="papelera"]')) {
    r.addEventListener('change', () => {
      if (r.checked) onRecycleChoice(r.value);
    });
  }
  $('rev-entiendo').addEventListener('change', () => {
    ui.understood = $('rev-entiendo').checked;
    updateFooter();
  });
  $('res-entiendo').addEventListener('change', () => {
    $('res-borrar').disabled = !$('res-entiendo').checked || ui.running;
  });
  $('res-borrar').addEventListener('click', deleteAfterFailure);
  $('res-abrir').addEventListener('click', revealCopy);
  $('res-verificar').addEventListener('click', verifyAgain);
  $('res-quitar').addEventListener('click', askRemove);
  $('res-quitar-si').addEventListener('click', removeCopy);
  $('res-quitar-no').addEventListener('click', () => {
    show('res-quitar-confirmar', false);
    $('res-quitar').focus();
  });
  $('ver-elegir').addEventListener('click', chooseBatch);
  // Esc cierra el diálogo salvo a mitad de una operación: ahí solo se sale con «Cancelar la operación».
  dlg.addEventListener('cancel', (e) => {
    if (!W.canClose(ui)) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    closeDialog();
  });
  dlg.addEventListener('close', () => {
    // Si el navegador cerró el diálogo por su cuenta (no debería), se sincroniza el estado.
    if (ui.open && W.canClose(ui)) {
      ui.open = false;
      unsubscribeProgress();
      delete document.body.dataset.asistente;
      ui.hooks.onClosed();
    }
  });

  window.BYDTransferUI = {
    openWizard,
    openVerify,
    isOpen: () => ui.open,
    isBusy: () => ui.running,
    setHooks: (hooks) => Object.assign(ui.hooks, hooks),
  };
})();
