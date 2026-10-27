'use strict';

// Pantalla de prueba de la Fase 2A. La interfaz completa llega en la 2B.
// Solo se usa textContent (nunca se arma HTML con texto): los nombres de archivo no son de fiar.

(() => {
  const byd = window.byd;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('es');

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

  function setState(state) {
    document.body.dataset.estado = state;
    const scanning = state === 'escaneando';
    $('btn-elegir').disabled = scanning;
    $('btn-cancelar').hidden = !scanning;
    $('btn-cancelar').disabled = false;
    $('seccion-progreso').hidden = !scanning;
    $('seccion-resultados').hidden = state !== 'listo';
  }

  function showMessage(text) {
    const el = $('mensaje');
    el.textContent = text;
    el.hidden = text === '';
  }

  function setValue(id, raw, text) {
    const el = $(id);
    el.textContent = text;
    el.dataset.valor = String(raw);
  }

  function dirname(p) {
    const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
    return i > 0 ? p.slice(0, i) : p;
  }

  function renderTable(files) {
    const body = $('tabla-top');
    body.replaceChildren();
    for (const f of files) {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = f.name;
      const where = document.createElement('td');
      where.className = 'ubicacion';
      where.textContent = dirname(f.path);
      const size = document.createElement('td');
      size.className = 'num';
      size.textContent = formatBytes(f.size);
      size.dataset.valor = String(f.size);
      const used = document.createElement('td');
      used.textContent = formatDate(f.lastUsedMs);
      tr.append(name, where, size, used);
      body.append(tr);
    }
  }

  byd.onProgress((p) => {
    if (document.body.dataset.estado !== 'escaneando') return;
    $('progreso-texto').textContent = `${nf.format(p.filesSeen)} archivos revisados · ${formatBytes(p.bytes)}`;
    $('progreso-ruta').textContent = p.currentPath;
  });

  async function scan() {
    showMessage('');
    setState('escaneando');
    $('progreso-texto').textContent = 'Empezando…';
    $('progreso-ruta').textContent = '';

    const started = await byd.startScan();
    if (!started.ok) {
      setState('error');
      showMessage(`No se pudo escanear: ${started.error}`);
      return;
    }
    const summary = started.value;
    if (summary.cancelled) {
      setState('cancelado');
      showMessage('Escaneo cancelado.');
      return;
    }
    if (!summary.hasTree) {
      setState('error');
      showMessage('No se pudo leer la carpeta elegida (no existe o no hay permiso).');
      return;
    }
    const top = await byd.getLargestFiles(10);
    if (!top.ok) {
      setState('error');
      showMessage(`No se pudieron pedir los resultados: ${top.error}`);
      return;
    }

    const { stats } = summary;
    setValue('res-archivos', stats.files, nf.format(stats.files));
    // El escáner cuenta también la carpeta elegida; aquí solo se muestran las de adentro.
    setValue('res-carpetas', Math.max(0, stats.folders - 1), nf.format(Math.max(0, stats.folders - 1)));
    setValue('res-tamano', stats.bytes, formatBytes(stats.bytes));
    setValue('res-omitidos', summary.skippedCount, nf.format(summary.skippedCount));
    $('res-atime').textContent = summary.atimeReliability.message;
    renderTable(top.value);
    setState('listo');
  }

  $('btn-elegir').addEventListener('click', async () => {
    const chosen = await byd.chooseFolder();
    if (!chosen.ok) {
      setState('error');
      showMessage(`No se pudo elegir la carpeta: ${chosen.error}`);
      return;
    }
    if (!chosen.value) return; // se cerró el diálogo sin elegir
    $('carpeta-elegida').textContent = chosen.value.path;
    await scan();
  });

  $('btn-cancelar').addEventListener('click', async () => {
    $('btn-cancelar').disabled = true;
    await byd.cancelScan();
  });

  setState('inicio');
})();
