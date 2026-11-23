// Live-mode asset store. The visitor's file name never touches the filesystem: bytes are
// re-identified here (the write is the real boundary), stored under an opaque random key,
// and can only be read back through the owner route. There is no public listing and no
// static mapping of this directory, by design.

import { mkdir, open, rename, readFile, unlink, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { checkUpload, ACCEPTED } from '../uploads.js';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|mp4|mov|pdf)$/;
const EXT_TYPE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf' };

export function createFileAssetStore(root, { maxFileBytes } = {}) {
  const dir = resolve(root, 'assets');
  const pathFor = (key) => {
    if (!KEY.test(key)) throw new Error('refused to build a path from a key this store did not issue');
    return join(dir, key);
  };

  return {
    kind: 'file',
    acceptedMediaTypes: ACCEPTED,

    async put({ bytes, declaredType, declaredName }) {
      const verdict = checkUpload({ bytes, declaredType, declaredName, fieldMaxBytes: maxFileBytes ?? Infinity });
      if (!verdict.ok) return { stored: false, reason: verdict.error };
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const key = `${randomUUID()}.${verdict.ext}`;
        const tmp = `${pathFor(key)}.${randomUUID()}.tmp`;
        const fh = await open(tmp, 'wx', 0o600);
        try {
          await fh.write(bytes);
          await fh.sync();
        } catch (e) { await fh.close(); await unlink(tmp).catch(() => {}); throw e; }
        await fh.close();
        await rename(tmp, pathFor(key));
        const back = await readFile(pathFor(key));                     // confirm before claiming
        if (back.length !== bytes.length || !back.subarray(0, 512).equals(bytes.subarray(0, Math.min(512, bytes.length)))) {
          await rm(pathFor(key), { force: true });
          return { stored: false, reason: 'read-back mismatch' };
        }
        return { stored: true, key, mediaType: verdict.mediaType, ext: verdict.ext };
      } catch (err) {
        return { stored: false, reason: String(err?.code || err?.message || err) };
      }
    },

    async get(key) {
      if (!KEY.test(key)) return null;
      try {
        const bytes = await readFile(pathFor(key));
        return { bytes, mediaType: EXT_TYPE[key.split('.')[1]], storedName: key };
      } catch { return null; }
    },

    async remove(key) {
      if (!KEY.test(key)) return;
      await rm(pathFor(key), { force: true }).catch(() => {});
    },
  };
}
