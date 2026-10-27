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

/** Retirar el original ANTES de verificar: se mueve el bloque de verificación después de la retirada. */
function reorder(src) {
  const startMark = '        // Verificación.\n';
  const endMark = '        // Carpetas: fechas (de las hojas hacia la raíz)';
  const a = src.indexOf(startMark);
  const b = src.indexOf(endMark);
  if (a === -1 || b === -1 || b < a) throw new Error('No se encontró el bloque de verificación');
  const block = src.slice(a + startMark.length, b);
  let without = src.slice(0, a) + src.slice(b);
  const anchor = '      man.resultado = result.resultado;\n      results.push(result);';
  if (!without.includes(anchor)) throw new Error('No se encontró el punto de inserción');
  const late = `      try {\n        const fileEntries = folder.entries.filter((e) => e.type === 'file');\n${block}\n      } catch (err) {\n        errores.push({ ruta: '', codigo: 'VERIF', mensaje: String(err.message) });\n      }\n`;
  without = without.replace(anchor, () => late + anchor);
  return without;
}

const MUTATIONS = [
  { nombre: 'saltar la comparación de huellas', fn: once('if (sha !== srcRec.sha256) {', 'if (false) {') },
  { nombre: 'retirar el original sin verificar', fn: once("if (plan.mode === 'move' && result.resultado === 'copiada-verificada' && result.verificada) {", "if (plan.mode === 'move' && result.resultado !== 'cancelada') {") },
  { nombre: 'permitir sobrescribir (abrir con "w" en vez de "wx")', fn: once("fsp.open(destPath, 'wx')", "fsp.open(destPath, 'w')") },
  { nombre: 'omitir la comprobación de "el origen no cambió"', fn: once('if (changed) {', 'if (false) {') },
  { nombre: 'ignorar el impedimento de FAT32 (archivo demasiado grande)', fn: once('if (tooBig.length) {', 'if (false) {') },
  { nombre: 'cambiar el orden: retirar antes de verificar', fn: reorder },
  { nombre: '(extra) quitarCopiado sin comprobar la ruta real (enlaces intermedios)', fn: once('!strictlyInside(p, container) || !(await parentReallyInside(p, container))', '!strictlyInside(p, container)') },
  { nombre: '(extra) no volver a comprobar la protección antes de retirar', fn: once('} else if (isProtected(folder.source)) {', '} else if (false) {') },
  { nombre: '(extra) retirar el original aunque haya enlaces o ilegibles', fn: once('} else if (folder.links.length || folder.unreadable.length || folder.special.length) {', '} else if (false) {') },
  { nombre: '(extra) quitarCopiado sin negarse cuando ya se retiró un original', fn: once("if (disposed.length) throw new Error(", 'if (false) throw new Error(') },
  { nombre: '(extra) no revisar que el destino no esté dentro del origen', fn: once("if (R.isInside(destinationRoot, s)) block('destino-dentro-del-origen'", "if (false) block('destino-dentro-del-origen'") },
  { nombre: '(3B) ignorar realpath en preflight (comparar solo texto)', fn: once('const realList = await Promise.all(givenList.map(realOf));\n', 'const realList = givenList.map(() => null);\n') },
  { nombre: '(3B) ignorar realpath del destino en preflight', fn: once('const destReal = await realOf(destinationRoot);', 'const destReal = null;') },
  { nombre: '(3B) no volver a resolver realpath del origen antes de retirar', fn: once('if (!(await stillItsOwnRealPath(folder.source))) return', 'if (false) return') },
  { nombre: '(extra) no avisar ni bloquear la falta de espacio', fn: once('if (info.freeBytes < required) {', 'if (false) {') },
];

function runTests() {
  const r = spawnSync(process.execPath, ['--test', 'test/transfer.test.js', 'test/transfer-service.test.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
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
