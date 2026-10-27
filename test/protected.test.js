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

test('protecciones nuevas: AppData, NTUSER.DAT*, .ssh y carpetas de instalación/actualización', () => {
  check(
    [
      'C:\\Users\\amir\\AppData',
      'C:\\Users\\amir\\AppData\\Roaming\\Foo',
      'C:\\Users\\amir\\AppData\\Local\\Google\\Chrome\\User Data',
      'D:\\Users\\Otro\\appdata\\local',
      'C:\\Users\\amir\\NTUSER.DAT',
      'C:\\Users\\amir\\ntuser.dat.LOG1',
      'C:\\Users\\amir\\NTUSER.DAT{6cced2f1-6e01-11de-8bed-001e0bcd1824}.TM.blf',
      'C:\\Users\\amir\\ntuser.ini',
      'C:\\Users\\amir\\.ssh',
      'C:\\Users\\amir\\.ssh\\id_rsa',
      'c:/users/AMIR/.SSH/known_hosts',
      'C:\\Users\\amir\\.gnupg\\pubring.kbx',
      'C:\\Users\\amir\\.aws\\credentials',
      'C:\\Config.Msi',
      'C:\\Config.Msi\\x.rbf',
      'C:\\$Windows.~BT',
      'C:\\$Windows.~BT\\Sources',
      'C:\\$Windows.~WS',
      'C:\\$GetCurrent',
      'C:\\$SysReset\\Logs',
      'C:\\MSOCache',
      'C:\\MSOCache\\All Users',
      'C:\\Documents and Settings',
      'D:\\Documents and Settings\\x',
      // con trucos de ruta
      'C:\\Users\\amir\\Documents\\..\\AppData\\Roaming',
      'C:\\Users\\amir\\AppData \\Roaming',
      'C:\\Users\\amir\\.ssh.\\id_rsa',
    ],
    true,
  );
});

test('siguen SIN protección: Documents, Desktop, Downloads de cualquier usuario y parecidos', () => {
  check(
    [
      'C:\\Users\\amir\\Documents',
      'C:\\Users\\amir\\Documents\\informe.docx',
      'C:\\Users\\amir\\Desktop',
      'C:\\Users\\maria\\Desktop\\x.txt',
      'C:\\Users\\amir\\Downloads',
      'D:\\Users\\otro\\Downloads\\a.zip',
      'C:\\Users\\amir\\Documents\\AppData', // AppData anidada en Documents: es un nombre cualquiera
      'C:\\Users\\amir\\Documents\\.ssh',
      'C:\\Users\\amir\\AppDataBackup',
      'C:\\Users\\amir\\ntuser.dat.bak\\x', // solo se protege el archivo suelto en la carpeta de usuario
      'C:\\Data\\Config.Msi',
      'C:\\Data\\MSOCache',
      'C:\\Config.Msi.old',
      'C:\\MSOCache2',
    ],
    false,
  );
});

test('opción allowAppData: AppData deja de estar protegida, lo demás sigue igual', () => {
  const opt = { allowAppData: true };
  assert.equal(isProtectedPath('C:\\Users\\amir\\AppData\\Roaming\\Foo'), true, 'por defecto protegida');
  assert.equal(isProtectedPath('C:\\Users\\amir\\AppData\\Roaming\\Foo', { allowAppData: false }), true);
  assert.equal(isProtectedPath('C:\\Users\\amir\\AppData\\Roaming\\Foo', opt), false);
  assert.equal(isProtectedPath('C:\\Users\\amir\\AppData', opt), false);
  // Todo lo demás se mantiene protegido.
  for (const r of ['C:\\Windows\\System32', 'C:\\Users\\amir', 'C:\\Users\\amir\\.ssh\\id_rsa', 'C:\\Users\\amir\\NTUSER.DAT', 'C:\\Users\\amir\\AppData\\..\\.ssh\\k']) {
    assert.equal(isProtectedPath(r, opt), true, r);
  }
});
