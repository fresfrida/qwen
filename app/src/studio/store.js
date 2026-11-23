// Film state on disk, so a refresh cannot lose it and a crash cannot invent a "done".
//
// Three rules this file exists to enforce:
//   1. one writer at a time per film, checked by version (compare-and-set), so two requests
//      cannot each think they applied to the latest state;
//   2. writes are tmp+fsync+rename, so a reader never sees half a record;
//   3. anything still marked in_progress when the process starts is resolved to failed at boot,
//      with the error kept. A stage that was killed is never quietly retried or completed.

import { mkdir, open, rename, readFile, readdir, unlink, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { STATUS, STAGES, stageDef } from './stages.js';
import { assertFilmShape, pushHistory, touch } from './brief.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const LEDGER = '_idempotency.json';

export class StorageUnavailable extends Error {
  constructor(detail) { super(`studio storage could not be written: ${detail}`); this.kind = 'storage_unavailable'; }
}

export function createFilmStore(root) {
  const dir = resolve(root, 'studio');
  const ledgerPath = join(dir, LEDGER);
  const paths = new Map();            // serialization per film, in this process
  const writes = [];                  // one write at a time globally, so the ledger cannot tear

  const filmPath = (id) => {
    if (!ID.test(id)) throw new Error('refused to build a path from a non-id value');
    return join(dir, `film-${id}.json`);
  };

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function writeAtomic(target, text) {
    const tmp = `${target}.${randomUUID()}.tmp`;
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(text, 'utf8');
      await fh.sync();
    } catch (e) {
      await fh.close();
      await unlink(tmp).catch(() => {});
      throw e;
    }
    await fh.close();
    await rename(tmp, target);
    try {
      const dh = await open(resolve(target, '..'), 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    } catch { /* platform without writable dir fds; the rename is still atomic */ }
  }

  async function readLedger() {
    try { return JSON.parse(await readFile(ledgerPath, 'utf8')); } catch (e) {
      if (e.code === 'ENOENT') return {};
      throw new StorageUnavailable(`ledger ${e.code ?? e.message}`);
    }
  }

  async function filmCount(dirList) { return dirList.filter((n) => /^film-[0-9a-f-]{36}\.json$/.test(n)).length; }

  async function queue(id, job) {
    const prev = paths.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(job);
    paths.set(id, run);
    try { return await run; } finally {
      if (paths.get(id) === run) paths.delete(id);
    }
  }

  // One global chain for the ledger-touching work. The previous version queued jobs into an array
  // that only a later drain would run, and that drain was attached to the promise waiting to be
  // run: nothing started, and the test hung. A chain of promises cannot deadlock like that.
  let ledgerChain = Promise.resolve();
  const serialise = (job) => {
    const run = ledgerChain.then(job, job);
    ledgerChain = run.catch(() => {});
    return run;
  };

  return {
    dir,

    /**
     * Create, or return the film this token already created. A double click sends the same token,
     * so it produces one film and the second caller is told so rather than getting a twin.
     */
    async create(film, clientToken) {
      await ensureDir();
      const problems = assertFilmShape(film);
      if (problems.length) throw new Error(`refusing to store an invalid film: ${problems.join('; ')}`);
      return serialise(async () => {
        if (clientToken) {
          if (!TOKEN.test(String(clientToken))) throw new Error('client token must be 8-64 URL-safe characters');
          const ledger = await readLedger();
          const known = ledger[clientToken];
          if (known) {
            const existing = await this.find(known).catch(() => null);
            if (existing) return { film: existing, reused: true, reason: 'duplicate_token' };
          }
        }
        await writeAtomic(filmPath(film.id), JSON.stringify(film, null, 2));
        if (clientToken) {
          const ledger = await readLedger();
          ledger[clientToken] = film.id;
          const kept = Object.entries(ledger).slice(-500);
          await writeAtomic(ledgerPath, JSON.stringify(Object.fromEntries(kept), null, 2));
        }
        return { film, reused: false, reason: null };
      });
    },

    async find(id) {
      if (!ID.test(id)) return null;
      let raw;
      try { raw = await readFile(filmPath(id), 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw new StorageUnavailable(`read ${e.code ?? e.message}`);
      }
      let film;
      try { film = JSON.parse(raw); } catch (e) { throw new Error(`film ${id} is unreadable JSON: ${e.message}`); }
      const problems = assertFilmShape(film);
      if (problems.length) film.shapeProblems = problems;      // shown, never hidden
      return film;
    },

    async list() {
      let names = [];
      try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw new StorageUnavailable(`list ${e.code ?? e.message}`); }
      const ids = names.filter((n) => /^film-[0-9a-f-]{36}\.json$/.test(n)).map((n) => n.slice(5, -5));
      const out = [];
      for (const id of ids) {
        try { out.push(await this.find(id)); }
        catch (err) { out.push({ id, unreadable: true, error: String(err.message).slice(0, 200) }); }
      }
      return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    },

    /**
     * Compare-and-set against the loaded version. mut may return {abort:true, error} to refuse the
     * write; an abort is stored nowhere, so the film keeps its previous state unchanged.
     */
    async update(id, expectedVersion, mut) {
      return queue(id, async () => {
        const film = await this.find(id);
        if (!film) return { ok: false, reason: 'not_found' };
        if (film.unreadable) return { ok: false, reason: 'unreadable', error: film.error };
        if (expectedVersion !== undefined && film.version !== expectedVersion) {
          return { ok: false, reason: 'version_conflict', film };
        }
        const res = await mut(film);
        if (res?.abort) {
          return { ok: false, reason: res.reason ?? 'rejected_by_rule', error: res.error ?? null, film };
        }
        touch(film);
        const problems = assertFilmShape(film);
        if (problems.length) return { ok: false, reason: 'invalid_after_change', error: problems.join('; '), film };
        try {
          await writeAtomic(filmPath(id), JSON.stringify(film, null, 2));
        } catch (e) {
          throw new StorageUnavailable(String(e.code ?? e.message));
        }
        return { ok: true, film };
      });
    },

    async remove(id) {
      if (!ID.test(id)) return false;
      return queue(id, async () => {
        await rm(filmPath(id), { force: true });
        return true;
      });
    },

    /**
     * Run at boot, before anything is served. A stage left in_progress by a killed process becomes
     * failed-with-error and waits for you, because a finished run was never observed.
     */
    async recoverInterrupted() {
      const found = [];
      let names = [];
      try { names = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return found; throw e; }
      for (const n of names.filter((x) => /^film-[0-9a-f-]{36}\.json$/.test(x))) {
        const id = n.slice(5, -5);
        const film = await this.find(id);
        if (!film || film.unreadable) continue;
        const interrupted = STAGES.filter((s) => film.stages[s.key]?.status === STATUS.RUNNING);
        if (!interrupted.length) continue;
        for (const s of interrupted) {
          const st = film.stages[s.key];
          st.status = STATUS.FAILED;
          st.error = 'the studio process stopped while this stage was running, so its output was never observed; nothing is retried automatically';
          st.errorKind = 'interrupted';
          st.failedAt = new Date().toISOString();
          pushHistory(film, { at: st.failedAt, actor: s.role, kind: 'failed', stage: s.key, errorKind: 'interrupted', text: `${s.role} was interrupted mid-run and is marked failed, not done.` });
          found.push({ id, stage: s.key });
        }
        touch(film);
        const problems = assertFilmShape(film);
        if (problems.length) film.shapeProblems = problems;
        await writeAtomic(filmPath(id), JSON.stringify(film, null, 2));
      }
      return found;
    },

    async counts() {
      const names = await readdir(dir).catch(() => []);
      return { films: await filmCount(names), ledger: (await readLedger().catch(() => ({}))) ? Object.keys(await readLedger().catch(() => ({}))).length : 0 };
    },
  };
}

/** For the runner: the stage that a decision or a critique unlocked, ready to be started. */
export const readyStageOf = (film) => {
  for (const s of STAGES) {
    const st = film.stages[s.key];
    if (st.status === STATUS.RUNNING) return { key: s.key, blockedBy: 'running' };
    if (st.status === STATUS.NEEDS_APPROVAL) return { key: s.key, blockedBy: 'approval' };
    if (st.status === STATUS.FAILED) return { key: s.key, blockedBy: 'failed' };
    if (st.status === STATUS.WAITING || st.status === STATUS.SENT_BACK) return { key: s.key, blockedBy: null };
  }
  return { key: null, blockedBy: 'complete' };
};

export const stageLabel = (key) => stageDef(key)?.role ?? key;
