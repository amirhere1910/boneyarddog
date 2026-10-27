'use strict';

/**
 * Unidades de Windows (A:–Z:). En otros sistemas no hay letras: lista vacía.
 * `exists` se inyecta para poder probarlo sin discos reales.
 */

const fsp = require('node:fs/promises');

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

async function defaultExists(root) {
  // Un disco de red desconectado puede tardar mucho: se espera poco por cada uno.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 1500).unref());
  const check = fsp.access(root).then(
    () => true,
    () => false,
  );
  return Promise.race([check, timeout]);
}

/** @returns {Promise<Array<{letter: string, path: string}>>} */
async function listDrives({ platform = process.platform, exists = defaultExists } = {}) {
  if (platform !== 'win32') return [];
  const found = await Promise.all(LETTERS.map(async (letter) => ((await exists(`${letter}:\\`)) ? { letter, path: `${letter}:\\` } : null)));
  return found.filter(Boolean);
}

/**
 * Unidades que pueden ser DESTINO de una copia: las de Windows con su tipo (USB / disco fijo), formato,
 * espacio libre y tamaño. Se consultan con getVolumeInfo (la letra se valida antes de ejecutar nada).
 * Los discos de red y de CD/DVD no se ofrecen. `getInfo` se inyecta para poder probarlo sin discos reales.
 * @returns {Promise<Array<{letter: string, path: string, driveType: string, fileSystem: string, sizeBytes: number|null, freeBytes: number|null}>>}
 */
async function listDestinationDrives({ platform = process.platform, exists = defaultExists, getInfo } = {}) {
  const info = getInfo || ((letter, root) => require('./volume-info').getVolumeInfo(letter, { rootPath: root }));
  const drives = await listDrives({ platform, exists });
  const out = await Promise.all(
    drives.map(async (d) => {
      let v;
      try {
        v = (await info(d.letter, d.path)) || {};
      } catch {
        v = {};
      }
      return {
        letter: d.letter,
        path: d.path,
        driveType: typeof v.driveType === 'string' ? v.driveType : 'unknown',
        fileSystem: typeof v.fileSystem === 'string' ? v.fileSystem : 'desconocido',
        sizeBytes: Number.isFinite(v.sizeBytes) ? v.sizeBytes : null,
        freeBytes: Number.isFinite(v.freeBytes) ? v.freeBytes : null,
      };
    }),
  );
  return out.filter((d) => d.driveType !== 'network' && d.driveType !== 'cdrom');
}

module.exports = { listDrives, listDestinationDrives, LETTERS };
