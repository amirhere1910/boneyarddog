'use strict';

// Pantalla principal (Fase 2C): mapa de carpetas, lista de candidatas, menú contextual,
// detalles y selección. Solo se usa textContent (nunca se arma HTML con texto que
// venga de nombres de archivo o rutas). La interfaz solo manda rutas que ya recibió
// del servicio; el árbol completo nunca llega aquí.

(() => {
  const byd = window.byd;
  const { activityState, PALETTE, LABELS, STATES } = window.BYDActivity;
  const { layoutFolded } = window.BYDTreemap;
  const TUI = window.BYDTransferUI;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('es');

  const state = {
    settings: null,
    summary: null,
    folder: null,
    token: 0, // cálculos de la lista: se descartan respuestas viejas
    tab: 'mapa',
    map: { path: null, data: null, token: 0 },
    selection: new Map(), // ruta -> nombre
    selToken: 0,
    menu: { open: false, returnTo: null },
    details: { open: false, path: null, returnTo: null, token: 0 },
    transferred: new Set(), // carpetas cuyo original ya se retiró (Papelera o borrado): desaparecen de las vistas
  };

  // ---------------------------------------------------------------- formato

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '–';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    const text = i === 0 ? nf.format(value) : value.toLocaleString('es', { maximumFractionDigits: 1 });
    return `${text} ${units[i]}`;
  }

  function formatDate(ms) {
    return Number.isFinite(ms) ? new Date(ms).toLocaleDateString('es') : '–';
  }

  function plural(n, uno, varios) {
    return `${nf.format(n)} ${n === 1 ? uno : varios}`;
  }

  /** "hace 3 meses", "hace 1 año y 2 meses", "hace 12 días"; sin dato => "sin fecha". */
  function formatUnused(days) {
    if (!Number.isFinite(days)) return 'sin fecha';
    if (days < 30) return `hace ${plural(days, 'día', 'días')}`;
    if (days < 365) return `hace ${plural(Math.floor(days / 30), 'mes', 'meses')}`;
    const years = Math.floor(days / 365);
    const months = Math.floor((days - years * 365) / 30);
    const y = plural(years, 'año', 'años');
    return months > 0 ? `hace ${y} y ${plural(months, 'mes', 'meses')}` : `hace ${y}`;
  }

  /** Un período en palabras: "3 meses", "1 año", "45 días". */
  function formatPeriod(days) {
    const d = Math.round(days);
    if (d >= 365 && d % 365 === 0) return plural(d / 365, 'año', 'años');
    if (d >= 30 && d % 30 === 0) return plural(d / 30, 'mes', 'meses');
    return plural(d, 'día', 'días');
  }

  const periodDays = () => (state.settings ? state.settings.staleDays : 90);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(text, className, onClick, label) {
    const b = el('button', className, text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function dirname(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }

  function showMessage(text) {
    const node = $('mensaje');
    node.textContent = text;
    node.hidden = text === '';
  }

  function setActionNote(text) {
    $('estado-accion').textContent = text;
  }

  // ------------------------------------------------------------------ vistas

  function setState(estado) {
    document.body.dataset.estado = estado;
    $('vista-inicio').hidden = estado === 'escaneando' || estado === 'resultado';
    $('vista-escaneo').hidden = estado !== 'escaneando';
    $('vista-resultado').hidden = estado !== 'resultado';
    if (estado !== 'resultado') {
      closeMenu(false);
      closeDetails(false);
      hideTip();
    }
    updateBar();
  }

  // ---------------------------------------------------------------- pestañas

  const TABS = ['mapa', 'lista'];

  function showTab(name, focus) {
    state.tab = name;
    for (const t of TABS) {
      const tab = $(`tab-${t}`);
      const on = t === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
    }
    document.body.dataset.pestana = name;
    closeMenu(false);
    hideTip();
    if (name === 'mapa') renderMap();
    if (focus) $(`tab-${name}`).focus();
  }

  function onTabKey(e) {
    const i = TABS.indexOf(state.tab);
    let next = null;
    if (e.key === 'ArrowRight') next = TABS[(i + 1) % TABS.length];
    else if (e.key === 'ArrowLeft') next = TABS[(i + TABS.length - 1) % TABS.length];
    else if (e.key === 'Home') next = TABS[0];
    else if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      showTab(next, true);
    }
  }

  // ------------------------------------------------------------ configuración

  function periodPreset(days) {
    return { 30: '30', 90: '90', 180: '180', 365: '365', 730: '730' }[days] || 'custom';
  }

  function ensureOption(select, value, label) {
    if (![...select.options].some((o) => Number(o.value) === value)) {
      const o = el('option', '', label);
      o.value = String(value);
      o.dataset.personalizado = '1';
      select.append(o);
    }
    select.value = String(value);
  }

  function syncControls() {
    const s = state.settings;
    const preset = periodPreset(s.staleDays);
    $('sel-periodo').value = preset;
    $('grupo-custom').hidden = preset !== 'custom';
    if (preset === 'custom') {
      const inMonths = s.staleDays % 30 === 0;
      $('inp-custom').value = String(inMonths ? s.staleDays / 30 : s.staleDays);
      $('sel-unidad-custom').value = inMonths ? 'meses' : 'dias';
    }
    ensureOption($('sel-minimo'), s.minSizeBytes, `Personalizado (${formatBytes(s.minSizeBytes)})`);
    ensureOption($('sel-mapa-min'), s.mapMinBytes, `Personalizado (${formatBytes(s.mapMinBytes)})`);
    $('chk-acceso').checked = s.useAccessTime;
    $('chk-creacion').checked = s.useCreationTime;
    renderIgnored();
    renderLegend();
  }

  async function save(patch) {
    const res = await byd.saveSettings(patch);
    if (!res.ok) {
      showMessage(`No se pudo guardar la configuración: ${res.error}`);
      syncControls();
      return false;
    }
    state.settings = res.value;
    syncControls();
    return true;
  }

  // ------------------------------------------------------ lista de candidatas

  const REASONS = {
    protegido: 'protegidas por el sistema',
    'contiene-protegidos': 'con archivos protegidos dentro',
    'contiene-no-leidos': 'con contenido que no se pudo leer',
    'sin-datos': 'sin datos',
    'excluida-por-usuario': 'ignoradas por ti',
    'contiene-excluidas': 'con una carpeta ignorada dentro',
  };

  function renderItem(item) {
    const li = el('li', 'carpeta');
    li.dataset.ruta = item.path;
    if (state.selection.has(item.path)) li.dataset.seleccionada = '1';

    const head = el('div', 'carpeta-cabecera');
    head.append(el('h3', 'carpeta-nombre', item.name), el('span', 'carpeta-tamano', formatBytes(item.size)));
    head.lastChild.dataset.valor = String(item.size);
    li.append(head);

    li.append(el('p', 'ruta', dirname(item.path)));
    li.append(el('p', 'carpeta-uso', `Sin uso ${formatUnused(item.daysUnused)} · ${plural(item.fileCount, 'archivo', 'archivos')}`));
    if (item.hasLinks) {
      li.append(el('p', 'nota carpeta-enlaces', 'Contiene enlaces (accesos directos del sistema): no se siguen ni se cuentan en el tamaño.'));
    }
    if (item.newestFile) {
      li.append(el('p', 'nota carpeta-reciente', `Archivo más reciente: ${item.newestFile.name} (${formatDate(item.newestFile.ms)})`));
    } else {
      li.append(el('p', 'nota carpeta-reciente', 'Carpeta vacía'));
    }

    const actions = el('div', 'fila');
    actions.append(
      button('Mostrar en el Explorador', 'secundario btn-mostrar', () => reveal(item.path), `Mostrar ${item.name} en el Explorador`),
      button('Ignorar esta carpeta', 'secundario btn-ignorar', () => ignore(item.path), `Ignorar la carpeta ${item.name}`),
    );
    li.append(actions);

    const label = el('label', 'sel');
    const box = el('input', 'chk-sel');
    box.type = 'checkbox';
    box.checked = state.selection.has(item.path);
    box.setAttribute('aria-label', `Seleccionar ${item.name}`);
    box.addEventListener('change', () => setSelected(item.path, item.name, box.checked));
    label.append(box, document.createTextNode(' Seleccionar'));
    li.append(label);
    return li;
  }

  function renderResults(result) {
    const folders = result.count;
    $('res-titulo').textContent = `${plural(folders, 'carpeta', 'carpetas')} sin uso · ${formatBytes(result.totalBytes)}`;
    $('res-titulo').dataset.cantidad = String(folders);
    $('res-titulo').dataset.bytes = String(result.totalBytes);

    const list = $('lista');
    list.replaceChildren(...result.items.filter((i) => !state.transferred.has(i.path)).map(renderItem));
    $('vacio').hidden = result.items.length > 0;
    $('vacio-creacion').hidden = !(result.items.length === 0 && state.settings && state.settings.useCreationTime);
    if (result.truncated) {
      list.append(el('li', 'nota', `Se muestran las ${nf.format(result.items.length)} más grandes de ${nf.format(folders)}.`));
    }

    const parts = Object.entries(result.notOfferedByReason).map(([r, n]) => `${nf.format(n)} ${REASONS[r] || r}`);
    const noOf = $('aviso-no-ofrecidas');
    noOf.hidden = parts.length === 0;
    noOf.textContent = parts.length ? `No se ofrecen, por seguridad: ${parts.join('; ')}.` : '';
  }

  function renderSkipped() {
    const s = state.summary;
    const byKind = (s && s.skippedByKind) || {};
    const denied = byKind.permission || 0;
    const links = byKind.symlink || 0;
    const other = ((s && s.skippedCount) || 0) - denied - links;
    const lines = [];
    if (denied > 0) {
      lines.push(`${plural(denied, 'elemento no se pudo leer', 'elementos no se pudieron leer')} por falta de permisos (esas carpetas no se ofrecen enteras)`);
    }
    if (links > 0) {
      lines.push(`${plural(links, 'enlace', 'enlaces')} sin seguir (las carpetas que contienen enlaces se ofrecen con un aviso; los enlaces no se siguen)`);
    }
    if (other > 0) lines.push(`${plural(other, 'elemento más se omitió', 'elementos más se omitieron')} (tipos especiales u otros)`);
    const note = $('aviso-omitidos');
    note.hidden = lines.length === 0;
    note.textContent = lines.length ? `${lines.join('. ')}.` : '';
  }

  function renderIgnored() {
    const paths = (state.settings && state.settings.excludedPaths) || [];
    $('ignoradas-vacio').hidden = paths.length > 0;
    $('lista-ignoradas').replaceChildren(
      ...paths.map((p) => {
        const li = el('li', 'carpeta ignorada');
        li.dataset.ruta = p;
        li.append(el('span', 'ruta', p));
        li.append(button('Volver a considerar', 'secundario btn-reconsiderar', () => reconsider(p), `Volver a considerar ${p}`));
        return li;
      }),
    );
  }

  /** Recalcula la lista sin volver a escanear. Respuestas viejas se descartan. */
  async function refresh() {
    const mine = ++state.token;
    $('calculando').hidden = false;
    $('lista').setAttribute('aria-busy', 'true');
    const res = await byd.getStaleFolders();
    if (mine !== state.token) return;
    $('calculando').hidden = true;
    $('lista').setAttribute('aria-busy', 'false');
    if (!res.ok) {
      showMessage(`No se pudieron calcular las carpetas: ${res.error}`);
      return;
    }
    showMessage('');
    renderResults(res.value);
  }

  // ----------------------------------------------------------------- acciones

  async function reveal(p) {
    const res = await byd.revealInExplorer(p);
    if (!res.ok) showMessage(`No se pudo mostrar en el Explorador: ${res.error}`);
  }

  async function ignore(p) {
    const res = await byd.excludePath(p);
    if (!res.ok) {
      showMessage(`No se pudo ignorar la carpeta: ${res.error}`);
      return;
    }
    state.settings = res.value;
    syncControls();
    setActionNote('Carpeta ignorada. Puedes volver a considerarla en «Carpetas ignoradas», más abajo.');
    await refresh();
  }

  async function reconsider(p) {
    const res = await byd.includePath(p);
    if (!res.ok) {
      showMessage(`No se pudo volver a considerar la carpeta: ${res.error}`);
      return;
    }
    state.settings = res.value;
    syncControls();
    setActionNote('');
    await refresh();
  }

  async function onPeriodChange() {
    const v = $('sel-periodo').value;
    if (v === 'custom') {
      $('grupo-custom').hidden = false;
      $('inp-custom').focus();
      return;
    }
    if (await save({ staleDays: Number(v) })) {
      await refresh();
      renderMap();
    }
  }

  async function applyCustom() {
    const n = Number($('inp-custom').value);
    const days = $('sel-unidad-custom').value === 'meses' ? n * 30 : n;
    if (!Number.isInteger(n) || days < 7 || days > 3650) {
      showMessage('El período debe estar entre 7 días y 10 años (3650 días).');
      $('inp-custom').focus();
      return;
    }
    showMessage('');
    if (await save({ staleDays: days })) {
      await refresh();
      renderMap();
    }
  }

  // ------------------------------------------------- copiar y transferir (Fase 3B)

  /** Qué carpetas lleva el asistente: toda la selección si incluye la del clic; si no, solo la del clic. */
  function startTransfer(mode, c) {
    let items;
    if (c && state.selection.has(c.path)) items = [...state.selection].map(([path, name]) => ({ path, name }));
    else if (c) items = [{ path: c.path, name: c.name }];
    else items = [...state.selection].map(([path, name]) => ({ path, name }));
    items = items.filter((i) => !state.transferred.has(i.path));
    if (items.length === 0) return;
    if (items.length > 500) items = items.slice(0, 500);
    const total = c && !state.selection.has(c.path) && Number.isFinite(c.size) ? c.size : null;
    TUI.openWizard(mode, items, total);
  }

  /** Tras retirar originales: se quitan de la selección, de la lista y del mapa (marcadas), sin volver a escanear. */
  function onOriginalsRemoved(paths) {
    if (!paths || paths.length === 0) return;
    for (const p of paths) {
      state.transferred.add(p);
      state.selection.delete(p);
    }
    setActionNote(`Se retiró el original de ${plural(paths.length, 'carpeta', 'carpetas')}. Los tamaños del mapa y de la lista se actualizan al volver a escanear.`);
    refresh();
    lastRender = null;
    renderMap();
    refreshSelectionMarks();
    updateBar();
  }

  TUI.setHooks({ onRemoved: onOriginalsRemoved, onClosed: () => { const t = document.querySelector('#barra-seleccion:not([hidden]) #btn-sel-copiar') || $('btn-verificar-copia'); if (t) t.focus(); } });
  $('btn-sel-copiar').addEventListener('click', () => startTransfer('copy', null));
  $('btn-sel-transferir').addEventListener('click', () => startTransfer('move', null));
  $('btn-verificar-copia').addEventListener('click', () => TUI.openVerify());

  // ---------------------------------------------------------------- selección

  const MAX_SELECTION = 500;

  function setSelected(p, name, on) {
    if (on && state.transferred.has(p)) return;
    if (on && !state.selection.has(p) && state.selection.size >= MAX_SELECTION) {
      // Sin perder lo ya marcado: solo se rechaza la que sobra.
      const msg = `Máximo ${MAX_SELECTION} carpetas por operación. Quita alguna para agregar otra.`;
      showMessage(msg);
      setActionNote(msg);
      refreshSelectionMarks();
      return;
    }
    if (on) state.selection.set(p, name);
    else state.selection.delete(p);
    refreshSelectionMarks();
    updateBar();
  }

  function toggleSelected(p, name) {
    setSelected(p, name, !state.selection.has(p));
  }

  function refreshSelectionMarks() {
    for (const c of document.querySelectorAll('#mapa .celda[data-kind="folder"]')) {
      const on = state.selection.has(c.dataset.ruta);
      c.dataset.seleccionada = on ? '1' : '0';
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
      const mark = c.querySelector('.celda-marca-sel');
      if (on && !mark) {
        const m = el('span', 'celda-marca-sel', '✓');
        m.setAttribute('aria-hidden', 'true');
        c.append(m);
      } else if (!on && mark) {
        mark.remove();
      }
    }
    for (const li of document.querySelectorAll('#lista > li.carpeta')) {
      const on = state.selection.has(li.dataset.ruta);
      li.dataset.seleccionada = on ? '1' : '0';
      const box = li.querySelector('.chk-sel');
      if (box) box.checked = on;
    }
  }

  const EXCLUDED_REASONS = {
    protegido: 'protegidas',
    'contiene-protegidos': 'con algo protegido dentro',
    'contiene-no-leidos': 'con contenido sin leer',
    'sin-datos': 'sin datos',
    duplicado: 'repetidas',
    'dentro-de-otro-seleccionado': 'dentro de otra carpeta seleccionada',
  };

  async function updateBar() {
    const bar = $('barra-seleccion');
    const paths = [...state.selection.keys()];
    const mine = ++state.selToken;
    if (paths.length === 0 || document.body.dataset.estado !== 'resultado') {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    $('sel-texto').textContent = `${plural(paths.length, 'carpeta seleccionada', 'carpetas seleccionadas')} · calculando…`;
    const res = await byd.summarizeSelection(paths);
    if (mine !== state.selToken) return;
    if (!res.ok) {
      // La selección NO se borra: solo se avisa que no se pudo calcular el total.
      showMessage(`No se pudo calcular el total de la selección: ${res.error}`);
      $('sel-texto').textContent = `${plural(paths.length, 'carpeta seleccionada', 'carpetas seleccionadas')} · no se pudo calcular el total`;
      return;
    }
    const r = res.value;
    const text = `${plural(paths.length, 'carpeta seleccionada', 'carpetas seleccionadas')} · ${formatBytes(r.totalBytes)}`;
    $('sel-texto').textContent = text;
    $('sel-texto').dataset.cantidad = String(paths.length);
    $('sel-texto').dataset.bytes = String(r.totalBytes);
    const counts = {};
    for (const e of r.excluded) counts[e.reason] = (counts[e.reason] || 0) + 1;
    const parts = Object.entries(counts).map(([reason, n]) => `${nf.format(n)} ${EXCLUDED_REASONS[reason] || reason}`);
    const note = $('sel-excluidas');
    note.hidden = parts.length === 0;
    note.textContent = parts.length ? `${plural(r.excluded.length, 'no cuenta', 'no cuentan')}: ${parts.join('; ')}.` : '';
  }

  // ------------------------------------------------------------------- leyenda

  function renderLegend() {
    if (!state.settings) return;
    const P = periodDays();
    const labels = {
      'muy-reciente': `${LABELS['muy-reciente']} (hasta ${formatPeriod(P / 3)})`,
      reciente: `${LABELS.reciente} (hasta ${formatPeriod(P)})`,
      'sin-movimiento': `${LABELS['sin-movimiento']} (hasta ${formatPeriod(2 * P)})`,
      'muy-antigua': `${LABELS['muy-antigua']} (más de ${formatPeriod(2 * P)})`,
      desconocido: 'Sin fecha',
    };
    $('leyenda-estados').replaceChildren(
      ...STATES.map((s) => {
        const li = el('li');
        li.dataset.estado = s;
        const chip = el('span', 'muestra');
        chip.style.backgroundColor = PALETTE[s].bg;
        chip.setAttribute('aria-hidden', 'true');
        li.append(chip, document.createTextNode(labels[s]));
        return li;
      }),
    );
    const access = state.settings.useAccessTime ? 'La fecha de acceso también cuenta (opción avanzada).' : 'La fecha de acceso se ignora.';
    $('leyenda-texto').textContent = `Movimiento reciente = archivos modificados o copiados en los últimos ${formatPeriod(P)}. ${access}`;
  }

  // --------------------------------------------------------------------- mapa

  const MAP_OPTION = { gap: 4 };

  function cellTitle(c) {
    if (c.kind === 'files') return `Archivos sueltos (${nf.format(c.fileCount)})`;
    if (c.kind === 'others') {
      const n = c.count;
      const what = n > 0 ? plural(n, 'carpeta pequeña', 'carpetas pequeñas') : plural(c.looseFiles, 'archivo suelto pequeño', 'archivos sueltos pequeños');
      return `Otras (${what} · ${formatBytes(c.bytes)})`;
    }
    return c.name;
  }

  function stateText(st) {
    return { 'muy-reciente': 'muy reciente', reciente: 'reciente', 'sin-movimiento': 'sin movimiento', 'muy-antigua': 'muy antigua', desconocido: 'sin fecha' }[st];
  }

  function cellAria(c, st) {
    const parts = [cellTitle(c), formatBytes(c.size), c.daysUnused === null ? 'sin fecha' : `${stateText(st)} ${formatUnused(c.daysUnused)}`];
    if (c.protected) parts.push('protegida por el sistema');
    if (c.unreadable) parts.push('contiene partes que no se pudieron leer');
    if (c.hasLinks) parts.push('contiene enlaces');
    if (state.selection.has(c.path)) parts.push('seleccionada');
    if (state.transferred.has(c.path)) parts.push('ya transferida a otro disco');
    return parts.join(', ');
  }

  let lastRender = null; // { data, width, height, period }: evita redibujar lo que no cambió

  function renderMap(pass = 1, carriedFocus = null) {
    const data = state.map.data;
    const box = $('mapa');
    if (!data || state.tab !== 'mapa') {
      box.replaceChildren();
      $('mapa-aviso').hidden = true;
      lastRender = null;
      return;
    }
    const width = box.clientWidth;
    const height = box.clientHeight;
    if (width <= 0 || height <= 0) return;
    const key = { data, width, height, period: periodDays() };
    if (lastRender && lastRender.data === key.data && lastRender.width === width && lastRender.height === height && lastRender.period === key.period && box.firstChild) return;
    lastRender = key;

    // Si el foco estaba en un cuadro, vuelve al mismo cuadro del dibujo nuevo (teclado).
    const active = document.activeElement;
    const keepFocus = pass === 1 ? (active && box.contains(active) ? active.dataset.indice : null) : carriedFocus;
    box.replaceChildren();
    $('mapa-aviso').hidden = true;

    const noFolders = !data.cells.some((c) => c.kind === 'folder');

    const P = periodDays();
    // Cuadros demasiado chicos (< 20 px de lado o < 500 px²) no se dibujan como botón:
    // se suman al cuadro "Otras" y el mapa se vuelve a calcular con ellos juntos.
    const othersIndex = data.cells.findIndex((c) => c.kind === 'others');
    const OTHERS = othersIndex >= 0 ? String(othersIndex) : 'extra';
    const folding = layoutFolded(
      data.cells.map((c, i) => ({ id: String(i), size: c.size, foldable: c.kind !== 'others' })),
      width,
      height,
      { ...MAP_OPTION, minSide: 20, minArea: 500, othersId: OTHERS },
    );
    const foldedCells = folding.folded.map((id) => data.cells[Number(id)]);
    const cells = data.cells.map((c, i) => ({ cell: c, id: String(i) })).filter((x) => !folding.folded.includes(x.id));
    if (foldedCells.length > 0) {
      const base = othersIndex >= 0 ? data.cells[othersIndex] : null;
      const parts = base ? foldedCells.concat([base]) : foldedCells;
      const bytes = parts.reduce((sum, c) => sum + c.size, 0);
      const dated = parts.filter((c) => c.daysUnused !== null);
      const merged = {
        kind: 'others',
        name: 'Otras',
        size: bytes,
        bytes,
        count: (base ? base.count : 0) + foldedCells.filter((c) => c.kind === 'folder').length,
        looseFiles: (base ? base.looseFiles : 0) + foldedCells.filter((c) => c.kind === 'files').reduce((sum, c) => sum + c.fileCount, 0),
        fileCount: parts.reduce((sum, c) => sum + c.fileCount, 0),
        lastUsedMs: parts.reduce((m, c) => (Number.isFinite(c.lastUsedMs) && (m === null || c.lastUsedMs > m) ? c.lastUsedMs : m), null),
        daysUnused: dated.length ? Math.min(...dated.map((c) => c.daysUnused)) : null,
        protected: false,
        hasLinks: parts.some((c) => c.hasLinks),
        unreadable: parts.some((c) => c.unreadable),
        canEnter: false,
        foldedCount: foldedCells.length,
      };
      const at = cells.findIndex((x) => x.id === OTHERS);
      if (at >= 0) cells[at] = { cell: merged, id: OTHERS };
      else cells.push({ cell: merged, id: OTHERS });
    }
    const byId = new Map(folding.rects.map((r) => [r.id, r]));
    const total = data.folder.size || 1;

    cells.forEach(({ cell: c, id }) => {
      const r = byId.get(id);
      if (!r) return; // tamaño 0: no hay nada que dibujar
      const st = activityState(c.daysUnused, P);
      const tiny = Math.min(r.w, r.h) < 20 || r.w * r.h < 500;
      // Un cuadro invisible nunca recibe foco: si "Otras" quedó diminuto, se dibuja sin botón.
      const b = el(tiny ? 'div' : 'button', 'celda');
      if (!tiny) b.type = 'button';
      else b.setAttribute('aria-hidden', 'true');
      b.style.left = `${r.x}px`;
      b.style.top = `${r.y}px`;
      b.style.width = `${r.w}px`;
      b.style.height = `${r.h}px`;
      b.style.backgroundColor = PALETTE[st].bg;
      b.style.color = PALETTE[st].fg;
      b.dataset.estado = st;
      b.dataset.kind = c.kind;
      b.dataset.bytes = String(c.size);
      b.dataset.indice = id;
      b.dataset.nombre = c.name;
      b.dataset.protegida = c.protected ? '1' : '0';
      if (c.foldedCount) b.dataset.plegadas = String(c.foldedCount);
      if (c.daysUnused !== null) b.dataset.dias = String(c.daysUnused);
      if (c.kind === 'folder') {
        b.dataset.ruta = c.path;
        b.setAttribute('aria-pressed', state.selection.has(c.path) ? 'true' : 'false');
        b.dataset.seleccionada = state.selection.has(c.path) ? '1' : '0';
      }
      if (!tiny) b.setAttribute('aria-label', cellAria(c, st));
      if (c.kind === 'folder' && state.transferred.has(c.path)) {
        b.dataset.transferida = '1';
        b.setAttribute('aria-pressed', 'false');
      }

      if (r.w >= 56 && r.h >= 24) b.append(el('span', 'celda-nombre', state.transferred.has(c.path) ? `${cellTitle(c)} (ya transferida)` : cellTitle(c)));
      if (r.w >= 70 && r.h >= 40) b.append(el('span', 'celda-tam', formatBytes(c.size)));
      if (r.w >= 110 && r.h >= 58 && c.daysUnused !== null) b.append(el('span', 'celda-uso', `Sin uso ${formatUnused(c.daysUnused)}`));
      const marks = [];
      if (c.protected) marks.push('🔒 Protegida');
      if (c.unreadable) marks.push('⚠ No se leyó todo');
      if (c.hasLinks) marks.push('enlaces');
      if (marks.length && r.w >= 90 && r.h >= 74) b.append(el('span', 'celda-marcas', marks.join(' · ')));
      if (state.selection.has(c.path)) {
        const m = el('span', 'celda-marca-sel', '✓');
        m.setAttribute('aria-hidden', 'true');
        b.append(m);
      }

      if (!tiny) {
        b.addEventListener('click', (e) => onCellClick(e, c));
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openMenu(b, c, e.clientX, e.clientY);
        });
        b.addEventListener('keydown', (e) => onCellKey(e, b, c));
        b.addEventListener('focus', () => showTip(b, c, total, st));
        b.addEventListener('blur', hideTip);
      }
      b.addEventListener('mouseenter', () => showTip(b, c, total, st));
      b.addEventListener('mouseleave', hideTip);
      box.append(b);
    });

    // Aviso de lo que quedó agrupado en "Otras" y cómo verlo.
    const othersCell = cells.map((x) => x.cell).find((c) => c.kind === 'others');
    const note = $('mapa-aviso');
    const lines = [];
    if (noFolders) lines.push(`No hay carpetas de más de ${formatBytes(state.settings.mapMinBytes)} aquí. Baja el tamaño mínimo para verlas.`);
    if (othersCell) {
      const what = othersCell.count > 0 ? plural(othersCell.count, 'carpeta pequeña', 'carpetas pequeñas') : plural(othersCell.looseFiles, 'archivo suelto pequeño', 'archivos sueltos pequeños');
      lines.push(`«Otras» agrupa ${what} que suman ${formatBytes(othersCell.bytes)}. Para verlas, entra a la carpeta que las contiene o baja el tamaño mínimo.`);
    }
    note.hidden = lines.length === 0;
    note.textContent = lines.join(' ');

    // El aviso ocupa espacio: si cambió el alto o el ancho disponible, se dibuja otra vez con el tamaño final.
    if (pass < 3 && (box.clientHeight !== height || box.clientWidth !== width)) {
      lastRender = null;
      renderMap(pass + 1, keepFocus);
      return;
    }

    if (keepFocus !== null && keepFocus !== undefined) {
      const again = box.querySelector(`.celda[data-indice="${keepFocus}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function renderBreadcrumbs() {
    const data = state.map.data;
    const ol = $('migas');
    ol.replaceChildren();
    if (!data) return;
    data.breadcrumbs.forEach((crumb, i) => {
      const li = el('li');
      const last = i === data.breadcrumbs.length - 1;
      const b = button(crumb.name, '', () => {
        if (!last) loadMap(crumb.path, true);
      });
      b.dataset.ruta = crumb.path;
      if (last) b.setAttribute('aria-current', 'page');
      li.append(b);
      ol.append(li);
    });
  }

  /** Carga el mapa de una carpeta (el servicio calcula las celdas; aquí solo se dibujan). */
  async function loadMap(folderPath, focusFirst) {
    const mine = ++state.map.token;
    const estado = $('mapa-estado');
    estado.hidden = false;
    estado.textContent = 'Calculando…';
    closeMenu(false);
    hideTip();
    const res = await byd.getTreemap(folderPath, { minBytes: state.settings.mapMinBytes });
    if (mine !== state.map.token) return;
    if (!res.ok) {
      estado.textContent = `No se pudo calcular el mapa: ${res.error}`;
      return;
    }
    estado.hidden = true;
    state.map.path = folderPath;
    state.map.data = res.value;
    document.body.dataset.mapaCarpeta = res.value.folder.path;
    renderBreadcrumbs();
    renderMap();
    $('mapa').setAttribute('aria-label', `Mapa de carpetas por tamaño: ${res.value.folder.name}, ${formatBytes(res.value.totalBytes)}`);
    if (focusFirst) {
      const first = $('mapa').querySelector('.celda');
      if (first) first.focus();
    }
  }

  async function enter(c) {
    if (c.kind === 'folder' && c.canEnter) await loadMap(c.path, true);
  }

  function onCellClick(e, c) {
    if (c.kind !== 'folder') return;
    if (e.ctrlKey || e.metaKey) {
      toggleSelected(c.path, c.name);
      return;
    }
    if (c.canEnter) enter(c);
    else openDetails(c.path, e.currentTarget); // carpeta sin subcarpetas: se muestran sus detalles
  }

  function onCellKey(e, b, c) {
    if (e.key === ' ' && c.kind === 'folder') {
      e.preventDefault();
      toggleSelected(c.path, c.name);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = b.getBoundingClientRect();
      openMenu(b, c, r.left + 12, r.top + 12);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      const parent = state.map.data && state.map.data.parentPath;
      if (parent) loadMap(parent, true);
    }
  }

  // ---------------------------------------------------------- aviso emergente

  function showTip(cellEl, c, total, st) {
    const tip = $('tooltip');
    const lines = [];
    lines.push(['strong', cellTitle(c)]);
    if (c.path) lines.push(['p', c.path]);
    lines.push(['p', `${formatBytes(c.size)} · ${total > 0 ? Math.round((c.size / total) * 1000) / 10 : 0} % de esta carpeta`]);
    lines.push(['p', c.daysUnused === null ? 'Último uso: sin fecha' : `Último uso: ${formatUnused(c.daysUnused)} (${formatDate(c.lastUsedMs)}) · ${stateText(st)}`]);
    if (c.kind === 'others') lines.push(['p', 'Para verlas, entra a la carpeta que las contiene o baja el tamaño mínimo con «Mostrar carpetas de más de».']);
    if (c.protected) lines.push(['p', '🔒 Protegida por el sistema.']);
    if (c.unreadable) lines.push(['p', '⚠ Contiene partes que no se pudieron leer.']);
    if (c.hasLinks) lines.push(['p', 'Contiene enlaces (no se siguen).']);
    tip.replaceChildren(
      ...lines.map(([tag, text]) => {
        const n = el(tag === 'strong' ? 'p' : tag, '', text);
        if (tag === 'strong') n.style.fontWeight = '700';
        return n;
      }),
    );
    tip.hidden = false;
    const r = cellEl.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left + 8;
    let y = r.bottom + 6;
    if (x + tw > window.innerWidth - 8) x = Math.max(8, window.innerWidth - tw - 8);
    if (y + th > window.innerHeight - 8) y = Math.max(8, r.top - th - 6);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    // Detalle del archivo más reciente: se pide solo para carpetas y se agrega si sigue el mismo aviso.
    if (c.kind === 'folder' && !c.newestLoaded) {
      byd.getDetails(c.path).then((res) => {
        c.newestLoaded = true;
        if (!res.ok || tip.hidden || !tip.firstChild || tip.firstChild.textContent !== cellTitle(c)) return;
        const nf2 = res.value.newestFile;
        c.newestFile = nf2;
        tip.append(el('p', '', nf2 ? `Archivo más reciente: ${nf2.name} (${formatDate(nf2.ms)})` : 'Sin archivos con fecha.'));
      });
    } else if (c.newestFile !== undefined) {
      tip.append(el('p', '', c.newestFile ? `Archivo más reciente: ${c.newestFile.name} (${formatDate(c.newestFile.ms)})` : 'Sin archivos con fecha.'));
    }
  }

  function hideTip() {
    $('tooltip').hidden = true;
  }

  // ---------------------------------------------------------- menú contextual

  function menuItems(c) {
    if (c.kind === 'files') {
      return [{ id: 'reveal', text: 'Mostrar en el Explorador' }];
    }
    if (state.transferred.has(c.path)) return [{ id: 'gone', text: 'Ya transferida a otro disco', disabled: true, reason: 'Vuelve a escanear para actualizar el mapa' }];
    const reason = c.protected ? 'Protegida por el sistema' : undefined;
    return [
      { id: 'enter', text: 'Entrar a la carpeta', disabled: !c.canEnter, reason: c.canEnter ? undefined : 'No tiene subcarpetas' },
      { id: 'reveal', text: 'Mostrar en el Explorador' },
      { id: 'details', text: 'Ver detalles' },
      { sep: true },
      { id: 'copy', text: 'Copiar a otro disco…', disabled: Boolean(reason), reason },
      { id: 'move', text: 'Transferir a otro disco (mover)…', disabled: Boolean(reason), reason },
      { sep: true },
      { id: 'ignore', text: 'Ignorar esta carpeta' },
    ];
  }

  function openMenu(cellEl, c, x, y) {
    if (c.kind === 'others') return; // sin menú: su aviso explica qué hacer
    const items = menuItems(c);
    const menu = $('menu-contextual');
    hideTip();
    menu.replaceChildren(
      ...items.map((it) => {
        if (it.sep) {
          const s = el('li');
          s.setAttribute('role', 'separator');
          return s;
        }
        const li = el('li', '', '');
        li.setAttribute('role', 'menuitem');
        li.tabIndex = -1;
        li.dataset.accion = it.id;
        li.append(el('span', 'texto', it.text));
        if (it.reason) li.append(el('span', 'motivo', it.reason));
        if (it.disabled) li.setAttribute('aria-disabled', 'true');
        li.addEventListener('click', () => activate(li, cellEl, c));
        return li;
      }),
    );
    menu.hidden = false;
    state.menu = { open: true, returnTo: cellEl };
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
    const first = menu.querySelector('[role="menuitem"]');
    if (first) first.focus();
  }

  function closeMenu(returnFocus = true) {
    const menu = $('menu-contextual');
    if (!state.menu.open) return;
    menu.hidden = true;
    menu.replaceChildren();
    const target = state.menu.returnTo;
    state.menu = { open: false, returnTo: null };
    if (returnFocus && target) {
      if (document.body.contains(target)) target.focus();
      else {
        const first = $('mapa').querySelector('.celda');
        if (first) first.focus();
      }
    }
  }

  function activate(li, cellEl, c) {
    if (li.getAttribute('aria-disabled') === 'true') return;
    const action = li.dataset.accion;
    closeMenu(action !== 'enter' && action !== 'details');
    if (action === 'enter') enter(c);
    else if (action === 'reveal') reveal(c.kind === 'files' ? state.map.data.folder.path : c.path);
    else if (action === 'details') openDetails(c.path, cellEl);
    else if (action === 'ignore') ignore(c.path);
    else if (action === 'copy' || action === 'move') startTransfer(action, c);
  }

  function onMenuKey(e) {
    const items = [...$('menu-contextual').querySelectorAll('[role="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(i + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + items.length - 1) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1].focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const cell = state.menu.returnTo;
      const li = document.activeElement;
      if (li && cell) activate(li, cell, state.map.data.cells[Number(cell.dataset.indice)]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      closeMenu(true);
    }
  }

  // ---------------------------------------------------------------- detalles

  const BUCKETS = [
    ['hasta30', 'Hasta 30 días', 'muy-reciente'],
    ['hasta90', '31 a 90 días', 'reciente'],
    ['hasta180', '91 a 180 días', 'sin-movimiento'],
    ['hasta365', '181 a 365 días', 'muy-antigua'],
    ['mas365', 'Más de un año', 'muy-antigua'],
    ['desconocido', 'Sin fecha', 'desconocido'],
  ];

  async function openDetails(p, returnTo) {
    const mine = ++state.details.token;
    const res = await byd.getDetails(p);
    if (mine !== state.details.token) return;
    if (!res.ok) {
      showMessage(`No se pudieron cargar los detalles: ${res.error}`);
      return;
    }
    const d = res.value;
    state.details = { open: true, path: d.path, returnTo: returnTo || document.activeElement, token: mine };
    $('panel-detalles').hidden = false;
    $('mapa-zona').classList.add('con-detalles');
    $('det-titulo').textContent = `Detalles: ${d.name}`;

    const rows = [
      ['Nombre', d.name],
      ['Ruta', d.path],
      ['Tipo', d.type === 'folder' ? 'Carpeta' : 'Archivo'],
      ['Tamaño', formatBytes(d.size)],
      ['Archivos', nf.format(d.fileCount)],
    ];
    if (d.type === 'folder') rows.push(['Subcarpetas', nf.format(d.folderCount)]);
    rows.push(['Último uso', d.daysUnused === null ? 'sin fecha' : `${formatUnused(d.daysUnused)} (${formatDate(d.lastUsedMs)})`]);
    rows.push(['Archivo más reciente', d.newestFile ? `${d.newestFile.name} (${formatDate(d.newestFile.ms)})` : 'sin fecha']);
    const marks = [];
    if (d.protected) marks.push('Protegida por el sistema');
    if (d.containsProtected) marks.push('Contiene elementos protegidos');
    if (d.hasLinks) marks.push('Contiene enlaces (no se siguen)');
    if (d.unreadable) marks.push('Contiene partes que no se pudieron leer');
    rows.push(['Avisos', marks.length ? marks.join('; ') : 'ninguno']);
    $('det-lista').replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = el('dt', '', k);
        const dd = el('dd', '', v);
        dd.dataset.campo = k;
        return [dt, dd];
      }),
    );
    $('det-lista').dataset.bytes = String(d.size);
    $('det-lista').dataset.archivos = String(d.fileCount);
    $('det-lista').dataset.subcarpetas = String(d.folderCount);

    const totalBytes = BUCKETS.reduce((s, [k]) => s + d.ageBuckets[k].bytes, 0);
    const bar = $('det-barra');
    bar.replaceChildren();
    const tramos = $('det-tramos');
    tramos.replaceChildren();
    for (const [key, label, st] of BUCKETS) {
      const b = d.ageBuckets[key];
      const pct = totalBytes > 0 ? (b.bytes / totalBytes) * 100 : 0;
      if (b.bytes > 0) {
        const seg = el('div');
        seg.style.width = `${pct}%`;
        seg.style.backgroundColor = PALETTE[st].bg;
        bar.append(seg);
      }
      const li = el('li');
      li.dataset.tramo = key;
      li.dataset.bytes = String(b.bytes);
      const chip = el('span', 'muestra');
      chip.style.backgroundColor = PALETTE[st].bg;
      chip.setAttribute('aria-hidden', 'true');
      li.append(chip, document.createTextNode(`${label}: ${Math.round(pct * 10) / 10} % (${formatBytes(b.bytes)}, ${plural(b.files, 'archivo', 'archivos')})`));
      tramos.append(li);
    }
    bar.setAttribute('aria-label', `Antigüedad del contenido: ${BUCKETS.map(([k, l]) => `${l} ${totalBytes > 0 ? Math.round((d.ageBuckets[k].bytes / totalBytes) * 100) : 0} %`).join(', ')}`);

    $('det-sub-vacio').hidden = d.topSubfolders.length > 0;
    $('det-subcarpetas').replaceChildren(
      ...d.topSubfolders.map((s) => {
        const li = el('li');
        li.dataset.ruta = s.path;
        li.append(el('span', '', `${s.name} · ${formatBytes(s.size)}`));
        li.append(button('Mostrar en el Explorador', 'secundario', () => reveal(s.path), `Mostrar ${s.name} en el Explorador`));
        return li;
      }),
    );
    $('btn-det-explorador').onclick = () => reveal(d.path);
    $('det-titulo').focus();
  }

  function closeDetails(returnFocus = true) {
    if (!state.details.open) return;
    state.details.open = false;
    state.details.token++;
    $('panel-detalles').hidden = true;
    $('mapa-zona').classList.remove('con-detalles');
    const target = state.details.returnTo;
    if (returnFocus && target && document.body.contains(target)) target.focus();
    renderMapSoon();
  }

  // ------------------------------------------------------------------ escaneo

  byd.onProgress((p) => {
    if (document.body.dataset.estado !== 'escaneando') return;
    $('progreso-texto').textContent = `${nf.format(p.filesSeen)} archivos revisados · ${formatBytes(p.bytes)}`;
    $('progreso-ruta').textContent = p.currentPath;
  });

  async function scan(chosen) {
    showMessage('');
    setActionNote('');
    state.folder = chosen.path;
    $('progreso-texto').textContent = 'Empezando…';
    $('progreso-ruta').textContent = '';
    setState('escaneando');
    $('btn-cancelar').disabled = false;

    const started = await byd.startScan();
    if (!started.ok) {
      setState('inicio');
      showMessage(`No se pudo escanear: ${started.error}`);
      return;
    }
    const summary = started.value;
    if (summary.cancelled) {
      setState('inicio');
      showMessage('Escaneo cancelado.');
      return;
    }
    if (!summary.hasTree) {
      setState('inicio');
      showMessage('No se pudo leer la carpeta elegida (no existe o no hay permiso).');
      return;
    }
    state.summary = summary;
    state.selection.clear(); // la selección es de UN escaneo
    state.transferred.clear();
    state.map = { path: null, data: null, token: state.map.token + 1 };
    $('res-carpeta').textContent = state.folder;
    $('res-atime').textContent = summary.atimeReliability.message;
    renderSkipped();
    setState('resultado');
    showTab('mapa');
    await Promise.all([refresh(), loadMap(summary.rootPath, false)]);
    $('tab-mapa').focus();
  }

  async function chooseFolder() {
    const res = await byd.chooseFolder();
    if (!res.ok) return showMessage(`No se pudo elegir la carpeta: ${res.error}`);
    if (!res.value) return undefined; // se cerró el diálogo sin elegir
    return scan(res.value);
  }

  async function chooseDrive(letter) {
    const res = await byd.chooseDrive(letter);
    if (!res.ok) return showMessage(`No se pudo elegir la unidad: ${res.error}`);
    return scan(res.value);
  }

  async function renderDrives() {
    const box = $('unidades');
    const res = await byd.listDrives();
    box.replaceChildren();
    if (!res.ok) return;
    for (const d of res.value) {
      const b = button(`Escanear ${d.letter}:`, 'btn-unidad', () => chooseDrive(d.letter), `Escanear la unidad ${d.letter}:`);
      b.dataset.unidad = d.letter;
      box.append(b);
    }
    box.hidden = res.value.length === 0;
  }

  // -------------------------------------------------------------------- inicio

  let resizeTimer = null;
  function renderMapSoon() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderMap, 120);
  }
  new ResizeObserver(renderMapSoon).observe($('mapa-contenedor'));

  $('btn-elegir').addEventListener('click', chooseFolder);
  $('btn-cancelar').addEventListener('click', async () => {
    $('btn-cancelar').disabled = true;
    await byd.cancelScan();
  });
  $('btn-nuevo').addEventListener('click', async () => {
    showMessage('');
    setState('inicio');
    await renderDrives();
  });
  $('tab-mapa').addEventListener('click', () => showTab('mapa'));
  $('tab-lista').addEventListener('click', () => showTab('lista'));
  $('tab-mapa').addEventListener('keydown', onTabKey);
  $('tab-lista').addEventListener('keydown', onTabKey);
  $('sel-periodo').addEventListener('change', onPeriodChange);
  $('btn-custom').addEventListener('click', applyCustom);
  $('inp-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCustom();
  });
  $('sel-minimo').addEventListener('change', async () => {
    if (await save({ minSizeBytes: Number($('sel-minimo').value) })) await refresh();
  });
  $('sel-mapa-min').addEventListener('change', async () => {
    if (await save({ mapMinBytes: Number($('sel-mapa-min').value) }) && state.map.path) await loadMap(state.map.path, false);
  });
  $('chk-acceso').addEventListener('change', async () => {
    if (await save({ useAccessTime: $('chk-acceso').checked })) {
      await Promise.all([refresh(), state.map.path ? loadMap(state.map.path, false) : null]);
    }
  });
  $('chk-creacion').addEventListener('change', async () => {
    if (await save({ useCreationTime: $('chk-creacion').checked })) {
      await Promise.all([refresh(), state.map.path ? loadMap(state.map.path, false) : null]);
    }
  });
  $('btn-abrir-explorador').addEventListener('click', () => {
    if (state.map.data) reveal(state.map.data.folder.path);
  });
  $('btn-cerrar-detalles').addEventListener('click', () => closeDetails(true));
  $('btn-sel-limpiar').addEventListener('click', () => {
    state.selection.clear();
    refreshSelectionMarks();
    updateBar();
  });
  $('menu-contextual').addEventListener('keydown', onMenuKey);
  document.addEventListener('mousedown', (e) => {
    if (state.menu.open && !$('menu-contextual').contains(e.target)) closeMenu(false);
  });
  window.addEventListener('blur', () => closeMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (state.menu.open) {
      closeMenu(true);
      return;
    }
    hideTip(); // el aviso emergente es pasajero: Esc lo oculta y además cierra los detalles si están abiertos
    if (state.details.open) closeDetails(true);
  });

  (async () => {
    setState('inicio');
    const res = await byd.getSettings();
    if (!res.ok) {
      showMessage(`No se pudo leer la configuración: ${res.error}`);
      return;
    }
    state.settings = res.value;
    syncControls();
    await renderDrives();
    document.body.dataset.listo = '1'; // la interfaz terminó de iniciar (lo usa la prueba automática)
  })();
})();
