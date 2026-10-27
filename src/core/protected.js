'use strict';

/**
 * Protecciones: rutas que BoneYardDog nunca debe sugerir para eliminar ni mover.
 *
 * Usa path.win32 para que se comporte igual (y se pruebe igual) en Linux.
 *
 * Qué se protege (en la raíz de CUALQUIER letra de unidad, no solo C:, porque
 * el disco del sistema no siempre es C:). Es protección conservadora: ante la
 * duda, protegido.
 *   - Todo lo que está en: Windows, Program Files, Program Files (x86),
 *     ProgramData, $Recycle.Bin, System Volume Information, Recovery, Boot,
 *     $WinREAgent, $Windows.~BT, $Windows.~WS, $GetCurrent, $SysReset,
 *     Config.Msi, MSOCache, Documents and Settings.
 *   - Archivos del sistema: pagefile.sys, hiberfil.sys, swapfile.sys, bootmgr.
 *   - La raíz de la unidad (C:\) y la carpeta C:\Users.
 *   - La carpeta de cada usuario (C:\Users\<nombre>) pero SOLO ella: lo que
 *     hay dentro (Documents, Desktop, Downloads...) NO está protegido, salvo:
 *       · AppData y todo lo que contiene (se puede desactivar con la opción
 *         `allowAppData`, pensada para un futuro "modo avanzado");
 *       · NTUSER.DAT* y ntuser.ini (el perfil del usuario);
 *       · .ssh, .gnupg y .aws con todo su contenido (claves y credenciales).
 *   - Nombres cortos 8.3 en la raíz (p. ej. PROGRA~1): no se pueden resolver
 *     sin consultar el disco, así que se asumen protegidos.
 *
 * Cómo se normaliza la ruta antes de comparar:
 *   - Sin distinguir mayúsculas/minúsculas; acepta / y \ (y repetidas).
 *   - Resuelve "." y ".." antes de comparar (C:\Temp\..\Windows => C:\Windows).
 *   - Windows ignora espacios y puntos al final de cada nombre
 *     ("C:\Windows ", "C:\Windows.") y los quita aquí también.
 *   - Quita flujos alternos de NTFS ("C:\Windows::$DATA") y el prefijo \\?\.
 *   - Prefijos engañosos: C:\WindowsOld NO es C:\Windows; C:\Windows\System32 sí.
 *
 * Fallo hacia lo seguro: si la entrada no es un texto, está vacía, contiene un
 * carácter nulo, o es una ruta relativa / relativa a la unidad (C:foo), se
 * considera PROTEGIDA, porque no se puede saber a qué apunta.
 *
 * LÍMITES conocidos (no se resuelven sin tocar el disco):
 *   - Rutas de red (\\servidor\recurso\...) se consideran NO protegidas.
 *   - No se resuelven enlaces, junctions ni nombres 8.3 fuera de la raíz.
 *   - Una ruta sin letra de unidad que empieza por \ o / se evalúa como si
 *     estuviera en la raíz de la unidad actual (así también funciona en pruebas
 *     con rutas de Linux, que no tienen nombres de sistema de Windows).
 *   - Esta lista es una red de seguridad, no un permiso: que algo no esté
 *     protegido no significa que sea seguro borrarlo.
 */

const path = require('node:path');

// Carpetas dentro de la carpeta de usuario que guardan claves o credenciales.
const PROTECTED_IN_USER_HOME = new Set(['.ssh', '.gnupg', '.aws']);

const PROTECTED_TOP_LEVEL = new Set([
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  '$recycle.bin',
  'system volume information',
  'recovery',
  'boot',
  'bootmgr',
  '$winreagent',
  '$windows.~bt',
  '$windows.~ws',
  '$getcurrent',
  '$sysreset',
  'config.msi',
  'msocache',
  'documents and settings',
  'pagefile.sys',
  'hiberfil.sys',
  'swapfile.sys',
]);

// Nombre corto 8.3, p. ej. PROGRA~1 o PROGRA~1.TXT
const SHORT_NAME_83 = /^[^~]{1,6}~\d+(\.[^.]{0,3})?$/;

function stripExtendedPrefix(p) {
  // \\?\C:\...  y  \\.\C:\...  =>  C:\...
  return p.replace(/^[\\/]{2}[?.][\\/](?=[a-zA-Z]:)/, '');
}

/**
 * @param {string} inputPath
 * @param {object} [options]
 * @param {boolean} [options.allowAppData=false] Si es true, AppData deja de estar protegida.
 * @returns {boolean} true si la ruta (o algo que la contenga hacia arriba, ver
 *   reglas arriba) está protegida.
 */
function isProtectedPath(inputPath, { allowAppData = false } = {}) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '' || inputPath.includes('\0')) {
    return true;
  }
  const p = stripExtendedPrefix(inputPath);

  const { root } = path.win32.parse(p);
  if (root === '') return true; // relativa: no se puede saber
  if (/^[a-zA-Z]:$/.test(root)) return true; // relativa a la unidad ("C:foo")
  if (/^[\\/]{2}/.test(root)) return false; // ruta de red (UNC), fuera de alcance

  const parts = [];
  for (const raw of p.slice(root.length).split(/[\\/]+/)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      parts.pop();
      continue;
    }
    // Sin flujo alterno (nombre:flujo) ni espacios/puntos finales.
    const name = raw.split(':')[0].replace(/[ .]+$/, '');
    if (name === '') continue;
    parts.push(name.toLowerCase());
  }

  if (parts.length === 0) return true; // raíz de la unidad
  const [first] = parts;
  if (PROTECTED_TOP_LEVEL.has(first)) return true;
  if (SHORT_NAME_83.test(first)) return true;
  if (first === 'users') {
    if (parts.length <= 2) return true; // C:\Users y C:\Users\<nombre>
    const inHome = parts[2];
    if (inHome === 'appdata') return !allowAppData;
    if (PROTECTED_IN_USER_HOME.has(inHome)) return true;
    if (parts.length === 3 && (inHome.startsWith('ntuser.dat') || inHome === 'ntuser.ini')) return true;
  }
  return false;
}

module.exports = { isProtectedPath };
