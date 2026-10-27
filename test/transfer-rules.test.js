'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/core/transfer-rules');

const codes = (name, fs, opts) => R.checkName(name, fs, opts).map((p) => p.code);

test('FS_LIMITS: valores por formato', () => {
  assert.equal(R.FS_LIMITS.NTFS.maxFileBytes, null);
  assert.equal(R.FS_LIMITS.NTFS.mtimeToleranceMs, 2);
  assert.equal(R.FS_LIMITS.ReFS.mtimeToleranceMs, 2);
  assert.equal(R.FS_LIMITS.exFAT.maxFileBytes, null);
  assert.equal(R.FS_LIMITS.exFAT.mtimeToleranceMs, 2000);
  assert.equal(R.FS_LIMITS.FAT32.maxFileBytes, 4294967295);
  assert.equal(R.FS_LIMITS.FAT32.mtimeToleranceMs, 2000);
  assert.equal(R.FS_LIMITS.FAT32.maxEntriesPerFolder, 20000);
  assert.ok(R.FS_LIMITS.FAT.maxFileBytes > 0);
  assert.equal(R.FS_LIMITS.desconocido.mtimeToleranceMs, 2000, 'la tolerancia más amplia');
  assert.equal(R.FS_LIMITS.desconocido.warnFileAtLeastBytes, 4 * 1024 ** 3);
  assert.equal(R.limitsFor('algo raro'), R.FS_LIMITS.desconocido);
  assert.equal(R.limitsFor(undefined), R.FS_LIMITS.desconocido);
  assert.throws(() => {
    'use strict';
    R.FS_LIMITS.FAT32.maxFileBytes = 1;
  }, TypeError, 'los límites no se pueden modificar');
});

test('espacio: el margen es el mayor entre 64 MB y el 1 %', () => {
  const MB = 1024 ** 2;
  assert.equal(R.freeSpaceMargin(0), 64 * MB);
  assert.equal(R.freeSpaceMargin(1000 * MB), 64 * MB, '1 % de 1000 MB = 10 MB < 64 MB');
  assert.equal(R.freeSpaceMargin(100 * 1024 * MB), Math.ceil(100 * 1024 * MB * 0.01), '1 % de 100 GB > 64 MB');
  assert.equal(R.requiredFreeBytes(1000), 1000 + 64 * MB);
});

test('checkName: nombres válidos (tildes, ñ, espacios, emoji)', () => {
  for (const ok of ['informe.docx', 'canción ñandú 🐕.txt', 'a b c', '.gitignore', 'archivo.tar.gz', 'COM10', 'CONSOLA', 'LPT0', 'NULA.txt', 'x'.repeat(255)]) {
    assert.deepEqual(codes(ok, 'NTFS'), [], ok);
  }
});

test('checkName: caracteres no válidos y de control', () => {
  for (const c of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) assert.ok(codes(`a${c}b`, 'exFAT').includes('caracter-invalido'), c);
  assert.ok(codes('a\u0000b', 'FAT32').includes('control'));
  assert.ok(codes('a\tb', 'FAT32').includes('control'));
  assert.ok(codes('a\u001fb', 'NTFS').includes('control'));
  assert.ok(codes('a\u007fb', 'NTFS').includes('control'));
  assert.match(R.checkName('a:b|c', 'NTFS')[0].message, /: \|/);
});

test('checkName: termina en espacio o punto; ".", ".." y vacío', () => {
  for (const n of ['a ', 'a.', 'a..', 'a  ', 'carpeta.']) assert.ok(codes(n, 'NTFS').includes('termina-en-espacio-o-punto'), JSON.stringify(n));
  assert.ok(codes('.', 'NTFS').includes('punto'));
  assert.ok(codes('..', 'NTFS').includes('punto'));
  assert.deepEqual(codes('', 'NTFS'), ['vacio']);
  assert.deepEqual(codes(null, 'NTFS'), ['vacio']);
  assert.ok(codes('x'.repeat(256), 'NTFS').includes('demasiado-largo'));
});

test('checkName: nombres reservados de Windows, con o sin extensión y en cualquier mayúscula', () => {
  const reservados = ['CON', 'con', 'PRN', 'Aux', 'NUL', 'nul.txt', 'COM1', 'com9.log', 'LPT1', 'lpt9', 'CON.tar.gz', 'AUX.', 'Con .txt'];
  for (const n of reservados) assert.ok(codes(n, 'NTFS').includes('reservado'), n);
  for (const n of ['COM0', 'COM10', 'LPT0', 'CONX', 'XCON', 'NULO', 'mi.CON']) assert.ok(!codes(n, 'NTFS').includes('reservado'), n);
});

test('checkName: colisión de mayúsculas/minúsculas entre hermanos', () => {
  assert.deepEqual(codes('Foto.JPG', 'exFAT', { siblings: ['foto.jpg', 'otra.txt'] }), ['colision-mayusculas']);
  assert.deepEqual(codes('foto.jpg', 'exFAT', { siblings: ['foto.jpg'] }), [], 'el mismo nombre no es choque');
  assert.deepEqual(codes('a', 'NTFS', { siblings: ['b'] }), []);
  assert.deepEqual(codes('Ñandú', 'NTFS', { siblings: ['ñandú'] }), ['colision-mayusculas']);
});

test('checkPathLength: aviso por encima de 240 caracteres', () => {
  assert.deepEqual(R.checkPathLength('D:\\a'), { length: 4, warning: false, limit: 240 });
  assert.equal(R.checkPathLength('D:\\' + 'x'.repeat(237)).warning, false, '240 justo: sin aviso');
  assert.equal(R.checkPathLength('D:\\' + 'x'.repeat(238)).warning, true, '241: aviso');
  assert.equal(R.checkPathLength('D:\\' + 'x'.repeat(300)).length, 303);
  assert.equal(R.checkPathLength(undefined).warning, false);
});

test('isInside: casos de Windows, incluidos los de ataque', () => {
  const I = R.isInside;
  assert.equal(I('D:\\Datos\\sub\\a.txt', 'D:\\Datos'), true);
  assert.equal(I('D:\\Datos', 'D:\\Datos'), true, 'la misma ruta cuenta como dentro');
  assert.equal(I('d:/datos/SUB', 'D:\\DATOS'), true, 'mayúsculas y barras mixtas');
  assert.equal(I('D:\\Datos\\', 'D:\\Datos'), true, 'barra final');
  assert.equal(I('D:\\Datos\\x\\..\\y', 'D:\\Datos'), true);
  assert.equal(I('D:\\Otro\\..\\Datos\\x', 'D:\\Datos'), true, '".." que vuelve adentro');
  assert.equal(I('D:\\Datos \\x', 'D:\\Datos'), true, 'espacio final: Windows lo ignora');
  assert.equal(I('D:\\Datos.\\x', 'D:\\Datos'), true);
  assert.equal(I('\\\\?\\D:\\Datos\\x', 'D:\\Datos'), true, 'prefijo \\\\?\\');
  // Prefijos engañosos y rutas que NO están dentro.
  assert.equal(I('D:\\Datos2', 'D:\\Datos'), false, 'prefijo engañoso');
  assert.equal(I('D:\\Datos2\\x', 'D:\\Datos'), false);
  assert.equal(I('D:\\DatosOld', 'D:\\Datos'), false);
  assert.equal(I('D:\\Datos\\..\\Otro', 'D:\\Datos'), false, '".." que sale');
  assert.equal(I('D:\\Datos\\..', 'D:\\Datos'), false, 'el padre no está dentro del hijo');
  assert.equal(I('D:\\', 'D:\\Datos'), false);
  assert.equal(I('E:\\Datos\\x', 'D:\\Datos'), false, 'otra unidad');
  assert.equal(I('D:\\Datos', 'D:\\Datos\\sub'), false);
  assert.equal(I('D:\\Datos\\x', 'D:\\'), true, 'todo está dentro de la raíz de su unidad');
  assert.equal(I('\\\\srv\\rec\\x', '\\\\srv\\rec'), true);
  assert.equal(I('\\\\srv\\rec2\\x', '\\\\srv\\rec'), false);
});

test('isInside: rutas relativas, inválidas o mezcla de estilos nunca dan "dentro"', () => {
  for (const mala of [undefined, null, '', 5, 'relativa\\x', '..\\x', 'D:x', 'D:Datos\\x', 'D:\\a\0b']) {
    assert.equal(R.isInside(mala, 'D:\\Datos'), false, String(mala));
    assert.equal(R.isInside('D:\\Datos\\x', mala), false, String(mala));
  }
  assert.equal(R.isInside('/datos/x', 'D:\\Datos'), false, 'estilos distintos');
});

test('isInside: rutas de Linux distinguen mayúsculas', () => {
  assert.equal(R.isInside('/tmp/a/b', '/tmp/a'), true);
  assert.equal(R.isInside('/tmp/a2', '/tmp/a'), false);
  assert.equal(R.isInside('/tmp/A/b', '/tmp/a'), false);
  assert.equal(R.isInside('/tmp/a/../b', '/tmp/a'), false);
  assert.equal(R.isInside('/tmp/a/x/../y', '/tmp/a'), true);
});

test('sameVolume: por letra de unidad (sin distinguir mayúsculas)', () => {
  assert.equal(R.sameVolume('C:\\a', 'c:/b'), true);
  assert.equal(R.sameVolume('C:\\a', 'D:\\a'), false);
  assert.equal(R.sameVolume('\\\\srv\\r\\x', '\\\\SRV\\R\\y'), true);
  assert.equal(R.sameVolume('\\\\srv\\r\\x', '\\\\srv\\otro\\y'), false);
  assert.equal(R.sameVolume('C:\\a', '\\\\srv\\r'), false);
  assert.equal(R.sameVolume('/tmp/a', '/tmp/b'), false, 'sin letra no se puede saber: el motor usa st_dev');
  assert.equal(R.sameVolume('relativa', 'C:\\a'), false);
  assert.equal(R.sameVolume(undefined, undefined), false);
});

test('recycleVerdict: extraíble, desconocido, puede no caber y probablemente cabe', () => {
  const GB = 1024 ** 3;
  const fixed = { driveType: 'fixed', sizeBytes: 500 * GB };
  assert.equal(R.recycleVerdict({ bytes: 1 * GB, source: { driveType: 'removable', sizeBytes: 64 * GB } }).verdict, 'sin-papelera');
  assert.equal(R.recycleVerdict({ bytes: 1, source: { driveType: 'network', sizeBytes: 64 * GB } }).verdict, 'sin-papelera');
  assert.equal(R.recycleVerdict({ bytes: 1, source: { driveType: 'cdrom', sizeBytes: 1 } }).verdict, 'sin-papelera');
  assert.equal(R.recycleVerdict({ bytes: 1 * GB, source: { driveType: 'unknown', sizeBytes: 500 * GB } }).verdict, 'desconocido');
  assert.equal(R.recycleVerdict({ bytes: 1 * GB, source: { driveType: 'fixed', sizeBytes: null } }).verdict, 'desconocido');
  assert.equal(R.recycleVerdict({ bytes: 1 * GB, source: { driveType: 'fixed', sizeBytes: 0 } }).verdict, 'desconocido');
  assert.equal(R.recycleVerdict({ bytes: 1 * GB }).verdict, 'desconocido');
  assert.equal(R.recycleVerdict({}).verdict, 'desconocido');
  assert.equal(R.recycleVerdict().verdict, 'desconocido');
  assert.equal(R.recycleVerdict({ bytes: -1, source: fixed }).verdict, 'desconocido');
  assert.equal(R.recycleVerdict({ bytes: 25 * GB, source: fixed }).verdict, 'probablemente-cabe', 'justo el 5 %');
  assert.equal(R.recycleVerdict({ bytes: 25 * GB + 1, source: fixed }).verdict, 'puede-no-caber');
  assert.equal(R.recycleVerdict({ bytes: 0, source: fixed }).verdict, 'probablemente-cabe');
  assert.equal(R.recycleVerdict({ bytes: 400 * GB, source: fixed }).verdict, 'puede-no-caber');
  assert.equal(R.RECYCLE_FRACTION, 0.05);
  for (const v of ['sin-papelera', 'desconocido', 'puede-no-caber', 'probablemente-cabe']) {
    const r = R.recycleVerdict(v === 'sin-papelera' ? { bytes: 1, source: { driveType: 'removable' } } : v === 'desconocido' ? {} : { bytes: v === 'puede-no-caber' ? 100 * GB : 1, source: fixed });
    assert.ok(r.reason.length > 20, `cada veredicto trae su razón en español: ${v}`);
  }
});

test('mtimeClose: tolerancia según el formato', () => {
  const t = 1_700_000_000_000;
  assert.equal(R.mtimeClose(t, t, 'NTFS'), true);
  assert.equal(R.mtimeClose(t, t + 2, 'NTFS'), true);
  assert.equal(R.mtimeClose(t, t + 3, 'NTFS'), false);
  assert.equal(R.mtimeClose(t, t + 2000, 'exFAT'), true);
  assert.equal(R.mtimeClose(t, t + 2001, 'exFAT'), false);
  assert.equal(R.mtimeClose(t, t - 1999, 'FAT32'), true);
  assert.equal(R.mtimeClose(t, t + 1500, 'desconocido'), true, 'formato desconocido: tolerancia amplia');
  assert.equal(R.mtimeClose(t, t + 1500, 'algo raro'), true);
  assert.equal(R.mtimeClose(NaN, t, 'NTFS'), false);
  assert.equal(R.mtimeClose(t, undefined, 'NTFS'), false);
  assert.equal(R.mtimeClose(t, Infinity, 'exFAT'), false);
});
