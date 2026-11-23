// Live-mode submission store: one JSON file per enquiry, written atomically and read back
// before the caller is allowed to say "saved". Swap this file for a Postgres adapter later;
// nothing else in the app knows how storage works.

import { mkdir, open, rename, readFile, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { SAVE } from '../ports.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createFileSubmissionStore(root) {
  const dir = resolve(root, 'submissions');

  async function ensure() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const pathFor = (id) => {
    if (!ID.test(id)) throw new Error('refused to build a path from a non-id value');
    return join(dir, `${id}.json`);
  };

  async function writeAtomic(target, text) {
    const tmp = `${target}.${randomUUID()}.tmp`;
    const fh = await open(tmp, 'wx', 0o600);
    // a failed write must leave no half-file behind, so the temp name is cleaned here, not by the caller
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();               // data on disk before the name exists
    } catch (err) {
      await fh.close();
      await unlink(tmp).catch(() => {});
      throw err;
    }
    await fh.close();
    await rename(tmp, target);       // readers see either nothing or the whole record
    try {
      const dh = await open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }   // persist the rename itself
    } catch { /* platform without writable dir fds: rename is still atomic */ }
  }

  return {
    kind: 'file',
    async save(record) {
      await ensure();
      const id = randomUUID();
      const storedAt = new Date().toISOString();
      const row = { id, storedAt, ...record };
      try {
        await writeAtomic(pathFor(id), JSON.stringify(row, null, 2));
        const back = JSON.parse(await readFile(pathFor(id), 'utf8'));   // verify, then claim
        if (back.id !== id) return { saved: false, reason: SAVE.WRITE_FAILED, detail: 'read-back mismatch' };
        return { saved: true, id, reason: SAVE.SAVED };
      } catch (err) {
        return { saved: false, reason: SAVE.WRITE_FAILED, detail: String(err?.code || err?.message || err) };
      }
    },
    async list() {
      const names = (await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })).filter((n) => ID.test(n.replace(/\.json$/, '')));
      const rows = [];
      for (const n of names) {
        try { rows.push(JSON.parse(await readFile(join(dir, n), 'utf8'))); }
        catch { rows.push({ id: n.replace(/\.json$/, ''), unreadable: true }); }
      }
      return rows.sort((a, b) => String(b.storedAt ?? '').localeCompare(String(a.storedAt ?? '')));
    },
    async find(id) {
      if (!ID.test(id)) return null;
      try { return JSON.parse(await readFile(pathFor(id), 'utf8')); } catch { return null; }
    },
    async remove(id) {
      if (!ID.test(id)) return;
      await unlink(pathFor(id)).catch(() => {});
    },
  };
}
