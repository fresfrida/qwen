import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdtempSync } from 'node:fs';
import { mkdtemp as mkdtempP, readdir, rm, chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilmStore } from '../src/studio/store.js';
import { createStudioPipeline, PipelineRule } from '../src/studio/pipeline.js';
import { resolveCapabilities } from '../src/studio/generation.js';
import { createPromptCatalog } from '../src/model/prompts.js';
import { STATUS_LABEL, KIND, filmStatus, stageDef } from '../src/studio/stages.js';
import { createFilm, validateBriefInput, assertFilmShape, sendBack, recordDecision } from '../src/studio/brief.js';
import { ENTRY, STATUS, STAGES } from '../src/studio/stages.js';

const IDEAS = { mode: ENTRY.IDEAS, title: '', premise: '', notes: '', targetLength: '', links: '' };
const PREMISE = { mode: ENTRY.PREMISE, title: 'Salt Road', premise: 'Two strangers share a drive.', notes: 'night, one continuous take', targetLength: '45 seconds', links: ['https://example.org/ref'] };

const freshFilm = (body = IDEAS) => {
  const v = validateBriefInput(body);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  return createFilm(v.value, { mode: 'live', capabilities: { pipelineMode: 'demo' } });
};

async function tmpStore() {
  const dir = await mkdtempP(join(tmpdir(), 'studio-'));
  return { dir, store: createFilmStore(dir) };
}

test('a stage cannot be stored as done without output, or as failed without an error', () => {
  const f = freshFilm();
  f.stages.script.status = STATUS.DONE;
  assert.deepEqual(assertFilmShape(f), [
    'stages.script claims done with no output',
    'stages.script is not allowed to be done before You — approval gate 1 (gate_concept) approves',
  ]);

  const g = freshFilm();
  g.stages.concept.status = STATUS.FAILED;
  assert.match(assertFilmShape(g).join('; '), /claims failed with no error kept/);

  const h = freshFilm();
  h.stages.research.status = STATUS.DONE;
  h.stages.research.output = { items: 1 };
  assert.deepEqual(assertFilmShape(h), [], 'research done is legal, it is the first stage');
});

test('entry modes validate apart, and neither invents a required field for the other', () => {
  assert.deepEqual(Object.keys(validateBriefInput(IDEAS).errors), []);
  const p = validateBriefInput(PREMISE);
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(validateBriefInput({ mode: ENTRY.PREMISE, title: '', premise: '' }).errors).sort(), ['premise', 'title']);
  assert.match(validateBriefInput({ ...PREMISE, links: 'not a link' }).errors.links, /Not a link/);
  assert.match(validateBriefInput({ ...PREMISE, links: 'ftp://example.org/x' }).errors.links, /Only http\(s\)/);
  assert.match(validateBriefInput({ ...PREMISE, links: 'https://user:pw@example.org/x' }).errors.links, /credentials/);
  assert.match(validateBriefInput({ ...PREMISE, targetLength: 'whenever' }).errors.targetLength, /number and a unit/);
});

test('an empty brief and a 400k-character brief are refused with field names, not silently truncated', () => {
  const empty = validateBriefInput({ mode: ENTRY.PREMISE });
  assert.equal(empty.ok, false);
  const long = validateBriefInput({ mode: ENTRY.PREMISE, title: 'x'.repeat(200_000), premise: 'y'.repeat(400_000) });
  assert.equal(long.ok, false);
  assert.match(long.errors.title, /200|title/i);
  assert.match(long.errors.premise, /4000|fewer/i);
  assert.ok(Object.keys(long.errors).length <= 3, 'validation should name the problems, not dump the payload');
  assert.ok(!JSON.stringify(long.errors).includes('y'.repeat(100)), 'the refused value must not be echoed back');
});

test('create is durable and survives a re-open of the store', async () => {
  const { dir, store } = await tmpStore();
  const film = freshFilm();
  const created = await store.create(film, 'token-aaaa');
  assert.equal(created.reused, false);
  const reopened = createFilmStore(dir);
  const found = await reopened.find(film.id);
  assert.equal(found.id, film.id);
  assert.equal(found.brief.title, '');
  assert.deepEqual(await readdir(join(dir, 'studio')).then((n) => n.filter((x) => x.startsWith('film-')).length), 1);
});

test('a double submit with the same token yields one film, not two', async () => {
  const { store } = await tmpStore();
  const build = () => freshFilm(PREMISE);
  const a = build(); const token = 'dbl-token-1';
  const [r1, r2] = await Promise.all([store.create(a, token), store.create(build(), token)]);
  const ids = [r1.film.id, r2.film.id];
  assert.equal(new Set(ids).size, 1, `two films were created: ${ids.join(' / ')}`);
  assert.equal((await store.list()).length, 1);
  assert.equal(r2.reused, true);
});

test('two concurrent updates cannot both think they hold the latest version', async () => {
  const { store } = await tmpStore();
  const created = await store.create(freshFilm(), 'cas-token-1');
  const version = created.film.version;
  const results = await Promise.all([
    store.update(created.film.id, version, (f) => { f.stages.research.status = STATUS.RUNNING; }),
    store.update(created.film.id, version, (f) => { f.stages.concept.status = STATUS.RUNNING; }),
  ]);
  const ok = results.filter((r) => r.ok).length;
  assert.equal(ok, 1, `both updates applied: ${JSON.stringify(results.map((r) => r.reason))}`);
  assert.equal(results.find((r) => !r.ok).reason, 'version_conflict');
  const f = await store.find(created.film.id);
  assert.notEqual(f.stages.research.status, f.stages.concept.status === STATUS.RUNNING && STATUS.RUNNING, 'two stages should not both be running from one stale read');
});

test('a stage left running by a killed process comes back failed, never silently resumed or done', async () => {
  const { dir, store } = await tmpStore();
  const created = await store.create(freshFilm(), 'kill-token-1');
  await store.update(created.film.id, created.film.version, (f) => {
    f.stages.research.status = STATUS.RUNNING;
    f.stages.research.startedAt = new Date().toISOString();
    f.stages.research.attempts = 1;
  });
  const reopened = createFilmStore(dir);
  const recovered = await reopened.recoverInterrupted();
  assert.equal(recovered.length, 1);
  const f = await reopened.find(created.film.id);
  assert.equal(f.stages.research.status, STATUS.FAILED);
  assert.match(f.stages.research.error, /interrupted|stopped/);
  assert.equal(f.stages.research.output, null, 'a failed stage must not keep an output it never produced');
  assert.equal(f.history.at(-1).kind, 'failed');
  // recovery is not a retry: a second pass changes nothing
  const again = await reopened.recoverInterrupted();
  assert.equal(again.length, 0);
});

test('compare-and-set refuses an outdated version and keeps the record intact', async () => {
  const { store } = await tmpStore();
  const created = await store.create(freshFilm(), 'stale-token-1');
  await store.update(created.film.id, created.film.version, (f) => { f.brief.title = 'First writer'; });
  const stale = await store.update(created.film.id, created.film.version, (f) => { f.brief.title = 'Second writer'; });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'version_conflict');
  assert.equal((await store.find(created.film.id)).brief.title, 'First writer');
});

test('storage that cannot be written reports failure instead of pretending the film was kept', async () => {
  const { dir, store } = await tmpStore();
  const created = await store.create(freshFilm(), 'disk-token-1');
  await chmod(join(dir, 'studio'), 0o500);
  let err = null;
  try {
    await store.update(created.film.id, created.film.version, (f) => { f.stages.research.status = STATUS.RUNNING; });
  } catch (e) { err = e; }
  await chmod(join(dir, 'studio'), 0o700);
  assert.ok(err, 'a read-only storage directory must surface an error, not a silent success');
  assert.match(err.message, /studio storage could not be written/);
  const f = await store.find(created.film.id);
  assert.equal(f.stages.research.status, STATUS.WAITING, 'the refused write must not have landed');
});

test('a critique can send work back, and downstream output voids instead of lingering', async () => {
  const film = freshFilm(PREMISE);
  const up = (key, out) => { film.stages[key].status = STATUS.DONE; film.stages[key].output = out; };
  up('research', { sources: [{ url: 'https://example.org/ref' }] });
  up('concept', { items: [{ ref: 'c1', workingTitle: 'Salt Road', oneSentenceStory: 'Two strangers.', whyItCouldWork: 'Visual turn.', mood: 'night' }] });
  film.chosenConcept = 'c1';
  up('gate_concept', { chosen: 'c1' }); film.stages.gate_concept.approval = 'approve';
  up('script', { hook: 'h', scenes: [{ n: 1, action: 'a' }], ending: 'e' });
  up('storyboard', { look: 'one look' });
  up('assets', { footage: 1 });
  up('edit', { assembly: 'cut' });
  film.stages.critique.status = STATUS.DONE;
  film.stages.critique.output = { verdict: 'send_back', sendBackTo: 'script', notes: 'The hook does not work.', strengths: [], problems: [] };

  sendBack(film, 'critique', 'script', 'The hook does not work.', 'Creative director — review pass');
  assert.equal(film.stages.script.status, STATUS.SENT_BACK);
  assert.equal(film.stages.script.output, null, 'sent-back work must not still show as delivered');
  assert.equal(film.stages.storyboard.status, STATUS.WAITING);
  assert.equal(film.stages.edit.status, STATUS.WAITING);
  assert.equal(film.stages.edit.output, null);
  const last = film.history.at(-1);
  assert.equal(last.kind, 'sent_back');
  assert.equal(last.stage, 'script');
  assert.match(last.text, /Scriptwriter/);
  assert.deepEqual(assertFilmShape(film).filter((p) => /claims done/.test(p)), []);
});

test('approval records a decision and the log says who did it', () => {
  const film = freshFilm();
  film.stages.concept.status = STATUS.NEEDS_APPROVAL;
  recordDecision(film, { gate: 'gate_concept', decision: 'approve', notes: 'Go with c2' });
  assert.equal(film.decisions.length, 1);
  assert.equal(film.decisions[0].actor, 'You');
  assert.equal(film.history.at(-1).kind, 'decision');
  assert.match(film.history.at(-1).text, /approved/);
});

test('a send-back to an unauthorised stage is refused by the model of the pipeline, not the UI', () => {
  const film = freshFilm();
  assert.throws(() => sendBack(film, 'critique', 'gate_release', 'no', 'critique'), /not allowed to send work back/);
  assert.throws(() => sendBack(film, 'research', 'script', 'note', 'x'), /role|not allowed/);
});
