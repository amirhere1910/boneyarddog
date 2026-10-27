'use strict';

// Pantalla principal (Fase 2B). Solo se usa textContent: nunca se arma HTML con
// texto que venga de nombres de archivo o rutas. La interfaz solo manda rutas
// que ya recibió del servicio; el árbol completo nunca llega aquí.

(() => {
  const byd = window.byd;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('es');
  const MB = 1024 * 1024;

  const state = {
    settings: null,
    summary: null,
    folder: null,
    token: 0, // descarta respuestas de cálculos que ya no son los últimos
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

  /** "sin uso hace 3 meses", "hace 1 año y 2 meses", "hace 12 días". */
  function formatUnused(days) {
    if (days < 30) return `hace ${plural(days, 'día', 'días')}`;
    if (days < 365) return `hace ${plural(Math.floor(days / 30), 'mes', 'meses')}`;
    const years = Math.floor(days / 365);
    const months = Math.floor((days - years * 365) / 30);
    const y = plural(years, 'año', 'años');
    return months > 0 ? `hace ${y} y ${plural(months, 'mes', 'meses')}` : `hace ${y}`;
  }

  // ------------------------------------------------------------------ vistas

  function setState(estado) {
    document.body.dataset.estado = estado;
    $('vista-inicio').hidden = estado === 'escaneando' || estado === 'resultado';
    $('vista-escaneo').hidden = estado !== 'escaneando';
    $('vista-resultado').hidden = estado !== 'resultado';
  }

  function showMessage(text) {
    const el = $('mensaje');
    el.textContent = text;
    el.hidden = text === '';
  }

  function dirname(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }

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

  // ------------------------------------------------------------ configuración

  function periodLabelFor(days) {
    return { 30: '30', 90: '90', 180: '180', 365: '365', 730: '730' }[days] || 'custom';
  }

  function syncControls() {
    const s = state.settings;
    const preset = periodLabelFor(s.staleDays);
    $('sel-periodo').value = preset;
    $('grupo-custom').hidden = preset !== 'custom';
    if (preset === 'custom') {
      const inMonths = s.staleDays % 30 === 0;
      $('inp-custom').value = String(inMonths ? s.staleDays / 30 : s.staleDays);
      $('sel-unidad-custom').value = inMonths ? 'meses' : 'dias';
    }

    const min = $('sel-minimo');
    // Una opción personalizada (valor de la configuración que no es de la lista) se queda una vez creada.
    if (![...min.options].some((o) => Number(o.value) === s.minSizeBytes)) {
      const o = el('option', '', `Personalizado (${formatBytes(s.minSizeBytes)})`);
      o.value = String(s.minSizeBytes);
      o.dataset.personalizado = '1';
      min.append(o);
    }
    min.value = String(s.minSizeBytes);

    $('chk-acceso').checked = s.useAccessTime;
    $('chk-creacion').checked = s.useCreationTime;
    renderIgnored();
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

  // -------------------------------------------------------- lista de carpetas

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
    return li;
  }

  function renderResults(result) {
    const folders = result.count;
    $('res-titulo').textContent = `${plural(folders, 'carpeta', 'carpetas')} sin uso · ${formatBytes(result.totalBytes)}`;
    $('res-titulo').dataset.cantidad = String(folders);
    $('res-titulo').dataset.bytes = String(result.totalBytes);

    const list = $('lista');
    list.replaceChildren(...result.items.map(renderItem));
    $('vacio').hidden = result.items.length > 0;
    $('vacio-creacion').hidden = !(result.items.length === 0 && state.settings && state.settings.useCreationTime);
    if (result.truncated) {
      const extra = el('li', 'nota', `Se muestran las ${nf.format(result.items.length)} más grandes de ${nf.format(folders)}.`);
      list.append(extra);
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
    await refresh();
  }

  async function onPeriodChange() {
    const v = $('sel-periodo').value;
    if (v === 'custom') {
      $('grupo-custom').hidden = false;
      $('inp-custom').focus();
      return;
    }
    if (await save({ staleDays: Number(v) })) await refresh();
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
    if (await save({ staleDays: days })) await refresh();
  }

  // ------------------------------------------------------------------ escaneo

  byd.onProgress((p) => {
    if (document.body.dataset.estado !== 'escaneando') return;
    $('progreso-texto').textContent = `${nf.format(p.filesSeen)} archivos revisados · ${formatBytes(p.bytes)}`;
    $('progreso-ruta').textContent = p.currentPath;
  });

  async function scan(chosen) {
    showMessage('');
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
    $('res-carpeta').textContent = state.folder;
    $('res-atime').textContent = summary.atimeReliability.message;
    renderSkipped();
    setState('resultado');
    await refresh();
    $('res-titulo').focus();
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
  $('sel-periodo').addEventListener('change', onPeriodChange);
  $('btn-custom').addEventListener('click', applyCustom);
  $('inp-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCustom();
  });
  $('sel-minimo').addEventListener('change', async () => {
    if (await save({ minSizeBytes: Number($('sel-minimo').value) })) await refresh();
  });
  $('chk-acceso').addEventListener('change', async () => {
    if (await save({ useAccessTime: $('chk-acceso').checked })) await refresh();
  });
  $('chk-creacion').addEventListener('change', async () => {
    if (await save({ useCreationTime: $('chk-creacion').checked })) await refresh();
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
