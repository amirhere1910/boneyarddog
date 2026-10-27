'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseVolumeJson, validateDriveLetter, unknownVolume } = require('../src/core/volume');
const { getVolumeInfo, volumeInfoForPath, buildCommand, powershellPath, TIMEOUT_MS } = require('../src/main/volume-info');

const GB = 1024 ** 3;
const json = (o) => JSON.stringify(o);

test('parseVolumeJson: salidas válidas de los tres formatos (con tipo numérico o con nombre)', () => {
  assert.deepEqual(parseVolumeJson(json({ DriveType: 3, FileSystem: 'NTFS', Size: 500 * GB, SizeRemaining: 120 * GB })), { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 500 * GB, freeBytes: 120 * GB });
  assert.deepEqual(parseVolumeJson(json({ DriveType: 'Removable', FileSystem: 'exFAT', Size: 64 * GB, SizeRemaining: 60 * GB })), { driveType: 'removable', fileSystem: 'exFAT', sizeBytes: 64 * GB, freeBytes: 60 * GB });
  assert.deepEqual(parseVolumeJson(json({ DriveType: 2, FileSystem: 'FAT32', Size: 16 * GB, SizeRemaining: 15 * GB })), { driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 16 * GB, freeBytes: 15 * GB });
  assert.equal(parseVolumeJson(json({ DriveType: 'Remote', FileSystem: 'NTFS', Size: 1, SizeRemaining: 1 })).driveType, 'network');
  assert.equal(parseVolumeJson(json({ DriveType: 'CD-ROM', FileSystem: 'UDF', Size: 1, SizeRemaining: 0 })).driveType, 'cdrom');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: 'fat', Size: 1, SizeRemaining: 1 })).fileSystem, 'FAT');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: 'ReFS', Size: 1, SizeRemaining: 1 })).fileSystem, 'ReFS');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: 'ntfs', Size: 1, SizeRemaining: 1 })).fileSystem, 'NTFS', 'sin distinguir mayúsculas');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: 'CDFS', Size: 1, SizeRemaining: 1 })).fileSystem, 'otro');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: '', Size: 1, SizeRemaining: 1 })).fileSystem, 'desconocido');
  assert.equal(parseVolumeJson(json({ DriveType: 3, FileSystem: null, Size: 1, SizeRemaining: 1 })).fileSystem, 'desconocido');
  assert.equal(parseVolumeJson(json({ DriveType: 99, FileSystem: 'NTFS', Size: 1, SizeRemaining: 1 })).driveType, 'unknown');
});

test('parseVolumeJson: cualquier cosa rara devuelve "desconocido" sin lanzar', () => {
  const unknown = unknownVolume();
  assert.deepEqual(unknown, { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null });
  const basura = [
    '',
    'no es json',
    '{',
    'null',
    '[]',
    '[1,2]',
    '"texto"',
    '42',
    'true',
    json({}),
    json({ DriveType: 3 }),
    json({ DriveType: 3, FileSystem: 'NTFS', Size: 1, SizeRemaining: 1, Extra: 'x' }), // clave extra
    json({ DriveType: 3, FileSystem: 'NTFS', Size: 1 }), // falta una
    json({ DriveType: 3, FileSystem: 'NTFS', Size: 1, SizeRemaining: 1, __proto__: { x: 1 } }).replace('{', '{"constructor":1,'),
    'x'.repeat(5000),
    undefined,
    null,
    42,
    {},
    [],
  ];
  for (const b of basura) assert.doesNotThrow(() => parseVolumeJson(b), String(b).slice(0, 30));
  for (const b of basura) assert.deepEqual(parseVolumeJson(b), unknown, String(b).slice(0, 40));
});

test('parseVolumeJson: tamaños inválidos quedan en null, el resto se conserva', () => {
  for (const mal of [-1, 'mucho', null, NaN, 1e300, {}, [], true]) {
    const r = parseVolumeJson(`{"DriveType":3,"FileSystem":"NTFS","Size":${JSON.stringify(mal) ?? 'null'},"SizeRemaining":5}`);
    assert.equal(r.sizeBytes, null, String(mal));
    assert.equal(r.freeBytes, 5);
    assert.equal(r.fileSystem, 'NTFS');
  }
});

test('validateDriveLetter: solo una letra mayúscula A–Z', () => {
  assert.equal(validateDriveLetter('C'), 'C');
  assert.equal(validateDriveLetter('Z'), 'Z');
  for (const mal of ['', 'c', 'CC', 'C:', 'C:\\x', 'C:\\', ';', 'C;calc', '1', ' ', 'Ñ', '\0', null, undefined, 3, ['C'], { toString: () => 'C' }]) {
    assert.throws(() => validateDriveLetter(mal), TypeError, JSON.stringify(mal));
  }
});

test('getVolumeInfo: letras sospechosas se rechazan ANTES de ejecutar nada', async () => {
  let calls = 0;
  const run = async () => {
    calls++;
    return { stdout: '' };
  };
  for (const mal of [';', 'C:\\x', 'c', '', 'C;Remove-Item', '$(calc)', null, undefined, 'CD', '`', '|']) {
    await assert.rejects(() => getVolumeInfo(mal, { run, platform: 'win32' }), TypeError, JSON.stringify(mal));
    assert.throws(() => buildCommand(mal), TypeError);
  }
  assert.equal(calls, 0, 'no se ejecutó nada');
});

test('getVolumeInfo: los argumentos pasados a run son exactamente los fijos', async () => {
  const seen = [];
  const run = async (file, args) => {
    seen.push({ file, args });
    return { stdout: json({ DriveType: 3, FileSystem: 'NTFS', Size: 100, SizeRemaining: 40 }) };
  };
  const info = await getVolumeInfo('D', { run, platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  assert.deepEqual(info, { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 100, freeBytes: 40 });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Volume -DriveLetter D | Select-Object DriveType,FileSystem,Size,SizeRemaining | ConvertTo-Json -Compress'],
  });
  assert.ok(path.win32.isAbsolute(seen[0].file));
});

test('powershellPath: ruta absoluta; un SystemRoot raro no se usa', () => {
  assert.equal(powershellPath({ SystemRoot: 'D:\\WINNT' }), 'D:\\WINNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  for (const raro of [undefined, '', 'relativo', '..\\x', 5, ['C:\\Windows']]) {
    assert.equal(powershellPath({ SystemRoot: raro }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  }
});

test('getVolumeInfo: salida basura, error o tiempo agotado => desconocido (con respaldo de statfs para el espacio libre)', async () => {
  const statfs = async () => ({ bsize: 4096, blocks: 1000, bavail: 250 });
  const unknownWithStatfs = { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: 4096000, freeBytes: 1024000 };
  assert.deepEqual(await getVolumeInfo('E', { run: async () => ({ stdout: 'basura' }), platform: 'win32', statfs }), unknownWithStatfs);
  assert.deepEqual(await getVolumeInfo('E', { run: async () => { throw Object.assign(new Error('timeout'), { killed: true, code: null }); }, platform: 'win32', statfs }), unknownWithStatfs);
  assert.deepEqual(await getVolumeInfo('E', { run: async () => ({ stdout: json({ DriveType: 3, FileSystem: 'NTFS', Size: 'x', SizeRemaining: 'y' }) }), platform: 'win32', statfs }), { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 4096000, freeBytes: 1024000 });
  // Sin statfs disponible: todo desconocido, sin lanzar.
  const nothing = await getVolumeInfo('E', { run: async () => ({ stdout: '' }), platform: 'win32', statfs: async () => { throw new Error('no'); } });
  assert.deepEqual(nothing, unknownVolume());
  // Tiempo agotado real: una función run que nunca termina debe ser cortada por quien la implementa;
  // aquí solo comprobamos la constante documentada.
  assert.equal(TIMEOUT_MS, 8000);
});

test('getVolumeInfo: en otros sistemas operativos no ejecuta nada', async () => {
  let calls = 0;
  const run = async () => { calls++; return { stdout: '' }; };
  assert.deepEqual(await getVolumeInfo('C', { run, platform: 'linux' }), unknownVolume());
  assert.deepEqual(await getVolumeInfo('C', { run, platform: 'darwin' }), unknownVolume());
  assert.equal(calls, 0);
  // Con una carpeta raíz explícita sí respalda con statfs.
  const info = await getVolumeInfo('C', { run, platform: 'linux', rootPath: '/', statfs: async () => ({ bsize: 1024, blocks: 10, bavail: 4 }) });
  assert.deepEqual(info, { driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: 10240, freeBytes: 4096 });
});

test('volumeInfoForPath: letra de Windows -> PowerShell; otras rutas -> statfs real', async () => {
  const seen = [];
  const run = async (file, args) => { seen.push(args[3]); return { stdout: json({ DriveType: 2, FileSystem: 'exFAT', Size: 10, SizeRemaining: 5 }) }; };
  const w = await volumeInfoForPath('f:\\Datos\\x', { run, platform: 'win32' });
  assert.equal(w.fileSystem, 'exFAT');
  assert.match(seen[0], /-DriveLetter F /);
  const real = await volumeInfoForPath(__dirname);
  // Fuera de Windows solo hay statfs (sin formato); en Windows la letra real se consulta por PowerShell.
  if (process.platform === 'win32') assert.equal(typeof real.fileSystem, 'string');
  else assert.equal(real.fileSystem, 'desconocido');
  assert.ok(real.freeBytes === null || real.freeBytes >= 0);
  assert.ok(real.sizeBytes === null || real.sizeBytes > 0);
});

test('child_process solo se usa en src/main/volume-info.js (y siempre con execFile, sin shell)', () => {
  const offenders = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && /child_process|\bexecSync\b|\bspawnSync\b/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(path.join(__dirname, '..'), full));
    }
  })(path.join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, [path.join('src', 'main', 'volume-info.js')]);
  const own = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'volume-info.js'), 'utf8');
  assert.doesNotMatch(own, /(?<![.\w])exec\(|\bexecSync\b|\bspawn\(|\bspawnSync\b|shell:\s*true/);
  assert.match(own, /shell: false/);
  assert.match(own, /windowsHide: true/);
});
