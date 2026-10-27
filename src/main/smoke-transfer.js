'use strict';

/**
 * Prueba del motor de transferencia en un sistema REAL (se ejecuta dentro de Electron, sin ventana, con
 * `shell.trashItem` de verdad). Solo funciona con BYD_SMOKE=1 (igual que la prueba de humo de la app).
 * Se lanza con `npm run smoke:transfer`.
 *
 * Qué hace:
 *  (a) pregunta el tipo y formato de las unidades reales (PowerShell, como lo hará la app);
 *  (b) copia con verificación completa y con verificación rápida, y compara el contenido DESDE AQUÍ,
 *      de forma independiente al motor;
 *  (c) "mover" con la Papelera real: anota con exactitud qué pasó y comprueba solo las propiedades de seguridad;
 *  (d) "mover" con cuarentena real;
 *  (e) nombres con tildes, ñ, emoji y una ruta de más de 260 caracteres;
 *  (f) cancelación.
 * Guarda smoke-artifacts/transferencia.json con TODO lo observado (incluidas las sorpresas) y termina con
 * código 0, o 1 si se rompe cualquier propiedad de seguridad.
 *
 * PROPIEDADES DE SEGURIDAD que se comprueban (nunca se negocian):
 *   - una copia "verificada" tiene exactamente el mismo contenido que el origen;
 *   - el original solo desaparece si existe una copia verificada igual a él;
 *   - si algo falla o se cancela, el original sigue intacto.
 */

if (process.env.BYD_SMOKE !== '1') {
  console.error('Esta prueba solo se ejecuta con BYD_SMOKE=1 (usa `npm run smoke:transfer`).');
  process.exit(2);
}

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { app, shell } = require('electron');
const { createTransferEngine } = require('../core/transfer');
const { volumeInfoForPath, getVolumeInfo } = require('./volume-info');
const { isProtectedPath } = require('../core/protected');

const TIME_LIMIT_MS = 4 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const IS_WIN = process.platform === 'win32';

const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  versions: { electron: process.versions.electron, node: process.versions.node },
  env: { SystemDrive: process.env.SystemDrive || null, GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE || null, cwd: process.cwd() },
  volumes: [],
  scenarios: {},
  observations: [],
  surprises: [],
  violations: [],
};
const note = (text) => report.observations.push(text);
const surprise = (text) => report.surprises.push(text);
const violation = (text) => report.violations.push(text);

// ------------------------------------------------------------------------------------ utilidades

function write(file, content, mtimeDaysAgo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtimeDaysAgo !== undefined) {
    const d = new Date(Date.now() - mtimeDaysAgo * DAY);
    fs.utimesSync(file, d, d);
  }
}

/** Foto independiente de un árbol (sin usar el motor): ruta relativa -> tipo, tamaño y huella. */
function snapshot(root) {
  const out = {};
  (function walk(dir, rel) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) {
        out[r] = { type: 'dir' };
        walk(full, r);
      } else if (st.isFile()) out[r] = { type: 'file', size: st.size, sha: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
      else out[r] = { type: 'otro' };
    }
  })(root, '');
  return out;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeTree(root, { big = 0 } = {}) {
  write(path.join(root, 'a.txt'), 'hola mundo', 400);
  write(path.join(root, 'canción ñandú 🐕 con espacios.txt'), 'acción: ñandú, tildes y emoji 🐕', 30);
  write(path.join(root, 'cero.bin'), '', 100);
  write(path.join(root, 'sub', 'hondo', 'x.bin'), Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251)), 60);
  fs.mkdirSync(path.join(root, 'vacía ñ'), { recursive: true });
  if (big) {
    const buf = Buffer.alloc(big);
    for (let i = 0; i < buf.length; i += 4096) buf.writeUInt32LE(i / 4096, i);
    write(path.join(root, 'grande.bin'), buf, 5);
  }
}

function describeResult(r) {
  return {
    estado: r.estado,
    abortada: r.abortada,
    lote: r.lote,
    carpetas: r.carpetas.map((c) => ({ origen: c.origen, resultado: c.resultado, motivo: c.motivo, verificada: c.verificada, errores: c.errores.slice(0, 10) })),
  };
}

// ------------------------------------------------------------------------------------ ejecución

async function main() {
  await app.whenReady();
  const work = process.env.BYD_SMOKE_ROOT || process.cwd();
  const id = crypto.randomBytes(4).toString('hex');
  const srcBase = path.join(work, '.smoke-transfer', id);
  // Destino en OTRO volumen si hay uno (en el runner de Windows: el repo está en D: y el destino va en C:).
  const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
  const repoDrive = /^[A-Za-z]:/.test(srcBase) ? srcBase.slice(0, 2).toUpperCase() : null;
  const destBase = IS_WIN ? path.join(`${repoDrive === sysDrive ? 'C:' : sysDrive}\\`, `byd-transfer-dest-${id}`) : path.join(work, '.smoke-transfer', `${id}-destino`);
  const cleanup = [srcBase, destBase];
  report.paths = { srcBase, destBase, sameVolumeExpected: repoDrive === sysDrive };

  const trashed = [];
  const realTrash = async (p) => {
    trashed.push(p);
    return shell.trashItem(p);
  };
  const quarantineRoot = IS_WIN ? undefined : path.join(work, '.smoke-transfer', `${id}-cuarentena`);
  if (quarantineRoot) cleanup.push(quarantineRoot);
  const mkEngine = (extra = {}) =>
    createTransferEngine({
      // En Windows se consulta el volumen real. En otros sistemas (solo para poder ensayar aquí) se simula un disco fijo.
      volumeInfo: IS_WIN ? (p) => volumeInfoForPath(p) : async () => ({ driveType: 'fixed', fileSystem: 'otro', sizeBytes: 250e9, freeBytes: 30e9 }),
      trash: realTrash,
      appVersion: 'smoke',
      ...(quarantineRoot ? { volumeRoot: async () => quarantineRoot } : {}),
      ...extra,
    });

  if (isProtectedPath(srcBase) || isProtectedPath(destBase)) {
    surprise(`Las carpetas de prueba están en una ruta protegida (${srcBase} / ${destBase}): no se puede probar aquí.`);
    report.violations.push('Entorno inadecuado: ruta protegida');
    return;
  }
  fs.mkdirSync(srcBase, { recursive: true });
  fs.mkdirSync(destBase, { recursive: true });

  // ---- (a) volúmenes reales
  const letters = IS_WIN ? 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter((l) => fs.existsSync(`${l}:\\`)) : [];
  for (const l of letters) {
    const t0 = Date.now();
    const info = await getVolumeInfo(l);
    report.volumes.push({ letra: l, ms: Date.now() - t0, ...info });
  }
  if (IS_WIN) {
    const sys = report.volumes.find((v) => `${v.letra}:` === sysDrive);
    report.scenarios.a_volumenes = { sistema: sysDrive, info: sys || null };
    if (!sys || sys.fileSystem !== 'NTFS' || sys.driveType !== 'fixed') surprise(`La unidad del sistema ${sysDrive} no dio NTFS/fixed: ${JSON.stringify(sys)}`);
    if (report.volumes.every((v) => v.fileSystem === 'desconocido')) surprise('PowerShell no devolvió formato para ninguna unidad (¿falló Get-Volume?)');
  } else {
    report.scenarios.a_volumenes = { nota: 'No es Windows: solo statfs', info: await volumeInfoForPath(srcBase) };
  }

  // ---- (b) copia completa y rápida, comparada de forma independiente
  for (const verify of ['full', 'quick']) {
    const s = path.join(srcBase, `copia-${verify}`, 'Datos ñandú 🐕');
    makeTree(s);
    const before = snapshot(s);
    const e = mkEngine();
    const pf = await e.preflight({ sources: [s], destinationRoot: destBase, mode: 'copy', verify });
    const entry = { bloqueos: pf.blockers.map((b) => b.code), avisos: pf.warnings.map((w) => w.code) };
    if (!pf.plan) {
      violation(`b/${verify}: el preflight bloqueó una copia normal: ${JSON.stringify(pf.blockers)}`);
    } else {
      const r = await e.run(pf.plan);
      entry.resultado = describeResult(r);
      const copy = r.carpetas[0].destino;
      const after = snapshot(copy);
      entry.contenidoIgual = same(before, after);
      entry.origenIntacto = same(before, snapshot(s));
      // Ya no se puede comparar "fecha de modificación" con exactitud entre volúmenes distintos: se anota la diferencia.
      const dm = Math.abs(fs.statSync(path.join(copy, 'a.txt')).mtimeMs - fs.statSync(path.join(s, 'a.txt')).mtimeMs);
      entry.diferenciaFechaMs = dm;
      if (dm > 2) surprise(`b/${verify}: la fecha de modificación difiere ${dm} ms entre origen y copia`);
      if (r.carpetas[0].resultado !== 'copiada-verificada') violation(`b/${verify}: no quedó verificada: ${JSON.stringify(describeResult(r))}`);
      if (!entry.contenidoIgual) violation(`b/${verify}: la copia NO es igual al origen`);
      if (!entry.origenIntacto) violation(`b/${verify}: el origen cambió en una copia`);
      if (verify === 'quick' && !r.avisoVerificacion) violation('b/quick: falta el rótulo "no comprueba el contenido"');
      const v = await e.verifyBatch(r.batchFolder, { mode: 'full' });
      entry.verifyBatch = { ok: v.ok, problemas: v.problemas.length };
      if (verify === 'full' && !v.ok) violation('b/full: verifyBatch detectó problemas en una copia recién hecha');
    }
    report.scenarios[`b_copia_${verify}`] = entry;
  }

  // ---- (c) mover con la Papelera real
  {
    const s = path.join(srcBase, 'papelera', 'Para la Papelera ñ');
    makeTree(s);
    const before = snapshot(s);
    const e = mkEngine();
    const pf = await e.preflight({ sources: [s], destinationRoot: destBase, mode: 'move', verify: 'full', disposal: 'papelera' });
    const entry = { bloqueos: pf.blockers, avisos: pf.warnings.map((w) => w.code), veredictoPapelera: pf.disposal && pf.disposal.papelera };
    if (!pf.plan) {
      entry.nota = 'El preflight no dejó usar la Papelera: se registra el motivo (no es una violación).';
      surprise(`c: preflight bloqueó la Papelera: ${JSON.stringify(pf.blockers.map((b) => [b.code, b.message]))}`);
    } else {
      const root = IS_WIN ? `${s.slice(0, 2)}\\` : null;
      entry.recycleBinEnVolumenOrigen = root ? fs.existsSync(path.join(root, '$Recycle.Bin')) : null;
      const r = await e.run(pf.plan);
      entry.resultado = describeResult(r);
      entry.trashItemLlamadoCon = trashed.slice();
      entry.originalExisteDespues = fs.existsSync(s);
      const c = r.carpetas[0];
      const copyOk = c.verificada && same(before, snapshot(c.destino));
      entry.copiaVerificadaIgual = copyOk;
      if (c.resultado === 'original-enviado-a-papelera') {
        if (entry.originalExisteDespues) violation('c: dice "enviado a papelera" pero el original sigue existiendo');
        if (!copyOk) violation('c: el original desapareció pero la copia no está verificada/igual');
      } else if (c.resultado === 'original-sin-tocar') {
        if (!entry.originalExisteDespues || !same(before, snapshot(s))) violation('c: dice "sin tocar" pero el original cambió o no está');
        surprise(`c: la Papelera NO retiró el original: ${c.motivo}`);
      } else violation(`c: resultado inesperado ${c.resultado}`);
      if (IS_WIN && root) {
        try {
          entry.recycleBinListado = fs.readdirSync(path.join(root, '$Recycle.Bin')).slice(0, 10);
        } catch (err) {
          entry.recycleBinListado = `no se pudo listar: ${err.code}`;
        }
      }
    }
    report.scenarios.c_mover_papelera = entry;
  }

  // ---- (d) mover con cuarentena real
  {
    const s = path.join(srcBase, 'cuarentena', 'Para la cuarentena ñ');
    makeTree(s);
    const before = snapshot(s);
    const e = mkEngine();
    const pf = await e.preflight({ sources: [s], destinationRoot: destBase, mode: 'move', verify: 'full', disposal: 'cuarentena' });
    const entry = { bloqueos: pf.blockers.map((b) => b.code), avisos: pf.warnings.map((w) => w.code) };
    if (!pf.plan) violation(`d: preflight bloqueó una cuarentena normal: ${JSON.stringify(pf.blockers)}`);
    else {
      const r = await e.run(pf.plan);
      entry.resultado = describeResult(r);
      const c = r.carpetas[0];
      entry.originalExisteDespues = fs.existsSync(s);
      if (c.resultado !== 'original-en-cuarentena') violation(`d: resultado inesperado ${c.resultado} (${c.motivo})`);
      else {
        const man = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'MANIFIESTO.json'), 'utf8'));
        const qPath = man.carpetas[0].original.destino;
        entry.cuarentena = qPath;
        entry.contenidoCuarentenaIgual = same(before, snapshot(qPath));
        entry.contenidoCopiaIgual = same(before, snapshot(c.destino));
        if (entry.originalExisteDespues) violation('d: el original sigue en su sitio tras la cuarentena');
        if (!entry.contenidoCuarentenaIgual || !entry.contenidoCopiaIgual) violation('d: el contenido de la cuarentena o de la copia no coincide con el original');
        cleanup.push(path.join(qPath, '..'));
        if (IS_WIN) cleanup.push(path.join(`${s.slice(0, 2)}\\`, 'BoneYardDog-Cuarentena', r.lote));
      }
    }
    report.scenarios.d_mover_cuarentena = entry;
  }

  // ---- (e) nombres especiales y ruta de más de 260 caracteres
  {
    const longDir = path.join(srcBase, 'largo', 'x'.repeat(90), 'y'.repeat(90), 'z'.repeat(60));
    const entry = { rutaOrigenLargo: null };
    let created = false;
    try {
      write(path.join(longDir, 'archivo largo ñ 🐕.txt'), 'contenido de una ruta larga');
      write(path.join(longDir, '..', 'otro.txt'), 'otro');
      created = true;
      entry.rutaOrigenLargo = path.join(longDir, 'archivo largo ñ 🐕.txt').length;
    } catch (err) {
      entry.noSePudoCrearOrigenLargo = `${err.code}: ${err.message}`;
      surprise(`e: no se pudo crear una ruta de origen larga: ${err.code}`);
    }
    if (created) {
      const s = path.join(srcBase, 'largo');
      const before = snapshot(s);
      const e = mkEngine();
      const pf = await e.preflight({ sources: [s], destinationRoot: destBase, mode: 'copy', verify: 'full' });
      entry.bloqueos = pf.blockers.map((b) => b.code);
      entry.avisos = pf.warnings.map((w) => [w.code, w.cantidad || null]);
      entry.avisoRutaLarga = pf.warnings.some((w) => w.code === 'ruta-larga');
      if (pf.plan) {
        const longest = Math.max(...pf.plan.sources[0].entries.map((en) => path.join(destBase, 'BoneYardDog', pf.plan.batchName, ...pf.plan.sources[0].destParts, ...en.rel.split('/')).length));
        entry.rutaDestinoMasLarga = longest;
        const r = await e.run(pf.plan);
        entry.resultado = describeResult(r);
        const ok = r.carpetas[0].resultado === 'copiada-verificada';
        entry.copiaVerificada = ok;
        if (ok) {
          entry.contenidoIgual = same(before, snapshot(r.carpetas[0].destino));
          if (!entry.contenidoIgual) violation('e: la copia con ruta larga no es igual al origen');
        } else {
          surprise(`e: la copia con ruta larga NO quedó verificada: ${JSON.stringify(describeResult(r))}`);
        }
        if (!same(before, snapshot(s))) violation('e: el origen cambió');
        if (longest > 260 && !entry.avisoRutaLarga) violation('e: ruta de destino > 260 sin aviso');
      } else surprise(`e: bloqueado: ${JSON.stringify(pf.blockers.map((b) => [b.code, b.message]))}`);
    }
    // Nombres con tildes, ñ y emoji ya están en cada árbol de prueba; aquí se anota la lista.
    entry.nombresProbados = ['canción ñandú 🐕 con espacios.txt', 'vacía ñ', 'Datos ñandú 🐕', 'archivo largo ñ 🐕.txt'];
    report.scenarios.e_nombres_y_ruta_larga = entry;
  }

  // ---- (f) cancelación
  {
    const s = path.join(srcBase, 'cancelar', 'Para cancelar');
    makeTree(s, { big: 96 * 1024 * 1024 });
    const before = snapshot(s);
    const e = mkEngine();
    const pf = await e.preflight({ sources: [s], destinationRoot: destBase, mode: 'move', verify: 'full', disposal: 'cuarentena' });
    const entry = { bloqueos: pf.blockers.map((b) => b.code) };
    if (pf.plan) {
      const trashedBefore = trashed.length;
      const controller = new AbortController();
      const r = await e.run(pf.plan, {
        signal: controller.signal,
        progressIntervalMs: 0,
        onProgress: (p) => {
          if (p.fase === 'copiando' && p.archivo && p.archivo.endsWith('grande.bin') && p.bytesDone > 0) controller.abort();
        },
      });
      entry.resultado = describeResult(r);
      entry.papeleraLlamada = trashed.length > trashedBefore;
      entry.originalIntacto = same(before, snapshot(s)); // si se cancela, tampoco se mueve a cuarentena
      const estado = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'ESTADO.json'), 'utf8'));
      entry.estadoJson = estado.estado;
      if (r.estado !== 'cancelado' || estado.estado !== 'cancelado') violation(`f: la cancelación no quedó registrada (${r.estado}/${estado.estado})`);
      if (entry.papeleraLlamada || !entry.originalIntacto) violation('f: tras cancelar, el original no quedó intacto');
    } else violation(`f: el preflight bloqueó: ${JSON.stringify(pf.blockers)}`);
    report.scenarios.f_cancelacion = entry;
  }

  // ---- lo que quedó de lo propio
  report.escribio = { cleanup };
}

const timer = setTimeout(() => {
  violation('Se superó el tiempo máximo (4 minutos)');
  finish(1);
}, TIME_LIMIT_MS);

let finished = false;
function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) report.error = String(error && error.stack ? error.stack : error);
  report.ok = code === 0;
  report.finishedAt = new Date().toISOString();
  const outDir = path.join(process.cwd(), 'smoke-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'transferencia.json'), JSON.stringify(report, null, 2));
  console.log(`[transferencia] ${code === 0 ? 'OK' : 'FALLÓ'}`);
  console.log(`[transferencia] volúmenes: ${report.volumes.map((v) => `${v.letra}:${v.fileSystem}/${v.driveType}`).join(' ') || '(no aplica)'}`);
  for (const [k, v] of Object.entries(report.scenarios)) console.log(`[transferencia] ${k}: ${JSON.stringify(v).slice(0, 3500)}`);
  for (const s of report.surprises) console.log(`[transferencia] SORPRESA: ${s}`);
  for (const v of report.violations) console.log(`[transferencia] VIOLACIÓN: ${v}`);
  if (report.error) console.log(`[transferencia] error: ${report.error}`);
  const dirs = (report.escribio && report.escribio.cleanup) || [];
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true }); // solo lo que esta prueba creó
    } catch {
      /* limpieza best-effort */
    }
  }
  app.exit(code);
}

main().then(
  () => finish(report.violations.length === 0 ? 0 : 1),
  (err) => finish(1, err),
);
