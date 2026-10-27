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

module.exports = { listDrives, LETTERS };
