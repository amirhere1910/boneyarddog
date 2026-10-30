'use strict';

// Aviso de copias INCOMPLETAS que quedaron de una sesión anterior (carpetas «….copiando» que BoneYardDog anotó en su
// diario): se ofrece borrarlas. Solo se pueden borrar las que la app anotó; la interfaz solo nombra una ruta que el
// proceso principal le dio y el hilo de transferencias vuelve a comprobarla contra el diario. Solo textContent.

(() => {
  const byd = window.byd;
  const $ = (id) => document.getElementById(id);

  async function refresh() {
    const res = await byd.pendingList();
    const box = $('aviso-pendientes');
    const list = $('lista-pendientes');
    list.replaceChildren();
    if (!res.ok || res.value.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    for (const p of res.value) {
      const li = document.createElement('li');
      li.className = 'carpeta';
      li.dataset.ruta = p.ruta;
      const name = document.createElement('p');
      name.className = 'ruta';
      name.textContent = `${p.ruta}${p.origen ? ` (copia de ${p.origen})` : ''}`;
      const row = document.createElement('div');
      row.className = 'fila fila-envuelve';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn-pend-borrar';
      del.textContent = 'Borrar esta copia incompleta';
      del.setAttribute('aria-label', `Borrar la copia incompleta ${p.ruta}`);
      del.addEventListener('click', async () => {
        del.disabled = true;
        const out = await byd.pendingClean(p.ruta);
        if (!out.ok) {
          const msg = document.getElementById('mensaje');
          msg.textContent = `No se pudo borrar la copia incompleta: ${out.error}`;
          msg.hidden = false;
          del.disabled = false;
          return;
        }
        await refresh();
      });
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'secundario';
      hide.textContent = 'Ahora no';
      hide.addEventListener('click', () => {
        li.remove();
        if (!list.children.length) box.hidden = true;
      });
      row.append(del, hide);
      li.append(name, row);
      list.append(li);
    }
  }

  window.BYDPendientes = { refresh };
  refresh();
})();
