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
  'boneyarddog-cuarentena', // la creó la Fase 3A (ya no se usa); si alguien la tiene, nunca se ofrece
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
 * Clasifica una ruta: ¿está protegida y POR QUÉ? Es la única fuente de las reglas: `isProtectedPath` (orígenes) y
 * `isProtectedDestination` (destinos) la usan las dos.
 * @returns {{protected: boolean, cause: string|null, name?: string, drive?: string}}
 *   causa: 'invalida' | 'relativa' | 'raiz' | 'sistema' | 'corto' | 'usuarios' | 'usuario' | 'appdata' | 'credenciales' | 'perfil' | null
 */
function classifyPath(inputPath, { allowAppData = false } = {}) {
  if (typeof inputPath !== 'string' || inputPath.trim() === '' || inputPath.includes('\0')) return { protected: true, cause: 'invalida' };
  const p = stripExtendedPrefix(inputPath);

  const { root } = path.win32.parse(p);
  if (root === '') return { protected: true, cause: 'relativa' }; // relativa: no se puede saber
  if (/^[a-zA-Z]:$/.test(root)) return { protected: true, cause: 'relativa' }; // relativa a la unidad ("C:foo")
  if (/^[\\/]{2}/.test(root)) return { protected: false, cause: null }; // ruta de red (UNC), fuera de alcance

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

  const drive = `${root[0].toUpperCase()}:`;
  if (parts.length === 0) return { protected: true, cause: 'raiz', drive }; // raíz de la unidad
  const [first] = parts;
  if (PROTECTED_TOP_LEVEL.has(first)) return { protected: true, cause: 'sistema', name: first, drive };
  if (SHORT_NAME_83.test(first)) return { protected: true, cause: 'corto', name: first, drive };
  if (first === 'users') {
    if (parts.length === 1) return { protected: true, cause: 'usuarios', drive };
    if (parts.length === 2) return { protected: true, cause: 'usuario', name: parts[1], drive };
    const inHome = parts[2];
    if (inHome === 'appdata') return allowAppData ? { protected: false, cause: null } : { protected: true, cause: 'appdata', drive };
    if (PROTECTED_IN_USER_HOME.has(inHome)) return { protected: true, cause: 'credenciales', name: inHome, drive };
    if (parts.length === 3 && (inHome.startsWith('ntuser.dat') || inHome === 'ntuser.ini')) return { protected: true, cause: 'perfil', drive };
  }
  return { protected: false, cause: null };
}

/**
 * @param {string} inputPath
 * @param {object} [options]
 * @param {boolean} [options.allowAppData=false] Si es true, AppData deja de estar protegida.
 * @returns {boolean} true si la ruta (o algo que la contenga hacia arriba, ver
 *   reglas arriba) está protegida.
 */
function isProtectedPath(inputPath, options = {}) {
  return classifyPath(inputPath, options).protected;
}

/** Letra de la unidad del sistema («C:»), por SystemDrive o por windir. Sin dato: «C:». */
function systemDriveOf(env = process.env) {
  const fromVar = typeof env.SystemDrive === 'string' && /^[a-zA-Z]:/.test(env.SystemDrive) ? env.SystemDrive.slice(0, 2) : null;
  const fromWindir = typeof env.windir === 'string' && /^[a-zA-Z]:/.test(env.windir) ? env.windir.slice(0, 2) : typeof env.SystemRoot === 'string' && /^[a-zA-Z]:/.test(env.SystemRoot) ? env.SystemRoot.slice(0, 2) : null;
  return (fromVar || fromWindir || 'C:').toUpperCase();
}

/**
 * ¿Esta ruta está protegida COMO DESTINO de una copia? Mismas reglas que los orígenes salvo que la RAÍZ de una unidad
 * (E:\) es un destino válido: solo se bloquea la raíz de la unidad del SISTEMA. Sigue bloqueado: Windows, Archivos de
 * programa, ProgramData, $Recycle.Bin, System Volume Information…, `C:\Users`, `C:\Users\<nombre>` y AppData.
 */
function isProtectedDestination(inputPath, { env = process.env, allowAppData = false } = {}) {
  const c = classifyPath(inputPath, { allowAppData });
  if (!c.protected) return false;
  if (c.cause === 'raiz') return c.drive === systemDriveOf(env);
  return true;
}

/**
 * Explica en llano por qué una ruta no sirve como destino (nombra SIEMPRE la ruta y la razón concreta).
 * Devuelve null si sirve.
 */
function describeProtectedDestination(inputPath, { env = process.env, allowAppData = false } = {}) {
  if (!isProtectedDestination(inputPath, { env, allowAppData })) return null;
  const shown = typeof inputPath === 'string' ? inputPath : String(inputPath);
  const c = classifyPath(inputPath, { allowAppData });
  switch (c.cause) {
    case 'raiz':
      return `${c.drive}\\ es el disco del sistema (donde está Windows): elige una carpeta de otra unidad, o una carpeta tuya dentro de este disco (por ejemplo, dentro de Documentos).`;
    case 'sistema':
      return `«${shown}» está dentro de «${c.name.replace(/\b\w/g, (m) => m.toUpperCase())}», una carpeta del sistema de Windows: elige otra unidad o una carpeta tuya (Documentos, Escritorio…).`;
    case 'usuarios':
      return `«${shown}» es la carpeta C:\\Users, donde Windows guarda a todos los usuarios: elige una carpeta dentro de tus Documentos o de otro disco.`;
    case 'usuario':
      return `«${shown}» es la carpeta personal de un usuario de Windows: elige una carpeta dentro de ella (Documentos, Escritorio…) o de otra unidad.`;
    case 'appdata':
      return `«${shown}» está dentro de AppData, donde los programas guardan su configuración: elige otra carpeta (Documentos, otra unidad…).`;
    case 'credenciales':
      return `«${shown}» guarda claves o credenciales (${c.name}): elige otra carpeta.`;
    case 'perfil':
      return `«${shown}» es parte del perfil de usuario de Windows: elige otra carpeta.`;
    case 'corto':
      return `«${shown}» usa un nombre corto de Windows (8.3) que no se puede comprobar: escribe la ruta con su nombre completo o elige otra.`;
    case 'relativa':
      return `«${shown}» no es una ruta completa (falta la letra de la unidad): elige la carpeta con el selector.`;
    default:
      return `«${shown}» no es una ruta válida como destino.`;
  }
}

/** Explica en llano por qué una ruta no se puede usar como ORIGEN (copiar o transferir). null si sirve. */
function describeProtectedSource(inputPath, { allowAppData = false } = {}) {
  const c = classifyPath(inputPath, { allowAppData });
  if (!c.protected) return null;
  const shown = typeof inputPath === 'string' ? inputPath : String(inputPath);
  switch (c.cause) {
    case 'raiz':
      return `«${shown}» es una unidad completa: elige una carpeta de dentro (copiar un disco entero no está permitido).`;
    case 'sistema':
      return `«${shown}» está dentro de «${c.name}», una carpeta del sistema de Windows: no se puede copiar ni mover.`;
    case 'usuarios':
    case 'usuario':
      return `«${shown}» es una carpeta de usuario de Windows en sí: elige una carpeta de dentro (Documentos, Escritorio…).`;
    case 'appdata':
      return `«${shown}» está dentro de AppData, donde los programas guardan su configuración: no se puede copiar ni mover.`;
    case 'credenciales':
      return `«${shown}» guarda claves o credenciales (${c.name}): no se puede copiar ni mover.`;
    case 'perfil':
      return `«${shown}» es parte del perfil de usuario de Windows: no se puede copiar ni mover.`;
    case 'corto':
      return `«${shown}» usa un nombre corto de Windows (8.3) que no se puede comprobar: usa el nombre completo.`;
    default:
      return `«${shown}» no es una ruta completa válida: elige la carpeta con el selector.`;
  }
}

module.exports = { isProtectedPath, isProtectedDestination, describeProtectedDestination, describeProtectedSource, classifyPath, systemDriveOf };
