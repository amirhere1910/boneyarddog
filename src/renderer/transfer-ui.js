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

  // TODO lo que se ve del asistente sale de este estado (src/shared/transfer-wizard.js: newWizard, reduce, wizardView).
  // Al abrir el diálogo se REEMPLAZA entero por uno nuevo: nada sobrevive de una operación anterior.
  const hooks = { onRemoved: () => {}, onClosed: () => {} };
  let tokenCounter = 0;
  const fresh = (kind, mode, items) => ({ ...W.newWizard(kind, mode, items), open: false, drives: [], totalBytes: null, running: false, token: ++tokenCounter });
  const ui = fresh('transfer', 'copy', []);
  /** Cambia el estado con una acción pura y vuelve a dibujar lo que depende de él. */
  function dispatch(action) {
    Object.assign(ui, W.reduce(ui, action));
    render();
  }
  function replaceState(next) {
    for (const k of Object.keys(ui)) delete ui[k];
    Object.assign(ui, next);
    render();
  }
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
    dispatch({ type: 'error', text });
  }

  /** Dibuja lo que depende del estado: aviso de «Cancelando…», botón de cancelar, barra, tarjetas, error y casillas. */
  function render() {
    const v = W.wizardView(ui, Date.now());
    $('dlg-error').textContent = v.errorText;
    $('dlg-error').hidden = v.errorText === '';
    $('prog-aviso').textContent = v.notice;
    $('dlg-cancelar-op').disabled = v.cancelDisabled;
    const pv = v.progress;
    $('prog-fase').textContent = pv.phase;
    $('prog-barra').setAttribute('aria-valuenow', String(pv.percent));
    $('prog-barra').setAttribute('aria-valuetext', `${pv.phase}, ${pv.percent} %`);
    $('prog-relleno').style.width = `${pv.percent}%`;
    $('prog-porcentaje').textContent = `${pv.percent} %`;
    $('prog-bytes').textContent = pv.copiedText;
    $('prog-verificado').textContent = pv.verifiedText;
    $('prog-etapa').textContent = pv.stageText;
    $('prog-archivos').textContent = pv.filesText;
    $('prog-velocidad').textContent = pv.speedText;
    $('prog-eta').textContent = pv.etaText;
    $('prog-archivo').textContent = pv.currentFile;
    $('prog-archivo').title = pv.currentFileFull;
    $('prog-tardando').textContent = v.stalledNotice;
    $('prog-tardando').hidden = v.stalledNotice === '';
    document.body.dataset.fase = ui.progress && ui.progress.fase ? ui.progress.fase : '';
    // Casillas y opciones: reflejan SIEMPRE el estado (una apertura nueva no hereda marcas viejas).
    $('rev-entiendo').checked = ui.understood === true;
    $('res-entiendo').checked = ui.resultConfirm === true;
    for (const r of document.querySelectorAll('input[name="papelera"]')) r.checked = r.value === ui.recycleChoice;
    for (const r of document.querySelectorAll('input[name="verif"]')) r.checked = r.value === (ui.verify === 'quick' ? 'quick' : 'full');
  }

  function setReason(text) {
    $('dlg-razon').textContent = text || '';
  }

  // ------------------------------------------------------------------ pasos

  const TITLES = { copy: 'Copiar a otro disco', move: 'Transferir a otro disco (mover)' };
  const STEP_LABELS = { destino: 'Paso 1 de 3 · Destino', revision: 'Paso 2 de 3 · Revisión previa', progreso: 'Paso 3 de 3 · Progreso', resultado: 'Resultado' };

  function setStep(step, focusHeading = true) {
    ui.step = step;
    for (const s of ['destino', 'revision', 'progreso', 'resultado', 'copias']) show(`paso-${s}`, s === step);
    $('dlg-titulo').textContent = ui.kind === 'copies' ? 'Copias anteriores' : TITLES[ui.mode];
    $('dlg-paso').textContent = ui.kind === 'copies' ? '' : STEP_LABELS[step] || '';
    updateFooter();
    if (focusHeading) {
      const heading = step === 'resultado' ? $('res-titular') : $('dlg-titulo');
      heading.focus();
    }
  }

  /** Qué botones del pie se ven en cada paso, y cuáles están activos (con su razón a la vista). */
  function updateFooter() {
    const s = ui.step;
    const v = ui.kind === 'copies';
    show('dlg-atras', s === 'revision');
    show('dlg-cancelar', s === 'destino' || s === 'revision');
    show('dlg-siguiente', s === 'destino');
    show('dlg-empezar', s === 'revision');
    show('dlg-cancelar-op', s === 'progreso' && (ui.running || ui.phase !== 'idle'));
    show('dlg-cerrar', (s === 'resultado' && !ui.running) || (v && !ui.running));

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
    }
    setReason(reason);
  }

  // --------------------------------------------------------------- abrir/cerrar

  function resetState(kind, mode, items) {
    replaceState(fresh(kind, mode, items));
    setReason('');
    $('res-borrar').disabled = true;
    for (const id of ['rev-borrar-confirmar', 'rev-papelera', 'res-quitar-confirmar', 'res-verificacion', 'res-papelera-fallo', 'cop-resultado', 'cop-progreso']) show(id, false);
    $('res-aviso-reescanear').hidden = true;
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
    hooks.onClosed();
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
      const head = el('span', 'unidad-cab');
      head.append(el('strong', '', `${d.letter}:`), el('span', 'insignia', d.fileSystem));
      text.append(head, el('span', 'nota', `${driveTypeText(d.driveType)} · ${free}`));
      if (Number.isFinite(d.freeBytes) && Number.isFinite(d.sizeBytes) && d.sizeBytes > 0) {
        const bar = el('span', 'barra-libre');
        bar.setAttribute('aria-hidden', 'true');
        const fill = el('span', 'barra-libre-relleno');
        fill.style.width = `${Math.max(0, Math.min(100, Math.round(((d.sizeBytes - d.freeBytes) / d.sizeBytes) * 100)))}%`; // ocupado
        bar.append(fill);
        text.append(bar);
      }
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('class', 'icono icono-unidad');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '28');
      icon.setAttribute('height', '28');
      icon.setAttribute('aria-hidden', 'true');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '1.6');
      icon.setAttribute('stroke-linecap', 'round');
      icon.setAttribute('stroke-linejoin', 'round');
      const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      shape.setAttribute('d', d.driveType === 'removable' ? 'M9 3h6v5H9zM8 8h8v13H8zM11 12h2' : 'M3 7h18v10H3zM7 12h.01M11 12h6');
      icon.append(shape);
      label.append(icon, radio, text);
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
    dispatch({ type: 'review', review: null });
    dispatch({ type: 'recycle-choice', choice: null });
    dispatch({ type: 'understood', value: false });
  }

  function renderDestination() {
    const d = ui.destination;
    const out = $('dlg-destino-elegido');
    const note = $('dlg-nota-formato');
    if (!d) {
      out.textContent = 'Todavía no elegiste un destino.';
      $('dlg-se-guardara').textContent = '';
      delete out.dataset.ruta;
      note.hidden = true;
    } else {
      const free = d.freeBytes === null ? 'espacio libre desconocido' : `${W.formatBytes(d.freeBytes)} libres`;
      out.textContent = `Destino elegido: ${d.path} (${driveTypeText(d.driveType)}, ${d.fileSystem}, ${free})`;
      out.dataset.ruta = d.path;
      const names = ui.items.map((i) => String(i.path).split(/[\\/]/).filter(Boolean).pop());
      const base = d.path.replace(/[\\/]+$/, '');
      $('dlg-se-guardara').textContent = names.length === 1 ? `Se guardará en: ${base}\\${names[0]}` : `Se guardará en: ${base}\\ (una carpeta por cada origen: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''})`;
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
    dispatch({ type: 'recycle-choice', choice: value });
    renderDeleteConfirmation();
    updateFooter();
  }

  // ---------------------------------------------------------- paso 3: progreso

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
    // Una operación NUEVA parte de cero: se reinicia progreso, «Cancelando…», error, resultado y confirmaciones del resultado.
    dispatch({ type: 'start-operation' });
    setStep('progreso');
    subscribeProgress((ev) => dispatch({ type: 'progress', event: ev, now: Date.now() }));
    const res = await byd.transferRun(planId);
    unsubscribeProgress();
    ui.running = false;
    if (!res.ok) {
      // Sin resultado del motor NO se dice «listo»: se explica que no se pudo saber qué pasó.
      dispatch({ type: 'failed', error: '' });
      showResultUnknown(res.error);
      return;
    }
    dispatch({ type: 'finished', result: res.value });
    ui.verify = runVerify;
    renderResult();
    hooks.onRemoved(W.removedSources(res.value));
  }

  async function cancelOperation() {
    dispatch({ type: 'cancel' });
    $('cop-progreso-texto').textContent = 'Cancelando…';
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
          if (total > errs.length) li.append(el('span', 'res-detalle', `…y ${new Intl.NumberFormat('es').format(total - errs.length)} más.`));
        }
        return li;
      }),
    );
    const target = W.revealTarget(res);
    $('res-lote').textContent = target ? `${res.carpetas.filter((c) => c.verificada).length > 1 ? 'Copias en' : 'Copia en'}: ${res.carpetas.filter((c) => c.verificada).length > 1 ? res.destinoRaiz : target}` : '';
    show('res-lote', Boolean(target));

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
    const res = await byd.revealInExplorer(W.revealTarget(ui.result));
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
    // Cada carpeta copiada tiene su registro (en el PC): se verifica una por una con ese registro.
    const ids = ui.result.carpetas.filter((c) => c.verificada && c.registroId).map((c) => c.registroId);
    let last = null;
    const heads = [];
    for (const id of ids) {
      const res = await byd.copiesVerify(id, { mode: 'full' });
      if (!res.ok) {
        heads.push(`No se pudo verificar: ${W.translateError(res.error)}`);
        continue;
      }
      last = res.value;
      heads.push(W.verifyView(res.value).headline);
    }
    unsubscribeProgress();
    ui.running = false;
    if (last) renderVerification(last, { caja: 'res-verificacion', titular: 'res-verif-titular', lista: 'res-verif-lista' });
    if (ids.length > 1 || !last) $('res-verif-titular').textContent = heads.join(' ');
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
    hooks.onRemoved(W.removedSources(ui.result));
  }

  // ------------------------------------------------------------ copias anteriores

  const kindOf = { full: 'completa', quick: 'rápida (solo tamaño y fecha)' };
  const fate = (o) => ({ papelera: 'el original se envió a la Papelera', 'borrado-definitivo': 'el original se borró definitivamente', 'borrado-parcial': 'el borrado del original quedó a medias', 'sin-tocar': 'el original sigue donde estaba' })[o && o.accion] || '';
  let lastVerify = null;

  async function openCopies() {
    if (ui.open) return;
    resetState('copies', 'copy', []);
    lastVerify = null;
    show('cop-resultado', false);
    show('cop-progreso', false);
    setStep('copias');
    openDialog();
    await renderCopies();
  }

  async function renderCopies() {
    const res = await byd.copiesList();
    const list = $('cop-lista');
    list.replaceChildren();
    if (!res.ok) {
      showError(`No se pudo leer la lista de copias: ${W.translateError(res.error)}`);
      show('cop-vacio', false);
      return;
    }
    show('cop-vacio', res.value.length === 0);
    for (const r of res.value) {
      const li = el('li', 'cop-fila');
      li.dataset.id = r.id;
      const head = el('div', 'cop-cabecera');
      head.append(el('strong', 'cop-nombre', r.nombre), el('span', 'nota', `${new Date(r.fecha).toLocaleString('es')} · ${W.formatBytes(r.totalBytes)} · ${plural(r.archivosTotal, 'archivo', 'archivos')}`));
      li.append(head);
      li.append(el('p', 'ruta', `De: ${r.origen}`), el('p', 'ruta', `A: ${r.destino}`));
      li.append(el('p', 'nota', `Verificación al copiar: ${kindOf[r.verificacion] || r.verificacion} · ${r.sistemaDeArchivos} · ${r.modo === 'move' ? 'transferida' : 'copiada'}${fate(r.original) ? ` · ${fate(r.original)}` : ''}`));
      const actions = el('div', 'fila fila-envuelve');
      const verify = el('button', 'btn-cop-verificar', 'Verificar');
      verify.type = 'button';
      verify.setAttribute('aria-label', `Verificar la copia ${r.nombre}`);
      verify.addEventListener('click', () => verifyCopy(r, verify));
      const drop = el('button', 'secundario btn-cop-quitar', 'Quitar de la lista');
      drop.type = 'button';
      drop.setAttribute('aria-label', `Quitar ${r.nombre} de la lista (no borra la copia)`);
      drop.addEventListener('click', async () => {
        const out = await byd.copiesRemove(r.id);
        if (!out.ok) showError(W.translateError(out.error));
        else renderCopies();
      });
      actions.append(verify, drop);
      li.append(actions);
      list.append(li);
    }
  }

  function showVerification(res, all = false) {
    const view = W.verifyView(res);
    show('cop-resultado', true);
    $('cop-titular').textContent = view.headline;
    $('cop-titular').dataset.tono = view.tone;
    const lines = all ? res.problemas.filter((p) => !p.aviso).slice(0, 2000).map((p) => ({ ruta: p.ruta, texto: W.problemText(p) })) : view.lines;
    $('cop-problemas').replaceChildren(...lines.map((l) => el('li', '', `${l.ruta}: ${l.texto}`)), ...(!all && view.hidden > 0 ? [el('li', 'nota', `…y ${view.hidden} más.`)] : []));
    show('cop-ver-todos', !all && view.hidden > 0);
    $('cop-titular').focus();
  }

  async function verifyCopy(record, button) {
    if (ui.running) return;
    showError('');
    ui.running = true;
    button.disabled = true;
    show('cop-resultado', false);
    show('cop-progreso', true);
    $('cop-relleno').style.width = '0%';
    $('cop-progreso-texto').textContent = `Verificando «${record.nombre}»…`;
    subscribeProgress((ev) => {
      const pct = ev.filesTotal > 0 ? Math.min(99, Math.floor(((ev.filesDone || 0) / ev.filesTotal) * 100)) : 0;
      $('cop-relleno').style.width = `${pct}%`;
      $('cop-relleno').parentElement.setAttribute('aria-valuenow', String(pct));
      $('cop-progreso-texto').textContent = `«${record.nombre}»: ${ev.filesDone || 0} de ${ev.filesTotal || 0} archivos`;
    });
    const res = await byd.copiesVerify(record.id, { mode: 'full' });
    unsubscribeProgress();
    ui.running = false;
    button.disabled = false;
    show('cop-progreso', false);
    if (!res.ok) {
      showError(`No se pudo verificar: ${W.translateError(res.error)}`);
      return;
    }
    lastVerify = res.value;
    showVerification(res.value);
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
  for (const r of document.querySelectorAll('input[name="verif"]')) {
    r.addEventListener('change', () => {
      if (r.checked) dispatch({ type: 'set-verify', verify: r.value });
      updateFooter();
    });
  }
  for (const r of document.querySelectorAll('input[name="papelera"]')) {
    r.addEventListener('change', () => {
      if (r.checked) onRecycleChoice(r.value);
    });
  }
  $('rev-entiendo').addEventListener('change', () => {
    dispatch({ type: 'understood', value: $('rev-entiendo').checked });
    updateFooter();
  });
  $('res-entiendo').addEventListener('change', () => {
    dispatch({ type: 'result-confirm', value: $('res-entiendo').checked });
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
  $('cop-ver-todos').addEventListener('click', () => lastVerify && showVerification(lastVerify, true));
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
      hooks.onClosed();
    }
  });

  window.BYDTransferUI = {
    openWizard,
    openCopies,
    isOpen: () => ui.open,
    isBusy: () => ui.running,
    setHooks: (h) => Object.assign(hooks, h),
  };
})();
