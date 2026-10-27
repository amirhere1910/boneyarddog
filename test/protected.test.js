'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isProtectedPath } = require('../src/core/protected');

function check(rutas, esperado) {
  for (const ruta of rutas) {
    assert.equal(isProtectedPath(ruta), esperado, `${JSON.stringify(ruta)} debía dar ${esperado}`);
  }
}

test('carpetas del sistema, en cualquier combinación de mayúsculas y barras', () => {
  check(
    [
      'C:\\Windows',
      'c:\\windows',
      'C:\\WINDOWS',
      'C:/Windows',
      'c:/WiNdOwS',
      'C:\\Windows\\',
      'C:\\Windows\\System32',
      'C:\\WINDOWS\\system32\\drivers\\etc\\hosts',
      'C:/Windows\\System32/config',
      'C:\\Program Files',
      'C:\\Program Files\\Mi App\\app.exe',
      'C:\\PROGRAM FILES (X86)',
      'C:\\Program Files (x86)\\Otro',
      'C:\\ProgramData',
      'C:\\ProgramData\\Microsoft\\Windows',
      'C:\\$Recycle.Bin',
      'C:\\$RECYCLE.BIN\\S-1-5-21-1\\$R123.txt',
      'C:\\System Volume Information',
      'c:\\system volume information\\x',
    ],
    true,
  );
});

test('archivos del sistema: pagefile, hiberfil, swapfile', () => {
  check(
    ['C:\\pagefile.sys', 'C:\\hiberfil.sys', 'C:\\swapfile.sys', 'c:/PAGEFILE.SYS', 'C:\\HiberFil.Sys'],
    true,
  );
});

test('también en otras letras de unidad', () => {
  check(['D:\\Windows', 'E:\\Program Files\\x', 'D:\\$Recycle.Bin', 'F:\\pagefile.sys'], true);
});

test('la carpeta de usuario está protegida, pero no su contenido', () => {
  check(['C:\\Users', 'C:\\Users\\', 'C:\\Users\\amir', 'C:\\Users\\amir\\', 'c:/users/AMIR', 'C:\\Users\\Public', 'C:\\Users\\Mi Nombre'], true);
  check(
    [
      'C:\\Users\\amir\\Documents',
      'C:\\Users\\amir\\Desktop',
      'C:\\Users\\amir\\Downloads\\instalador.exe',
      'c:/users/amir/documents/Windows',
      'C:\\Users\\amir\\Pictures\\2024\\foto.jpg',
      'C:\\Users\\amir\\AppData', // decisión: no está en la lista (ver docs)
    ],
    false,
  );
});

test('la raíz de la unidad está protegida', () => {
  check(['C:\\', 'C:/', 'D:\\', 'c:\\'], true);
});

test('ATAQUE: rutas con ".." que desembocan en lugares protegidos', () => {
  check(
    [
      'C:\\Temp\\..\\Windows',
      'C:\\Temp\\..\\Windows\\System32',
      'C:\\Users\\amir\\..\\..\\Windows',
      'C:\\Users\\amir\\Documents\\..\\..\\..\\Program Files',
      'C:\\Datos\\..\\..\\..\\Windows', // sube más allá de la raíz y se queda en C:\
      'C:\\Windows\\..\\Windows\\System32',
      'C:/Users/amir/../../ProgramData/x',
      'C:\\Users\\amir\\Documents\\..', // => C:\Users\amir
      'C:\\Windows\\..', // => C:\
      'C:\\Users\\..', // => C:\
    ],
    true,
  );
});

test('ATAQUE: ".." que sale de lo protegido hacia un lugar libre', () => {
  check(['C:\\Windows\\..\\Datos', 'C:\\Program Files\\..\\Fotos\\a.jpg', 'C:\\Users\\amir\\..\\Public\\Docs'], false);
});

test('ATAQUE: mayúsculas mezcladas y barras mixtas / repetidas', () => {
  check(
    [
      'C:\\WiNdOwS\\SyStEm32',
      'c:/WINDOWS\\system32',
      'C:\\\\Windows\\\\System32',
      'C://Windows//System32',
      'C:\\Windows\\.\\System32',
      'C:\\Windows\\\\',
      'C:\\pRoGrAm FiLeS\\x',
    ],
    true,
  );
});

test('ATAQUE: espacios y puntos al final (Windows los ignora)', () => {
  check(
    [
      'C:\\Windows ',
      'C:\\Windows  ',
      'C:\\Windows.',
      'C:\\Windows...',
      'C:\\Windows \\System32',
      'C:\\Windows.\\System32',
      'C:\\Windows\\System32 ',
      'C:\\Program Files \\x',
      'C:\\Users\\amir ',
      'C:\\Users\\amir.',
      'C:\\pagefile.sys ',
      'C:\\Windows\\ .. \\x', // ".. " no se interpreta como subir: se queda dentro de Windows
    ],
    true,
  );
});

test('ATAQUE: flujos alternos NTFS, prefijo \\\\?\\ y nombres cortos 8.3', () => {
  check(
    [
      'C:\\Windows::$DATA',
      'C:\\Windows:stream',
      'C:\\pagefile.sys::$DATA',
      '\\\\?\\C:\\Windows\\System32',
      '\\\\?\\c:\\program files',
      '\\\\.\\C:\\Windows',
      'C:\\PROGRA~1',
      'C:\\PROGRA~1\\Mi App',
      'C:\\PROGRA~2\\x',
      'C:\\WINDOW~1\\System32',
    ],
    true,
  );
});

test('ATAQUE: prefijos engañosos NO son protegidos (C:\\WindowsOld no es C:\\Windows)', () => {
  check(
    [
      'C:\\WindowsOld',
      'C:\\WindowsOld\\System32',
      'C:\\Windows.old',
      'C:\\Windows.old\\Users',
      'C:\\Windowsx',
      'C:\\xWindows',
      'C:\\Program Files Extra',
      'C:\\Program Files2\\x',
      'C:\\ProgramDataBackup',
      'C:\\pagefile.sys.old',
      'C:\\Datos\\pagefile.sys.bak',
      'C:\\$Recycle.Bin.old',
      'C:\\Usuarios\\amir',
      'C:\\Users2\\amir',
    ],
    false,
  );
});

test('lo protegido solo cuenta en la raíz: una carpeta "Windows" más adentro es libre', () => {
  check(['C:\\Data\\Windows', 'C:\\Data\\Program Files\\x', 'D:\\Backups\\Windows\\System32', 'C:\\Users\\amir\\Documents\\Program Files'], false);
});

test('rutas normales y de otros discos no son protegidas', () => {
  check(['C:\\Temp', 'C:\\Datos\\viejo.iso', 'D:\\Fotos', 'D:\\Fotos\\2019\\a.jpg', 'C:\\Users\\amir\\Documents\\..\\Documents'], false);
});

test('entradas inválidas o ambiguas: se asumen protegidas (fallo seguro)', () => {
  check(['', '   ', null, undefined, 42, {}, [], 'Windows\\System32', 'carpeta\\sub', '.\\x', '..\\x', 'C:foo', 'C:Windows', 'C:\\Win\0dows'], true);
});

test('rutas de red (UNC) quedan fuera del alcance de la lista (límite documentado)', () => {
  check(['\\\\servidor\\recurso\\Windows', '\\\\servidor\\c$\\Windows\\System32'], false);
});

test('rutas estilo Linux/temporales (como las de las pruebas) no se marcan', () => {
  check(['/tmp/byd-scan-abc/a.txt', '/home/user/doc.txt', '/r/d/x'], false);
  // La raíz sin unidad sí cuenta como raíz.
  check(['/', '\\'], true);
  // Ruta sin unidad que parece de sistema: se evalúa en la raíz de la unidad actual.
  check(['/Windows/System32', '\\Windows'], true);
});
