'use strict';

// «Ayuda y pruebas»: crear y borrar los datos de prueba, y mostrar la versión. La interfaz NUNCA manda una
// ruta: la carpeta (Documentos\BoneYardDog-Prueba) la conoce y la fija el proceso principal. Solo textContent.

(() => {
  const byd = window.byd;
  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat('es');
  const mb = (n) => `${nf.format(Math.round(n / (1024 * 1024)))} MB`;
  const show = (id, on) => {
    $(id).hidden = !on;
  };
  let busy = false;
  let exists = false;

  function setNote(text) {
    $('td-estado').textContent = text;
  }

  function render() {
    show('td-crear', !exists && !busy);
    show('td-cancelar', busy);
    show('td-escanear', exists && !busy);
    show('td-borrar', exists && !busy);
    show('td-progreso', busy);
    $('td-crear').disabled = busy;
  }

  /** `keepNote`: solo actualiza los botones y deja el mensaje que ya hay (por ejemplo «Listo: …»). */
  async function refreshStatus(keepNote = false) {
    const res = await byd.testDataStatus();
    if (!res.ok) {
      setNote(`No se pudo mirar la carpeta de pruebas: ${res.error}`);
      return;
    }
    exists = res.value.exists;
    if (keepNote) {
      if (exists && !res.value.marked) {
        show('td-escanear', false);
        show('td-borrar', false);
        show('td-crear', false);
        return;
      }
      render();
      return;
    }
    if (!exists) setNote('Todavía no hay datos de prueba.');
    else if (res.value.marked) setNote('Ya hay datos de prueba creados por BoneYardDog. Puedes escanearlos o borrarlos.');
    else setNote('Hay una carpeta llamada «BoneYardDog-Prueba» que NO es de la app (no tiene su marca): no se tocará.');
    if (exists && !res.value.marked) {
      show('td-escanear', false);
      show('td-borrar', false);
      show('td-crear', false);
      return;
    }
    render();
  }

  async function create() {
    if (busy) return;
    busy = true;
    $('td-relleno').style.width = '0%';
    $('td-progreso-texto').textContent = 'Preparando…';
    render();
    setNote('Creando datos de prueba…');
    const off = byd.onTestDataProgress((p) => {
      const pct = p.bytesTotal > 0 ? Math.min(99, Math.floor((p.bytesDone / p.bytesTotal) * 100)) : 0;
      $('td-relleno').style.width = `${pct}%`;
      $('td-relleno').parentElement.setAttribute('aria-valuenow', String(pct));
      $('td-progreso-texto').textContent = `${mb(p.bytesDone)} de ${mb(p.bytesTotal)} · ${nf.format(p.filesDone)} de ${nf.format(p.filesTotal)} archivos`;
    });
    const res = await byd.testDataCreate();
    off();
    busy = false;
    if (!res.ok) {
      setNote(/Creación cancelada/.test(res.error) ? 'Creación cancelada. No quedó nada.' : `No se crearon los datos de prueba: ${res.error}`);
      await refreshStatus(true);
      return;
    }
    setNote(`Listo: ${nf.format(res.value.folders)} carpetas, ${nf.format(res.value.files)} archivos, ${mb(res.value.bytes)}, en ${res.value.path}. Ya puedes escanearlas.`);
    await refreshStatus(true);
    $('td-escanear').focus();
  }

  async function scanTestData() {
    const settings = window.BYDApp.getSettings();
    if ($('td-ignorar-creacion').checked && settings && settings.useCreationTime) {
      const saved = await byd.saveSettings({ useCreationTime: false });
      if (!saved.ok) {
        window.BYDApp.showMessage(`No se pudo ignorar la fecha de creación: ${saved.error}`);
        return;
      }
      window.BYDApp.setSettings(saved.value);
    }
    const res = await byd.testDataUse();
    if (!res.ok) {
      window.BYDApp.showMessage(`No se pudo preparar el escaneo: ${res.error}`);
      return;
    }
    await window.BYDApp.scan(res.value);
  }

  async function remove() {
    show('td-borrar-confirmar', false);
    const res = await byd.testDataDelete({ confirm: true, removeCopies: $('td-quitar-copias').checked });
    if (!res.ok) {
      setNote(`No se borró nada: ${res.error}`);
      await refreshStatus(true);
      return;
    }
    const c = res.value.copias;
    const copies = c.quitadas || c.rechazadas.length ? ` Copias quitadas: ${c.quitadas}${c.rechazadas.length ? `; no se pudieron quitar ${c.rechazadas.length} (${c.rechazadas[0].motivo})` : ''}.` : '';
    setNote(`Datos de prueba borrados.${copies}`);
    await refreshStatus(true);
    $('td-crear').focus();
  }

  $('td-crear').addEventListener('click', create);
  $('td-cancelar').addEventListener('click', async () => {
    $('td-cancelar').disabled = true;
    await byd.testDataCancel();
    $('td-cancelar').disabled = false;
  });
  $('td-escanear').addEventListener('click', scanTestData);
  $('td-borrar').addEventListener('click', () => {
    show('td-borrar-confirmar', true);
    $('td-borrar-si').focus();
  });
  $('td-borrar-si').addEventListener('click', remove);
  $('td-borrar-no').addEventListener('click', () => {
    show('td-borrar-confirmar', false);
    $('td-borrar').focus();
  });
  $('diag-guardar').addEventListener('click', async () => {
    $('diag-guardar').disabled = true;
    $('diag-estado').textContent = '';
    const r = await byd.diagSave();
    $('diag-guardar').disabled = false;
    if (!r.ok) $('diag-estado').textContent = 'No se pudo guardar el registro de diagnóstico.';
    else $('diag-estado').textContent = r.value.guardado ? 'Registro guardado. Recuerda que incluye rutas de tus carpetas.' : 'No se guardó nada.';
  });
  $('ayuda-pruebas').addEventListener('toggle', () => {
    if ($('ayuda-pruebas').open) refreshStatus();
  });

  (async () => {
    const info = await byd.getAppInfo();
    if (info.ok) {
      $('app-version').textContent = `BoneYardDog versión ${info.value.version}`;
      $('lateral-version').textContent = `Versión ${info.value.version}`;
      $('app-proyecto').textContent = `Proyecto: ${info.value.project}`;
      document.body.dataset.version = info.value.version;
    }
  })();
  render();
})();
