'use strict';

/**
 * Mapa de cuadros por tamaño ("squarified treemap", Bruls et al.). Módulo UMD,
 * sin dependencias, puro: no toca el disco ni el DOM.
 *
 * layout(items, width, height, { gap = 2 })
 *   items:  [{ id, size }]
 *   salida: [{ id, x, y, w, h }]
 *
 * - Ordena por tamaño de mayor a menor (empates por id): el resultado es
 *   determinista.
 * - Descarta tamaños que no sean números positivos.
 * - Los rectángulos caben en el área, no se solapan y su área es proporcional
 *   al tamaño. `gap` es la separación entre cuadros: cada uno se encoge gap/2
 *   por lado (menos si el cuadro es diminuto), así que el área real es algo
 *   menor que la ideal.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BYDTreemap = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** Peor razón de aspecto de una fila de áreas colocada a lo largo de un lado de largo `side`. */
  function worst(areas, sum, side) {
    let min = Infinity;
    let max = 0;
    for (const a of areas) {
      if (a < min) min = a;
      if (a > max) max = a;
    }
    const s2 = side * side;
    return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
  }

  function layout(items, width, height, { gap = 2 } = {}) {
    if (!Array.isArray(items) || !(width > 0) || !(height > 0)) return [];
    const list = items
      .filter((it) => it && Number.isFinite(it.size) && it.size > 0)
      .map((it) => ({ id: it.id, size: it.size }))
      .sort((a, b) => b.size - a.size || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    if (list.length === 0) return [];

    const total = list.reduce((s, it) => s + it.size, 0);
    const scale = (width * height) / total;
    const cells = list.map((it) => ({ id: it.id, area: it.size * scale }));

    const out = [];
    let x = 0;
    let y = 0;
    let w = width;
    let h = height;
    let row = [];
    let rowSum = 0;

    function flush() {
      if (row.length === 0) return;
      if (w >= h) {
        // Columna vertical a la izquierda.
        const colW = rowSum / h;
        let cy = y;
        for (const c of row) {
          const ch = c.area / colW;
          out.push({ id: c.id, x, y: cy, w: colW, h: ch });
          cy += ch;
        }
        x += colW;
        w -= colW;
      } else {
        // Franja horizontal arriba.
        const rowH = rowSum / w;
        let cx = x;
        for (const c of row) {
          const cw = c.area / rowH;
          out.push({ id: c.id, x: cx, y, w: cw, h: rowH });
          cx += cw;
        }
        y += rowH;
        h -= rowH;
      }
      row = [];
      rowSum = 0;
    }

    for (const c of cells) {
      const side = Math.min(w, h);
      if (row.length === 0) {
        row.push(c);
        rowSum = c.area;
        continue;
      }
      const current = worst(row.map((r) => r.area), rowSum, side);
      const next = worst(row.map((r) => r.area).concat(c.area), rowSum + c.area, side);
      if (next <= current) {
        row.push(c);
        rowSum += c.area;
      } else {
        flush();
        row.push(c);
        rowSum = c.area;
      }
    }
    flush();

    // Márgenes entre cuadros, sin salirse del área y sin dejar cuadros de tamaño negativo.
    return out.map((r) => {
      const inset = Math.max(0, Math.min(gap / 2, r.w / 4, r.h / 4));
      return {
        id: r.id,
        x: Math.max(0, r.x + inset),
        y: Math.max(0, r.y + inset),
        w: Math.max(0, r.w - 2 * inset),
        h: Math.max(0, r.h - 2 * inset),
      };
    });
  }

  /**
   * layoutFolded(items, width, height, { gap, minSide = 20, minArea = 500, othersId })
   *   items: [{ id, size, foldable }]
   * Dibuja como `layout`, pero todo cuadro "plegable" cuyo lado dibujado sea menor que
   * `minSide` px, o cuya área sea menor que `minArea` px², NO se queda como cuadro: su
   * tamaño se suma al cuadro `othersId` (se crea si no existe) y se vuelve a dibujar,
   * hasta que ya no queden cuadros diminutos plegables.
   * Salida: { rects, folded: [ids plegados], items: [lo que se dibujó] }.
   * El cuadro `othersId` nunca se pliega a sí mismo (puede quedar chico: la interfaz lo
   * dibuja sin foco si es diminuto).
   */
  function layoutFolded(items, width, height, { gap = 2, minSide = 20, minArea = 500, othersId = 'others' } = {}) {
    let current = (items || []).filter((it) => it && Number.isFinite(it.size) && it.size > 0).map((it) => ({ ...it }));
    const folded = [];
    for (let guard = 0; guard < 200; guard++) {
      const rects = layout(current, width, height, { gap });
      const byId = new Map(current.map((it) => [it.id, it]));
      const tiny = rects.filter((r) => r.id !== othersId && byId.get(r.id).foldable && (Math.min(r.w, r.h) < minSide || r.w * r.h < minArea));
      if (tiny.length === 0) return { rects, folded, items: current };
      const ids = new Set(tiny.map((r) => r.id));
      const moved = current.filter((it) => ids.has(it.id)).reduce((sum, it) => sum + it.size, 0);
      current = current.filter((it) => !ids.has(it.id));
      for (const id of ids) folded.push(id);
      const others = current.find((it) => it.id === othersId);
      if (others) others.size += moved;
      else current.push({ id: othersId, size: moved, foldable: false });
    }
    return { rects: layout(current, width, height, { gap }), folded, items: current };
  }

  return { layout, layoutFolded };
});
