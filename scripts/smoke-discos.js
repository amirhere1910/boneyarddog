'use strict';

/**
 * Pruebas del motor de transferencia contra discos REALES (virtuales): NTFS, exFAT y FAT32.
 * Se lanza con `npm run smoke:discos` (Node normal, sin Electron: la Papelera no hace falta aquí).
 *
 * En Windows crea con `diskpart` tres discos virtuales (VHDX de 512 MB), los monta con letra propia y ejecuta
 * contra ellos el motor de verdad:
 *   (a) tipo y formato que devuelve `getVolumeInfo` (se anota lo observado, sin suponer);
 *   (b) copia con verificación completa (tildes, ñ, emoji, carpeta vacía, archivos de 0 bytes), comparada aparte;
 *   (c) un archivo de 4 GiB (disperso) y de 4 GiB − 1 byte: FAT32 debe BLOQUEAR el primero sin escribir nada;
 *   (d) nombres que Windows no admite (punto o espacio al final) y 3 000 archivos pequeños en una carpeta;
 *   (f) verificación RÁPIDA con fechas de milisegundos raros (FAT guarda con 2 s de precisión);
 *   (g) `verifyBatch` tras desmontar y volver a montar el disco (como expulsar y reconectar) detecta un archivo alterado;
 *   (e) disco lleno: se llena hasta el borde DESPUÉS de planificar; error claro, original intacto, nada parcial.
 * Guarda smoke-artifacts/discos.json con TODO lo observado (incluidas las sorpresas) y termina con código 0, o 1 si se
 * rompe una propiedad de seguridad (original perdido sin copia verificada, sobrescritura, copia dañada aceptada...).
 *
 * `--simulado` (solo para ensayar la lógica fuera de Windows): usa carpetas normales con un formato inventado.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createTransferEngine } = require('../src/core/transfer');
const { getVolumeInfo, volumeInfoForPath } = require('../src/main/volume-info');

const SIMULATED = process.argv.includes('--simulado');
const IS_WIN = process.platform === 'win32';
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const DAY = 24 * 60 * 60 * 1000;
const FORMATS = [
  { name: 'NTFS', diskpart: 'ntfs' },
  { name: 'exFAT', diskpart: 'exfat' },
  { name: 'FAT32', diskpart: 'fat32' },
];

if (!IS_WIN && !SIMULATED) {
  console.error('Este script necesita Windows (diskpart). Para ensayar la lógica en otro sistema usa --simulado.');
  process.exit(2);
}

const report = {
  ok: false,
  startedAt: new Date().toISOString(),
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  simulado: SIMULATED,
  volumes: {},
  observations: [],
  surprises: [],
  violations: [],
  pending: [],
};
const surprise = (t) => report.surprises.push(t);
const violation = (t) => report.violations.push(t);
const pending = (t) => report.pending.push(t);
const log = (t) => console.log(`[discos] ${t}`);

// ------------------------------------------------------------------------------------ utilidades

const long = (p) => (IS_WIN && !p.startsWith('\\\\?\\') ? `\\\\?\\${path.resolve(p)}` : p);

function write(file, content, mtime) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  if (mtime !== undefined) fs.utimesSync(file, new Date(mtime), new Date(mtime));
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
const listing = (dir) => {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return null;
  }
};

/** Árbol con tildes, ñ, emoji, carpeta vacía, archivos de 0 bytes y un archivo de unos MB. */
function makeTree(root, { mb = 5 } = {}) {
  write(path.join(root, 'a.txt'), 'hola mundo', Date.now() - 400 * DAY);
  write(path.join(root, 'canción ñandú 🐕 con espacios.txt'), 'acción: ñandú, tildes y emoji 🐕', Date.now() - 30 * DAY);
  write(path.join(root, 'cero.bin'), '', Date.now() - 100 * DAY);
  write(path.join(root, 'sub ñ', 'hondo', 'cero también.dat'), '', Date.now() - 100 * DAY);
  write(path.join(root, 'sub ñ', 'hondo', 'x.bin'), crypto.randomBytes(6000), Date.now() - 60 * DAY);
  fs.mkdirSync(path.join(root, 'vacía ñ 🐕'), { recursive: true });
  if (mb) write(path.join(root, 'grande.bin'), crypto.randomBytes(mb * MIB), Date.now() - 5 * DAY);
}

function diskpart(lines) {
  const file = path.join(os.tmpdir(), `byd-diskpart-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, `${lines.join('\r\n')}\r\n`);
  const r = spawnSync('diskpart', ['/s', file], { encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  fs.rmSync(file, { force: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) throw new Error(`Se agotó el tiempo esperando: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function freeLetters(n) {
  const out = [];
  for (const l of 'ZYXWVUTSRQPONMLKJIHGFE') {
    if (!fs.existsSync(`${l}:\\`)) out.push(l);
    if (out.length === n) break;
  }
  return out;
}

// ------------------------------------------------------------------------------------ discos virtuales

function createDisk(work, fmt, letter) {
  const file = path.join(work, `${fmt.name}.vhdx`);
  const r = diskpart([`create vdisk file="${file}" maximum=512 type=expandable`, 'attach vdisk', 'create partition primary', `format fs=${fmt.diskpart} quick label=BYD${fmt.name}`, `assign letter=${letter}`]);
  return { file, letter, root: `${letter}:\\`, diskpartOut: r.out, status: r.status };
}

async function remountDisk(d) {
  const a = diskpart([`select vdisk file="${d.file}"`, 'detach vdisk']);
  await waitFor(() => !fs.existsSync(d.root), 60_000, `que ${d.root} desaparezca`);
  const b = diskpart([`select vdisk file="${d.file}"`, 'attach vdisk', 'select partition 1', 'remove noerr', `assign letter=${d.letter}`]);
  await waitFor(() => fs.existsSync(d.root), 60_000, `que ${d.root} vuelva`);
  return { detach: a.out.trim().split(/\r?\n/).slice(-3).join(' | '), attach: b.out.trim().split(/\r?\n/).slice(-3).join(' | ') };
}

// ------------------------------------------------------------------------------------ escenarios

async function main() {
  const id = crypto.randomBytes(4).toString('hex');
  const work = path.join(process.cwd(), '.smoke-discos', id);
  fs.mkdirSync(work, { recursive: true });
  const cleanup = [work];
  report.work = work;

  // --- discos
  const disks = {};
  if (SIMULATED) {
    for (const fmt of FORMATS) {
      const dir = path.join(work, `disco-${fmt.name}`);
      fs.mkdirSync(dir, { recursive: true });
      disks[fmt.name] = { root: dir, letter: fmt.name, simulated: true };
    }
  } else {
    const letters = freeLetters(3);
    if (letters.length < 3) throw new Error('No hay 3 letras de unidad libres');
    for (const [i, fmt] of FORMATS.entries()) {
      const t0 = Date.now();
      const d = createDisk(work, fmt, letters[i]);
      report.observations.push(`diskpart ${fmt.name}: estado ${d.status}, ${Date.now() - t0} ms`);
      try {
        await waitFor(() => fs.existsSync(d.root), 60_000, `que ${d.root} exista`);
      } catch (err) {
        pending(`No se pudo crear/montar el disco ${fmt.name}: ${err.message}. Salida de diskpart: ${d.diskpartOut.slice(-600)}`);
        continue;
      }
      disks[fmt.name] = d;
    }
  }
  report.disks = Object.fromEntries(Object.entries(disks).map(([k, v]) => [k, { root: v.root }]));

  const infoOf = async (p) => {
    if (SIMULATED) {
      const fmt = FORMATS.find((f) => p.includes(`disco-${f.name}`));
      return fmt ? { driveType: 'fixed', fileSystem: fmt.name, sizeBytes: 512 * MIB, freeBytes: 400 * MIB } : { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 100 * GIB, freeBytes: 50 * GIB };
    }
    return volumeInfoForPath(p);
  };
  const mkEngine = (extra = {}) => createTransferEngine({ volumeInfo: infoOf, trash: null, appVersion: 'discos', ...extra });

  for (const fmt of FORMATS) {
    const disk = disks[fmt.name];
    if (!disk) continue;
    const V = { fmt: fmt.name, scenarios: {} };
    report.volumes[fmt.name] = V;
    log(`==== ${fmt.name} (${disk.root}) ====`);
    const src = path.join(work, 'origenes', fmt.name);
    const dest = path.join(disk.root, 'destino');
    fs.mkdirSync(dest, { recursive: true });
    const tag = (s) => `${fmt.name}/${s}`;
    const step = async (name, fn) => {
      try {
        V.scenarios[name] = await fn();
      } catch (err) {
        V.scenarios[name] = { error: String((err && err.stack) || err) };
        violation(`${tag(name)}: error inesperado: ${(err && err.message) || err}`);
      }
    };

    // (a) tipo y formato
    await step('a_volumen', async () => {
      const t0 = Date.now();
      const info = SIMULATED ? await infoOf(dest) : await getVolumeInfo(disk.letter);
      const entry = { devuelto: info, ms: Date.now() - t0 };
      if (info.fileSystem !== fmt.name) {
        surprise(`${tag('a')}: getVolumeInfo devolvió «${info.fileSystem}» y se esperaba «${fmt.name}»`);
        violation(`${tag('a')}: la app NO reconoce el formato ${fmt.name} de una unidad real (devolvió ${info.fileSystem}): las reglas del formato no se aplicarían`);
      }
      if (info.driveType !== 'fixed') surprise(`${tag('a')}: el tipo de unidad devuelto es «${info.driveType}» (un VHDX montado se esperaba «fixed»)`);
      if (typeof info.sizeBytes !== 'number' || typeof info.freeBytes !== 'number') surprise(`${tag('a')}: tamaño o espacio libre no numéricos: ${JSON.stringify(info)}`);
      return entry;
    });

    // (b) copia completa
    let batchB = null;
    let copyB = null;
    const treeB = path.join(src, 'b', 'Datos ñandú 🐕');
    makeTree(treeB);
    const beforeB = snapshot(treeB);
    await step('b_copia_completa', async () => {
      const e = mkEngine();
      const pf = await e.preflight({ sources: [treeB], destinationRoot: dest, mode: 'copy', verify: 'full' });
      const entry = { bloqueos: pf.blockers.map((b) => [b.code, b.message]), avisos: pf.warnings.map((w) => w.code) };
      if (!pf.plan) {
        violation(`${tag('b')}: el preflight bloqueó una copia normal: ${JSON.stringify(entry.bloqueos)}`);
        return entry;
      }
      const r = await e.run(pf.plan);
      const c = r.carpetas[0];
      batchB = r.batchFolder;
      copyB = c.destino;
      entry.estado = r.estado;
      entry.resultado = c.resultado;
      entry.errores = c.errores.slice(0, 5);
      entry.contenidoIgual = c.verificada && same(beforeB, snapshot(c.destino));
      entry.origenIntacto = same(beforeB, snapshot(treeB));
      const mt = (rel) => Math.abs(fs.statSync(path.join(c.destino, rel)).mtimeMs - fs.statSync(path.join(treeB, rel)).mtimeMs);
      entry.diferenciaFechaMs = { 'a.txt': mt('a.txt'), 'grande.bin': mt('grande.bin') };
      if (c.resultado !== 'copiada-verificada') violation(`${tag('b')}: no quedó verificada: ${c.resultado} ${JSON.stringify(c.errores.slice(0, 3))}`);
      if (!entry.contenidoIgual) violation(`${tag('b')}: la copia NO es igual al origen (comparación independiente)`);
      if (!entry.origenIntacto) violation(`${tag('b')}: el origen cambió en una copia`);
      const v = await e.verifyBatch(r.batchFolder, { mode: 'full' });
      entry.verifyBatch = { ok: v.ok, problemas: v.problemas.length };
      if (!v.ok) violation(`${tag('b')}: verifyBatch detectó problemas en una copia recién hecha`);
      return entry;
    });

    // (c) archivos de 4 GiB (dispersos): FAT32 debe bloquear
    await step('c_archivo_4gib', async () => {
      const big = path.join(src, 'c', 'solo 4 GiB');
      const edge = path.join(src, 'c-borde', 'justo bajo 4 GiB');
      fs.mkdirSync(big, { recursive: true });
      fs.mkdirSync(edge, { recursive: true });
      const mk = (p, size) => {
        if (IS_WIN) {
          run('fsutil', ['file', 'createnew', p, '0']);
          run('fsutil', ['sparse', 'setflag', p]);
          run('fsutil', ['file', 'seteof', p, String(size)]);
        } else {
          fs.closeSync(fs.openSync(p, 'w'));
          fs.truncateSync(p, size);
        }
      };
      mk(path.join(big, 'enorme.bin'), 4294967296);
      mk(path.join(edge, 'casi.bin'), 4294967295);
      const entry = { tamanos: { enorme: fs.statSync(path.join(big, 'enorme.bin')).size, casi: fs.statSync(path.join(edge, 'casi.bin')).size } };
      if (entry.tamanos.enorme !== 4294967296 || entry.tamanos.casi !== 4294967295) {
        pending(`${tag('c')}: no se pudieron crear los archivos de 4 GiB: ${JSON.stringify(entry.tamanos)}`);
        return entry;
      }
      const e = mkEngine();
      const dest4 = path.join(disk.root, 'destino-4gib');
      fs.mkdirSync(dest4, { recursive: true });
      const before = listing(dest4);
      const pf = await e.preflight({ sources: [big], destinationRoot: dest4, mode: 'copy', verify: 'full' });
      entry.enorme = { bloqueos: pf.blockers.map((b) => b.code), plan: Boolean(pf.plan) };
      entry.destinoSinCambios = same(before, listing(dest4));
      const pfEdge = await e.preflight({ sources: [edge], destinationRoot: dest4, mode: 'copy', verify: 'full' });
      entry.casi = { bloqueos: pfEdge.blockers.map((b) => b.code), plan: Boolean(pfEdge.plan) };
      if (fmt.name === 'FAT32') {
        if (!entry.enorme.bloqueos.includes('archivo-demasiado-grande') || pf.plan) violation(`${tag('c')}: un archivo de 4 GiB hacia FAT32 NO se bloqueó (${JSON.stringify(entry.enorme)})`);
        if (entry.casi.bloqueos.includes('archivo-demasiado-grande')) violation(`${tag('c')}: 4 GiB − 1 byte es el máximo de FAT32 y se bloqueó por tamaño`);
      } else if (entry.enorme.bloqueos.includes('archivo-demasiado-grande')) violation(`${tag('c')}: ${fmt.name} no tiene el límite de 4 GiB y se bloqueó`);
      if (!entry.destinoSinCambios) violation(`${tag('c')}: el preflight dejó cambios en el destino (${JSON.stringify([before, listing(dest4)])})`);
      return entry;
    });

    // (d) nombres que Windows no admite y 3 000 archivos pequeños
    await step('d_nombres_no_validos', async () => {
      const dir = path.join(src, 'd', 'nombres raros');
      fs.mkdirSync(dir, { recursive: true });
      const entry = { creados: [] };
      write(path.join(dir, 'normal.txt'), 'normal');
      for (const name of ['final con punto.', 'final con espacio ']) {
        try {
          fs.writeFileSync(long(path.join(dir, name)), 'x');
          entry.creados.push(name);
        } catch (err) {
          entry.creados.push(`${name} -> no se pudo crear: ${err.code}`);
        }
      }
      const e = mkEngine();
      const destD = path.join(disk.root, 'destino-nombres');
      fs.mkdirSync(destD, { recursive: true });
      const before = listing(destD);
      const pf = await e.preflight({ sources: [dir], destinationRoot: destD, mode: 'copy', verify: 'full' });
      entry.bloqueos = pf.blockers.map((b) => [b.code, (b.nombres || []).length]);
      entry.avisos = pf.warnings.map((w) => [w.code, w.cantidad || null]);
      entry.plan = Boolean(pf.plan);
      entry.destinoSinCambios = same(before, listing(destD));
      const flagged = pf.blockers.some((b) => b.code === 'nombres-no-validos') || pf.warnings.some((w) => w.code === 'elementos-ilegibles');
      if (entry.creados.some((c) => !c.includes('->')) && !flagged) violation(`${tag('d')}: nombres con punto o espacio al final se pasaron en silencio (ni bloqueo ni aviso de elementos ilegibles)`);
      if (pf.plan && !pf.warnings.some((w) => w.code === 'elementos-ilegibles')) violation(`${tag('d')}: hay un plan sin avisar de lo que no se puede copiar`);
      if (!entry.destinoSinCambios) violation(`${tag('d')}: el destino cambió durante una revisión`);
      entry.nota = 'Nombres reservados (CON, NUL…) no se prueban en disco real: Windows los trata como dispositivos y podrían colgar la prueba; están cubiertos por las pruebas unitarias.';
      return entry;
    });

    await step('d_3000_archivos', async () => {
      const dir = path.join(src, 'd', 'muchos');
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(dir, `archivo ${String(i).padStart(4, '0')} ñ.txt`), `contenido ${i} ${'x'.repeat(i % 50)}`);
      const before = snapshot(dir);
      const e = mkEngine();
      const destM = path.join(disk.root, 'destino-muchos');
      fs.mkdirSync(destM, { recursive: true });
      const t0 = Date.now();
      const pf = await e.preflight({ sources: [dir], destinationRoot: destM, mode: 'copy', verify: 'full' });
      const entry = { bloqueos: pf.blockers.map((b) => b.code), avisos: pf.warnings.map((w) => w.code) };
      if (!pf.plan) {
        violation(`${tag('d')}: 3 000 archivos pequeños bloqueados: ${JSON.stringify(pf.blockers)}`);
        return entry;
      }
      const r = await e.run(pf.plan);
      entry.ms = Date.now() - t0;
      entry.resultado = r.carpetas[0].resultado;
      entry.contenidoIgual = r.carpetas[0].verificada && same(before, snapshot(r.carpetas[0].destino));
      if (!entry.contenidoIgual || r.carpetas[0].resultado !== 'copiada-verificada') violation(`${tag('d')}: la copia de 3 000 archivos no quedó verificada e idéntica (${r.carpetas[0].resultado})`);
      return entry;
    });

    // (f) verificación rápida y precisión de fechas
    await step('f_verificacion_rapida_fechas', async () => {
      const dir = path.join(src, 'f', 'fechas');
      const stamps = [new Date(2024, 0, 1, 12, 0, 0, 123).getTime(), new Date(2024, 5, 7, 8, 30, 1, 999).getTime(), new Date(2023, 11, 31, 23, 59, 59, 1).getTime()];
      stamps.forEach((ms, i) => write(path.join(dir, `fecha ${i}.txt`), `contenido ${i}`, ms));
      const e = mkEngine();
      const destF = path.join(disk.root, 'destino-rapida');
      fs.mkdirSync(destF, { recursive: true });
      const pf = await e.preflight({ sources: [dir], destinationRoot: destF, mode: 'copy', verify: 'quick' });
      const entry = { bloqueos: pf.blockers.map((b) => b.code) };
      if (!pf.plan) {
        violation(`${tag('f')}: bloqueó una copia rápida normal: ${JSON.stringify(pf.blockers)}`);
        return entry;
      }
      const r = await e.run(pf.plan);
      const c = r.carpetas[0];
      entry.resultado = c.resultado;
      entry.errores = c.errores.slice(0, 5);
      entry.aviso = r.avisoVerificacion;
      entry.diferenciasMs = stamps.map((_, i) => fs.statSync(path.join(c.destino, `fecha ${i}.txt`)).mtimeMs - fs.statSync(path.join(dir, `fecha ${i}.txt`)).mtimeMs);
      if (c.resultado !== 'copiada-verificada') {
        // No es una pérdida de datos (el original no se toca), pero la tolerancia de fechas no funciona en este formato.
        surprise(`${tag('f')}: la verificación rápida NO aceptó las fechas (${JSON.stringify(entry.diferenciasMs)}): ${JSON.stringify(c.errores.slice(0, 3))}`);
        violation(`${tag('f')}: la comparación de fechas de la verificación rápida falla en ${fmt.name}`);
      }
      if (!r.avisoVerificacion) violation(`${tag('f')}: falta el rótulo de que la verificación rápida no comprueba el contenido`);
      return entry;
    });

    // (g) verifyBatch tras desmontar y volver a montar
    await step('g_verifybatch_tras_remontar', async () => {
      if (!batchB) {
        pending(`${tag('g')}: no hay copia de (b) para verificar`);
        return { omitido: true };
      }
      const e = mkEngine();
      const entry = {};
      if (SIMULATED) entry.remontar = 'simulado: no se desmonta nada';
      else entry.remontar = await remountDisk(disk);
      const ok = await e.verifyBatch(batchB, { mode: 'full' });
      entry.despuesDeRemontar = { ok: ok.ok, verificados: ok.verificados, problemas: ok.problemas.length };
      if (!ok.ok) violation(`${tag('g')}: verifyBatch dice que hay problemas tras remontar una copia sana (${JSON.stringify(ok.problemas.slice(0, 3))})`);
      // Se altera a mano un archivo (un byte) y se borra otro.
      const target = path.join(copyB, 'sub ñ', 'hondo', 'x.bin');
      const bytes = fs.readFileSync(target);
      bytes[10] ^= 0xff;
      fs.writeFileSync(target, bytes);
      const bad = await e.verifyBatch(batchB, { mode: 'full' });
      entry.conArchivoAlterado = { ok: bad.ok, problemas: bad.problemas.map((p) => [p.ruta, p.problema]) };
      if (bad.ok || !bad.problemas.some((p) => p.problema === 'huella')) violation(`${tag('g')}: verifyBatch NO detectó un archivo alterado a mano`);
      fs.unlinkSync(path.join(copyB, 'a.txt'));
      const gone = await e.verifyBatch(batchB, { mode: 'full' });
      entry.conArchivoFaltante = { ok: gone.ok, problemas: gone.problemas.map((p) => [p.ruta, p.problema]) };
      if (gone.ok || !gone.problemas.some((p) => p.problema === 'falta')) violation(`${tag('g')}: verifyBatch NO detectó un archivo faltante`);
      return entry;
    });

    // (e) disco lleno DESPUÉS de planificar
    await step('e_disco_lleno', async () => {
      if (SIMULATED) return { omitido: 'simulado: no se puede llenar un disco que no existe' };
      const dir = path.join(src, 'e', 'Para llenar');
      write(path.join(dir, 'pequeno.txt'), 'pequeño', Date.now() - 10 * DAY);
      write(path.join(dir, 'grande.bin'), crypto.randomBytes(40 * MIB), Date.now() - 10 * DAY);
      const before = snapshot(dir);
      const e = mkEngine();
      const destE = path.join(disk.root, 'destino-lleno');
      fs.mkdirSync(destE, { recursive: true });
      const pf = await e.preflight({ sources: [dir], destinationRoot: destE, mode: 'move', verify: 'full', disposal: 'ninguna' });
      const entry = { planificado: Boolean(pf.plan), bloqueos: pf.blockers.map((b) => b.code) };
      if (!pf.plan) {
        pending(`${tag('e')}: no se pudo planificar antes de llenar: ${JSON.stringify(pf.blockers)}`);
        return entry;
      }
      // Se llena el disco hasta dejar unos 12 MB libres.
      const st = fs.statfsSync(disk.root);
      const free = Number(st.bavail) * Number(st.bsize);
      const filler = path.join(disk.root, 'relleno.bin');
      const fillBytes = free - 12 * MIB;
      const t = run('fsutil', ['file', 'createnew', filler, String(fillBytes)]);
      const st2 = fs.statfsSync(disk.root);
      entry.libreAntes = free;
      entry.libreDespuesDeLlenar = Number(st2.bavail) * Number(st2.bsize);
      entry.fsutil = t.out.trim().slice(0, 200);
      const r = await e.run(pf.plan);
      const c = r.carpetas[0];
      entry.estado = r.estado;
      entry.abortada = r.abortada;
      entry.resultado = c.resultado;
      entry.motivo = c.motivo;
      entry.errores = c.errores.slice(0, 3);
      entry.originalIntacto = same(before, snapshot(dir));
      // Nada parcial: todo archivo que haya quedado en el lote tiene el tamaño del original.
      const partial = [];
      (function walk(d) {
        for (const n of fs.readdirSync(d)) {
          const f = path.join(d, n);
          const s = fs.lstatSync(f);
          if (s.isDirectory()) walk(f);
          else if (!['ESTADO.json', 'MANIFIESTO.json', 'LEEME.txt'].includes(n)) {
            const orig = path.join(dir, path.relative(path.join(c.destino), f));
            if (!fs.existsSync(orig) || fs.statSync(orig).size !== s.size) partial.push(f);
          }
        }
      })(r.batchFolder);
      entry.archivosParciales = partial;
      const state = JSON.parse(fs.readFileSync(path.join(r.batchFolder, 'ESTADO.json'), 'utf8'));
      entry.estadoJson = state.estado;
      if (!entry.originalIntacto) violation(`${tag('e')}: el original cambió con el disco lleno`);
      if (partial.length) violation(`${tag('e')}: quedaron archivos parciales: ${JSON.stringify(partial)}`);
      if (c.resultado === 'original-enviado-a-papelera' || c.resultado === 'original-borrado-definitivamente') violation(`${tag('e')}: se retiró un original con el disco lleno`);
      if (r.estado === 'completo') violation(`${tag('e')}: el disco lleno terminó como «completo»`);
      if (!r.abortada || r.abortada.code !== 'ENOSPC') surprise(`${tag('e')}: no se registró ENOSPC como causa (abortada: ${JSON.stringify(r.abortada)})`);
      // Y una revisión nueva con el disco lleno debe bloquear por espacio.
      const pf2 = await e.preflight({ sources: [dir], destinationRoot: destE, mode: 'copy', verify: 'full' });
      entry.revisionConDiscoLleno = pf2.blockers.map((b) => b.code);
      if (!pf2.blockers.some((b) => b.code === 'sin-espacio')) violation(`${tag('e')}: con el disco lleno la revisión previa no bloqueó por espacio`);
      fs.rmSync(filler, { force: true });
      return entry;
    });
  }

  report.cleanupDirs = cleanup;
  // --- desmontar
  if (!SIMULATED) {
    for (const d of Object.values(disks)) {
      diskpart([`select vdisk file="${d.file}"`, 'detach vdisk']);
    }
  }
  return cleanup;
}

let finished = false;
function finish(code, error, cleanup = []) {
  if (finished) return;
  finished = true;
  if (error) report.error = String((error && error.stack) || error);
  report.ok = code === 0;
  report.finishedAt = new Date().toISOString();
  const outDir = path.join(process.cwd(), 'smoke-artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'discos.json'), JSON.stringify(report, null, 2));
  console.log(`[discos] ${code === 0 ? 'OK' : 'FALLÓ'}${report.pending.length ? ' (con pendientes)' : ''}`);
  for (const [fmtName, v] of Object.entries(report.volumes)) {
    for (const [name, value] of Object.entries(v.scenarios)) console.log(`[discos] ${fmtName}/${name}: ${JSON.stringify(value).slice(0, 1500)}`);
  }
  for (const s of report.surprises) console.log(`[discos] SORPRESA: ${s}`);
  for (const p of report.pending) console.log(`[discos] PENDIENTE: ${p}`);
  for (const v of report.violations) console.log(`[discos] VIOLACIÓN: ${v}`);
  if (report.error) console.log(`[discos] error: ${report.error}`);
  for (const d of cleanup) {
    try {
      fs.rmSync(long(d), { recursive: true, force: true });
    } catch {
      /* limpieza best-effort (el runner se descarta) */
    }
  }
  process.exit(code);
}

const killer = setTimeout(() => {
  violation('Se superó el tiempo máximo (15 minutos)');
  finish(1);
}, 15 * 60 * 1000);
killer.unref();

main().then(
  (cleanup) => finish(report.violations.length === 0 ? 0 : 1, null, cleanup),
  (err) => finish(1, err),
);
