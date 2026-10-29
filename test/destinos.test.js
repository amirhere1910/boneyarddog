'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listDestinationDrives } = require('../src/main/drives');

const INFO = {
  C: { driveType: 'fixed', fileSystem: 'NTFS', sizeBytes: 500e9, freeBytes: 100e9 },
  E: { driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 32e9, freeBytes: 30e9 },
  F: { driveType: 'fixed', fileSystem: 'exFAT', sizeBytes: 2e12, freeBytes: 1e12 },
  Z: { driveType: 'network', fileSystem: 'NTFS', sizeBytes: 1e12, freeBytes: 1e12 },
  D: { driveType: 'cdrom', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null },
};

test('unidades de destino: tipo, formato, libre y total; sin discos de red ni CD', async () => {
  const letters = new Set(Object.keys(INFO));
  const asked = [];
  const list = await listDestinationDrives({
    platform: 'win32',
    exists: async (root) => letters.has(root[0]),
    getInfo: async (letter, root) => {
      asked.push([letter, root]);
      return INFO[letter];
    },
  });
  assert.deepEqual(list.map((d) => d.letter), ['C', 'E', 'F']);
  assert.deepEqual(list.find((d) => d.letter === 'E'), { letter: 'E', path: 'E:\\', driveType: 'removable', fileSystem: 'FAT32', sizeBytes: 32e9, freeBytes: 30e9 });
  assert.ok(asked.every(([l, root]) => /^[A-Z]$/.test(l) && root === `${l}:\\`), 'a getInfo solo llegan letras mayúsculas y su raíz');
});

test('unidades de destino: si una consulta falla o devuelve basura, la unidad sigue apareciendo como desconocida', async () => {
  const list = await listDestinationDrives({
    platform: 'win32',
    exists: async (root) => root[0] === 'G' || root[0] === 'H',
    getInfo: async (letter) => {
      if (letter === 'G') throw new Error('PowerShell no respondió');
      return { driveType: 5, fileSystem: null, sizeBytes: 'mucho', freeBytes: NaN };
    },
  });
  assert.deepEqual(list, [
    { letter: 'G', path: 'G:\\', driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null },
    { letter: 'H', path: 'H:\\', driveType: 'unknown', fileSystem: 'desconocido', sizeBytes: null, freeBytes: null },
  ]);
});

test('unidades de destino: fuera de Windows no hay letras', async () => {
  assert.deepEqual(await listDestinationDrives({ platform: 'linux', exists: async () => true, getInfo: async () => INFO.C }), []);
});
