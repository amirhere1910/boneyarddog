'use strict';

/**
 * Pruebas de mutación del motor de transferencia: rompe el código A PROPÓSITO, ejecuta las pruebas y
 * comprueba que alguna falle. Si una mutación sobrevive (ninguna prueba falla), las pruebas tienen un hueco.
 *
 * Uso: node scripts/mutaciones-transferencia.js [texto]   (con un texto, solo corre las mutaciones cuyo nombre lo contenga)
 * Siempre restaura el archivo original (incluso si se interrumpe con un error).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILE = path.join(__dirname, '..', 'src', 'core', 'transfer.js');
const original = fs.readFileSync(FILE, 'utf8');

function once(find, replace) {
  return (src) => {
    const i = src.indexOf(find);
    if (i === -1 || src.indexOf(find, i + 1) !== -1) throw new Error(`El texto a mutar debe aparecer exactamente una vez: ${find.slice(0, 60)}`);
    return src.replace(find, () => replace);
  };
}

/** Varias mutaciones juntas. */
const chain = (...fns) => (src) => fns.reduce((acc, f) => f(acc), src);

const MUTATIONS = [
  { nombre: 'saltar la comparación de huellas', fn: once('if (sha !== srcRec.sha256) {', 'if (false) {') },
  { nombre: 'retirar el original sin verificar', fn: once("if (plan.mode === 'move' && result.resultado === 'copiada-verificada' && result.verificada) {", "if (plan.mode === 'move' && result.resultado !== 'cancelada') {") },
  { nombre: 'permitir sobrescribir (abrir con "w" en vez de "wx")', fn: once("fsp.open(destPath, 'wx')", "fsp.open(destPath, 'w')") },
  { nombre: 'omitir la comprobación de "el origen no cambió"', fn: once('if (changed) {', 'if (false) {') },
  { nombre: 'ignorar el impedimento de FAT32 (archivo demasiado grande)', fn: once('if (tooBig.length) {', 'if (false) {') },
  { nombre: 'renombrar a su nombre final SIN verificar (aunque haya errores)', fn: once('if (errores.length > 0) {\n          result.resultado = \'con-errores\';\n          result.motivo = `${errores.length} problema(s) al copiar o verificar.', 'if (false) {\n          result.resultado = \'con-errores\';\n          result.motivo = `${errores.length} problema(s) al copiar o verificar.') },
  { nombre: 'copiar DIRECTO al nombre final (sin carpeta provisional)', fn: once('const workPath = nodePath.join(destRoot, names.workName);', 'const workPath = nodePath.join(destRoot, names.finalName);') },
  { nombre: 'SOBRESCRIBIR en el renombrado final (no comprobar que el nombre final no existe)', fn: once("    if (exists) return { ok: false, reason: 'ya existe algo con ese nombre' };\n", '') },
  { nombre: '(5) no usar «(2)»: mezclar con lo que ya existe con ese nombre', fn: once('for (let n = 2; has(finalName); n++) finalName = `${base} (${n})`;', '') },
  { nombre: '(5) cancelar o fallar sin limpiar la copia incompleta', fn: once('if (ctx.workCreated && !ctx.renamed && !ctx.keepWork) {', 'if (false) {') },
  { nombre: '(5) la copia en el destino ya no se exige DENTRO del destino elegido al borrar el original', fn: once('if (!strictlyInside(realDest, realRoot) || ', 'if (') },
  { nombre: '(5) limpiar copias incompletas sin consultar el diario de la app', fn: once('entry.ruta !== ruta || ', '') },
  { nombre: '(5) limpiar copias incompletas siguiendo enlaces', fn: once('if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(\'Esa ruta no es una carpeta normal: no se toca\');', '') },
  { nombre: '(5) verificar: decir «bien» con 0 archivos comprobados', fn: once("const estado = real.length > 0 ? 'problemas' : checked === 0 ? 'sin-archivos' : 'ok';", "const estado = real.length > 0 ? 'problemas' : 'ok';") },
  { nombre: '(extra) quitarCopiado sin comprobar la ruta real (enlaces intermedios)', fn: once('!strictlyInside(p, container) || !(await parentReallyInside(p, container))', '!strictlyInside(p, container)') },
  { nombre: '(extra) no volver a comprobar la protección antes de retirar', fn: once('} else if (isProtected(folder.source)) {', '} else if (false) {') },
  { nombre: '(extra) retirar el original aunque haya enlaces o ilegibles', fn: once('} else if (folder.links.length || folder.unreadable.length || folder.special.length) {', '} else if (false) {') },
  { nombre: '(extra) quitarCopiado sin negarse cuando ya se retiró un original', fn: once("resultado.carpetas.some((c) => ['original-enviado-a-papelera', 'original-borrado-definitivamente', 'borrado-parcial'].includes(c.resultado))) {\n      throw new Error('No se puede quitar la copia", "false) {\n      throw new Error('No se puede quitar la copia") },
  { nombre: '(extra) no revisar que el destino no esté dentro del origen', fn: once('if (R.isInside(destinationRoot, g) || R.isInside(destEff, effList[i])) {', 'if (false) {') },
  { nombre: '(3B) borrado definitivo: borrar sin verificar la copia', fn: once("if (verified !== true || verify !== 'full') return keep(", 'if (false) return keep(') },
  { nombre: '(3B) borrado definitivo: borrar sin confirmación', fn: once("if (confirm !== true) return keep('Falta la confirmación del borrado definitivo: el original sigue", "if (false) return keep('Falta la confirmación del borrado definitivo: el original sigue") },
  { nombre: '(3B) borrado definitivo: borrar sin recomprobar el origen', fn: once('    const changed = await sourceChangeReason(folder);\n    if (changed) return keep(`El origen cambió', '    const changed = null;\n    if (changed) return keep(`El origen cambió') },
  { nombre: '(3B) borrado definitivo: borrar sin recomprobar la copia', fn: once('if (lost) return keep(', 'if (false) return keep(') },
  {
    nombre: '(3B) borrado definitivo: borrar siguiendo enlaces (sin las guardas de enlaces ni de ruta real)',
    fn: chain(
      once('await fsp.rm(sourcePath, { recursive: true, force: false });', 'await fsp.rm(await fsp.realpath(sourcePath), { recursive: true, force: false });'),
      once('if (!(await stillItsOwnRealPath(folder.source))) return', 'if (false) return'),
    ),
  },
  { nombre: '(3B) borrado definitivo: borrar aunque haya enlaces o ilegibles', fn: once("if (folder.links.length || folder.unreadable.length || folder.special.length) {\n      return keep(", 'if (false) {\n      return keep(') },
  { nombre: '(3B) eliminarDefinitivamente: aceptar cualquier índice (sin validar el estado de la carpeta)', fn: once("if (c.resultado !== 'original-sin-tocar' || !['papelera-fallo', 'papelera-no-cabe'].includes(c.motivoCodigo)) {", 'if (false) {') },
  { nombre: '(3B) eliminarDefinitivamente: sin exigir confirmación', fn: once("if (confirm !== true) throw new Error('Falta la confirmación del borrado definitivo');", '') },
  { nombre: '(3B) ignorar realpath en preflight (comparar solo texto)', fn: once('const realList = await Promise.all(givenList.map(realOf));\n', 'const realList = givenList.map(() => null);\n') },
  { nombre: '(3B) ignorar realpath del destino en preflight', fn: once('const destReal = await realOf(destinationRoot);', 'const destReal = null;') },
  { nombre: '(3B) no volver a resolver realpath del origen antes de retirar', fn: once('if (!(await stillItsOwnRealPath(folder.source))) return', 'if (false) return') },
  { nombre: '(extra) no avisar ni bloquear la falta de espacio', fn: once('if (info.freeBytes < required) {', 'if (false) {') },
];

function runTests() {
  const r = spawnSync(process.execPath, ['--test', 'test/transfer.test.js', 'test/transfer-service.test.js', 'test/copia-simple.test.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const out = `${r.stdout}\n${r.stderr}`;
  const grab = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(out) || [])[1] || 0);
  return { fail: grab('fail'), pass: grab('pass'), status: r.status, firstFailure: (/^not ok \d+ - (.+)$/m.exec(out) || [])[1] || null };
}

const base = runTests();
console.log(`Sin mutar: ${base.pass} pasan, ${base.fail} fallan\n`);
if (base.fail !== 0 || base.status !== 0) {
  console.error('Las pruebas ya fallan sin mutar: arréglalas primero.');
  process.exit(2);
}

const filter = process.argv[2];
const selected = filter ? MUTATIONS.filter((m) => m.nombre.includes(filter)) : MUTATIONS;
let survivors = 0;
try {
  for (const m of selected) {
    const mutated = m.fn(original);
    if (mutated === original) throw new Error(`La mutación no cambió nada: ${m.nombre}`);
    fs.writeFileSync(FILE, mutated);
    const res = runTests();
    fs.writeFileSync(FILE, original);
    const detected = res.fail > 0 || res.status !== 0;
    if (!detected) survivors++;
    console.log(`${detected ? 'DETECTADA ' : 'SOBREVIVIÓ '} ${m.nombre}\n    pruebas que fallaron: ${res.fail}${res.firstFailure ? ` (p. ej. «${res.firstFailure}»)` : ''}`);
  }
} finally {
  fs.writeFileSync(FILE, original);
}
console.log(`\n${selected.length - survivors} de ${selected.length} mutaciones detectadas.`);
process.exit(survivors === 0 ? 0 : 1);
