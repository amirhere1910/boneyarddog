'use strict';

/**
 * Prueba el instalador y el .zip portátil EN WINDOWS (se usa en la CI de «Construir instalador»):
 *   1. instala en silencio (/S) en una carpeta fuera de AppData y comprueba lo instalado y el acceso del menú Inicio;
 *   2. abre la app INSTALADA con BYD_SMOKE=1 --smoke-test (abre la ventana, escanea las carpetas de ejemplo, usa el
 *      asistente y los datos de prueba) y revisa el resultado;
 *   3. desinstala en silencio y comprueba que no queda nada en la carpeta de instalación;
 *   4. descomprime el .zip portátil, ejecuta lo mismo y lo borra.
 * Guarda <salida>/instalador.json con todo lo observado. Código 0 si todo bien; 1 si algo falla.
 * Uso: node scripts/probar-instalador.js --instalador RUTA.exe --portatil RUTA.zip --salida CARPETA
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : null;
}
const installer = arg('instalador');
const portable = arg('portatil');
const out = path.resolve(arg('salida') || 'smoke-artifacts');
if (process.platform !== 'win32' || !installer || !portable) {
  console.error('Uso (solo Windows): node scripts/probar-instalador.js --instalador RUTA.exe --portatil RUTA.zip --salida CARPETA');
  process.exit(2);
}

const report = { ok: false, startedAt: new Date().toISOString(), instalador: installer, portatil: portable, pasos: {}, fallos: [] };
const fail = (t) => report.fallos.push(t);
const log = (t) => console.log(`[instalador] ${t}`);
fs.mkdirSync(out, { recursive: true });

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const f = path.join(d, n);
      const st = fs.lstatSync(f);
      if (st.isDirectory()) walk(f);
      else {
        files++;
        bytes += st.size;
      }
    }
  })(dir);
  return { archivos: files, bytes, megabytes: Math.round(bytes / 1048576) };
}

/** Abre la app con la prueba automática y espera a que termine (máximo 6 minutos). */
function runApp(exe, label) {
  return new Promise((resolve) => {
    const dataDir = path.join(out, `${label}-datos`);
    const resDir = path.join(out, label);
    fs.rmSync(resDir, { recursive: true, force: true });
    fs.mkdirSync(resDir, { recursive: true });
    const env = { ...process.env, BYD_SMOKE: '1', BYD_SMOKE_OUT: resDir, BYD_SMOKE_DATA: dataDir };
    const t0 = Date.now();
    const child = spawn(exe, ['--smoke-test'], { cwd: path.dirname(exe), env, stdio: 'ignore', windowsHide: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
    }, 6 * 60 * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: String(err) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      const entry = { codigoDeSalida: code, ms: Date.now() - t0, tiempoAgotado: timedOut };
      try {
        const res = JSON.parse(fs.readFileSync(path.join(resDir, 'resultado.json'), 'utf8'));
        entry.ok = res.ok;
        entry.comprobaciones = res.checks.length;
        entry.fallidas = res.checks.filter((c) => !c.ok).map((c) => [c.name, c.detail]);
        entry.versiones = res.versions;
        entry.plataforma = res.platform;
        entry.error = res.error || null;
      } catch (err) {
        entry.sinResultado = `No se pudo leer resultado.json: ${err.code || err.message}`;
      }
      resolve(entry);
    });
  });
}

function judgeRun(label, r) {
  if (r.error) fail(`${label}: no se pudo abrir la app: ${r.error}`);
  else if (r.tiempoAgotado) fail(`${label}: la app no terminó en 6 minutos`);
  else if (r.sinResultado) fail(`${label}: ${r.sinResultado} (código de salida ${r.codigoDeSalida})`);
  else {
    if (r.codigoDeSalida !== 0 || !r.ok) fail(`${label}: la prueba automática falló (código ${r.codigoDeSalida}): ${JSON.stringify(r.fallidas).slice(0, 800)}`);
    if (r.comprobaciones < 100) fail(`${label}: solo se hicieron ${r.comprobaciones} comprobaciones (se esperaban más de 100)`);
  }
}

async function main() {
  const base = path.parse(out).root + `byd-prueba-instalador-${process.pid}`; // fuera de AppData y de la carpeta del repositorio
  fs.mkdirSync(base, { recursive: true });
  const installDir = path.join(base, 'instalado');
  const portableDir = path.join(base, 'portatil');
  report.carpetas = { base, installDir, portableDir };
  report.archivos = {
    instalador: { bytes: fs.statSync(installer).size, megabytes: Math.round(fs.statSync(installer).size / 1048576) },
    portatil: { bytes: fs.statSync(portable).size, megabytes: Math.round(fs.statSync(portable).size / 1048576) },
  };

  // ---------------------------------------------------------------- 1. instalar en silencio
  log(`instalando en silencio en ${installDir}`);
  const t0 = Date.now();
  const inst = spawnSync(installer, ['/S', `/D=${installDir}`], { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' });
  const exe = path.join(installDir, 'BoneYardDog.exe');
  const startMenu = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BoneYardDog.lnk');
  const desktop = path.join(process.env.USERPROFILE || '', 'Desktop', 'BoneYardDog.lnk');
  const reg = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'BoneYardDog', '/d'], { encoding: 'utf8', windowsHide: true });
  report.pasos.instalar = {
    codigoDeSalida: inst.status,
    ms: Date.now() - t0,
    exeExiste: fs.existsSync(exe),
    accesoMenuInicio: fs.existsSync(startMenu),
    accesoEscritorioEnSilencio: fs.existsSync(desktop),
    entradaDeDesinstalacion: /BoneYardDog/.test(reg.stdout || ''),
    uninstaller: fs.existsSync(path.join(installDir, 'Uninstall BoneYardDog.exe')),
  };
  if (fs.existsSync(installDir)) report.pasos.instalar.contenido = dirStats(installDir);
  if (inst.status !== 0) fail(`instalar: el instalador devolvió ${inst.status} ${inst.error ? inst.error.message : ''}`);
  if (!report.pasos.instalar.exeExiste) fail('instalar: no existe BoneYardDog.exe en la carpeta de instalación');
  if (!report.pasos.instalar.accesoMenuInicio) fail('instalar: no se creó el acceso del menú Inicio');
  if (report.pasos.instalar.accesoEscritorioEnSilencio) fail('instalar: en silencio NO debía crearse el acceso del escritorio');
  if (!report.pasos.instalar.uninstaller) fail('instalar: falta el desinstalador');
  if (/appdata/i.test(installDir)) fail('la carpeta de pruebas está dentro de AppData (protegida)');

  // ---------------------------------------------------------------- 2. app instalada
  if (report.pasos.instalar.exeExiste) {
    log('abriendo la app instalada con la prueba automática…');
    report.pasos.appInstalada = await runApp(exe, 'instalada');
    judgeRun('app instalada', report.pasos.appInstalada);
  }

  // ---------------------------------------------------------------- 3. desinstalar en silencio
  const un = path.join(installDir, 'Uninstall BoneYardDog.exe');
  if (fs.existsSync(un)) {
    log('desinstalando en silencio…');
    // «_?=» hace que el desinstalador no se copie a una carpeta temporal y espere hasta terminar.
    const u = spawnSync(un, ['/S', `_?=${installDir}`], { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' });
    const remaining = [];
    if (fs.existsSync(installDir)) {
      (function walk(d) {
        for (const n of fs.readdirSync(d)) {
          const f = path.join(d, n);
          remaining.push(path.relative(installDir, f));
          if (fs.lstatSync(f).isDirectory()) walk(f);
        }
      })(installDir);
    }
    const onlySelf = remaining.every((r) => r === 'Uninstall BoneYardDog.exe');
    report.pasos.desinstalar = {
      codigoDeSalida: u.status,
      quedanEnLaCarpeta: remaining.slice(0, 20),
      soloQuedaElDesinstalador: onlySelf,
      accesoMenuInicioQuitado: !fs.existsSync(startMenu),
    };
    if (u.status !== 0) fail(`desinstalar: devolvió ${u.status}`);
    if (!onlySelf) fail(`desinstalar: quedaron archivos en la carpeta de instalación: ${remaining.slice(0, 10).join(', ')}`);
    if (!report.pasos.desinstalar.accesoMenuInicioQuitado) fail('desinstalar: el acceso del menú Inicio sigue ahí');
    // El propio desinstalador no puede borrarse mientras corre con _?=: se quita ahora.
    fs.rmSync(installDir, { recursive: true, force: true });
    report.pasos.desinstalar.carpetaBorradaAlFinal = !fs.existsSync(installDir);
  }

  // ---------------------------------------------------------------- 4. portátil
  log('descomprimiendo el .zip portátil…');
  fs.mkdirSync(portableDir, { recursive: true });
  const x = spawnSync('tar', ['-xf', portable, '-C', portableDir], { windowsHide: true, timeout: 5 * 60 * 1000, encoding: 'utf8' });
  const inner = fs.existsSync(portableDir) ? fs.readdirSync(portableDir) : [];
  const root = inner.length === 1 && fs.statSync(path.join(portableDir, inner[0])).isDirectory() ? path.join(portableDir, inner[0]) : portableDir;
  const pexe = path.join(root, 'BoneYardDog.exe');
  report.pasos.portatil = { descomprimir: x.status, carpetaRaiz: path.relative(portableDir, root) || '(raíz)', exeExiste: fs.existsSync(pexe), leeme: fs.existsSync(path.join(root, 'LEEME.txt')), licencia: fs.existsSync(path.join(root, 'LICENSE.txt')) };
  if (fs.existsSync(root)) report.pasos.portatil.contenido = dirStats(root);
  if (!report.pasos.portatil.exeExiste) fail('portátil: no existe BoneYardDog.exe tras descomprimir');
  if (inner.length !== 1) fail(`portátil: el zip debe tener UNA carpeta en la raíz y tiene ${inner.length}`);
  if (report.pasos.portatil.exeExiste) {
    log('abriendo la app portátil con la prueba automática…');
    report.pasos.portatil.app = await runApp(pexe, 'portatil');
    judgeRun('app portátil', report.pasos.portatil.app);
  }
  fs.rmSync(portableDir, { recursive: true, force: true });
  report.pasos.portatil.borrado = !fs.existsSync(portableDir);
  if (!report.pasos.portatil.borrado) fail('portátil: no se pudo borrar la carpeta descomprimida');
  fs.rmSync(base, { recursive: true, force: true });
}

function finish(code, error) {
  if (error) {
    report.fallos.push(`error inesperado: ${(error && error.stack) || error}`);
    code = 1;
  }
  report.ok = code === 0 && report.fallos.length === 0;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(out, 'instalador.json'), JSON.stringify(report, null, 2));
  console.log(`[instalador] ${report.ok ? 'OK' : 'FALLÓ'}`);
  console.log(JSON.stringify({ archivos: report.archivos, pasos: report.pasos }, null, 2).slice(0, 6000));
  for (const f of report.fallos) console.log(`[instalador] FALLO: ${f}`);
  process.exit(report.ok ? 0 : 1);
}

main().then(
  () => finish(0),
  (err) => finish(1, err),
);
