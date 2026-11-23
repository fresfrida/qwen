// Editing the four brief layers on a film that already exists. The promises these tests hold:
//   - a value the studio vocabulary does not contain is refused before anything is read for
//     writing, so no partial direction can land and no stage can be reset by a rejected submit;
//   - a change that would move nothing writes nothing;
//   - an accepted change clears exactly the stages RESET_START says it must, and withdraws the
//     two approvals rather than leaving a stale film looking approved;
//   - the page states the consequence, and never claims a tool can produce a look.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';
import { RESET_START, layerList, parseLayerFields, resetConsequence, resetPlan, summaryLine } from '../src/studio/layers.js';
import { STAGES, STATUS, stageDef } from '../src/studio/stages.js';
import { studioFilmPage } from '../src/studio/view.js';
import { loadLayout } from '../src/page.js';

const LIVE = { MODE: 'live', OWNER_USER: 'owner', OWNER_PASS: 'correct horse battery staple' };
const AUTH = 'Basic ' + Buffer.from('owner:correct horse battery staple').toString('base64');
const OPEN = new Set();
loadLayout();

async function boot(extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'layers-'));
  const app = await start({ env: { MODE: 'prototype', PORT: '0', DATA_DIR: dataDir, STUDIO_DATA_DIR: dataDir, ...extra } });
  const base = `http://127.0.0.1:${app.port}`;
  const srv = {
    app, dataDir, base,
    form: (path, fields, { auth = AUTH } = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', ...(auth ? { authorization: auth } : {}) },
      body: new URLSearchParams(fields).toString(),
      redirect: 'manual',
    }),
    get: (path, { auth = AUTH } = {}) => fetch(base + path, { headers: { connection: 'close', ...(auth ? { authorization: auth } : {}) }, redirect: 'manual' }),
    async close() { await app.container.studio?.stopInFlight?.(); await app.close(); },
  };
  OPEN.add(srv);
  return srv;

}
after(async () => { for (const s of [...OPEN]) await s.close().catch(() => {}); });

const FILM = { mode: 'develop_my_idea', title: 'Salt Road', premise: 'Two strangers share a drive at night.', notes: 'silhouettes only, no visible faces', targetLength: '45 seconds', style: 'painterly', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience' };

/** Follow a 303 to the page it points at, so the flash message is actually read. */
const follow = async (s, res) => {
  const loc = res.headers.get('location');
  assert.ok(loc, 'the action redirects back to the film');
  return (await s.get(loc)).text();
};

/** Start a film and walk it to the point where direction actually has downstream work. */
async function started(s, stages = ['research', 'concept']) {
  const made = await s.form('/studio/films', { ...FILM, _token: 'start1aaaa1111' });
  const id = /([0-9a-f-]{36})/.exec(made.headers.get('location'))[1];
  for (const stage of stages) await s.form(`/studio/film/${id}/run`, { stage });
  return id;
}
const stateOf = async (s, id) => (await (await s.get(`/studio/film/${id}/status`)).json());

/**
 * A run answers 303 immediately and keeps working against the record, so a test that posts the next
 * action right away is posting into a stage that is still running. Wait for the record to settle
 * instead of asserting against a snapshot the app never promised to be final.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(s, id, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const f = await stateOf(s, id);
    if (!f.running.length) return f;
    await sleep(25);
  }
  throw new Error(`film ${id} never stopped running`);
}
/** Run stages in order, one at a time, waiting for each to finish. */
async function runTo(s, id, want) {
  await settle(s, id);
  for (const stage of want) {
    await s.form(`/studio/film/${id}/run`, { stage });
    await settle(s, id);
  }
  return stateOf(s, id);
}
const statuses = (record) => Object.fromEntries(Object.entries(record.stages).map(([k, v]) => [k, v.status]));

// ------------------------------------------------------------------ the rules, stated plainly

test('the reset rule reads in owner words, and the consequence is derived from it', () => {
  assert.deepEqual({ ...RESET_START }, { style: 'storyboard', genre: 'script', format: 'script', sound: 'script' });
  assert.equal(layerList(['sound', 'style', 'format']), 'look, format and sound', 'the list follows the order the form shows, not submission order');
  const forStyle = resetPlan(['style']);
  assert.equal(forStyle.fromStage, 'storyboard');
  assert.match(resetConsequence(['style']), /the look sends work back for a redo from Graphic designer/);
  // nothing claimed about what a tool can do
  assert.doesNotMatch(resetConsequence(['format']), /can generate|will render|produces? the video/i);
});

test('an unrecognised layer value is refused by the parser that the write path uses', () => {
  const r = parseLayerFields({ style: 'oil_painting_not_real', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience' });
  assert.equal(r.ok, false);
  assert.match(r.errors.style, /is not a value this studio knows/);
  assert.equal(r.layers.style.rejected, true, 'the refused value is kept only to be echoed back');
});

// ------------------------------------------------------------------ refusal writes nothing

test('a refused layer edit on a saved film changes nothing at all', async (t) => {
  const s = await boot(LIVE);
  const id = await started(s);
  const before = await stateOf(s, id);
  const files = await readFile(join(s.dataDir, 'studio', `film-${id}.json`), 'utf8');

  const r = await s.form(`/studio/film/${id}/layers`, {
    version: String(before.version), style: 'oil_painting_not_real', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
  });
  assert.equal(r.status, 422);
  const page = await r.text();
  assert.match(page, /role="alert"/, 'the refusal is announced');
  assert.match(page, /is not a value this studio knows/, 'and named');
  assert.match(page, /data-rejected="oil_painting_not_real"/, 'what was sent is echoed back');

  const after = await stateOf(s, id);
  assert.equal(after.version, before.version, 'the record was not touched, not even to bump a version');
  assert.deepEqual(statuses(after), statuses(before), 'no stage moved');
  assert.equal(await readFile(join(s.dataDir, 'studio', `film-${id}.json`), 'utf8'), files, 'the stored file is byte-identical');
  const stored = JSON.parse(files);
  assert.equal(summaryLine({ brief: JSON.parse(await readFile(join(s.dataDir, 'studio', `film-${id}.json`), 'utf8')).brief }), summaryLine({ brief: stored.brief }), 'and the direction line still says exactly what it said');
  await s.close();
});

test('sending the same values back saves nothing and resets nothing', async () => {
  const s = await boot(LIVE);
  const id = await started(s, ['research', 'concept']);
  const f = await stateOf(s, id);
  const r = await s.form(`/studio/film/${id}/layers`, {
    version: String(f.version), style: 'painterly', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
  });
  assert.equal(r.status, 303);
  const page = await follow(s, r);
  assert.match(page, /already the values on this brief/, 'it says so instead of pretending to save');
  assert.match(page, /no stage was reset/);
  const after = await stateOf(s, id);
  assert.equal(after.version, f.version, 'and it really did not write');
  await s.close();
});

test('an accepted direction change clears the stages it feeds and withdraws both approvals', async () => {
  const s = await boot(LIVE);
  // research + concept, then approve gate 1 so script can run and produce something
  const made = await s.form('/studio/films', { ...FILM, _token: 'reset2bbbb2222' });
  const id = /([0-9a-f-]{36})/.exec(made.headers.get('location'))[1];
  let f = await runTo(s, id, ['research', 'concept']);
  assert.equal(f.stages.gate_concept.status, 'needs_my_approval', 'gate 1 is asking');
  const concepts = JSON.parse(await readFile(join(s.dataDir, 'studio', `film-${id}.json`), 'utf8')).concepts;
  const ref = (Array.isArray(concepts) ? concepts : concepts?.items ?? [])[0]?.ref ?? 'c1';
  await s.form(`/studio/film/${id}/choose`, { ref: String(ref), version: String(f.version) });
  f = await settle(s, id);
  await s.form(`/studio/film/${id}/gate`, { gate: 'gate_concept', decision: 'approve', version: String(f.version) });
  f = await runTo(s, id, ['script']);
  assert.equal(f.stages.script.status, 'done', `the film has real downstream work before the edit (${JSON.stringify(f.stages.script)})`);

  f = await settle(s, id);
  const r = await s.form(`/studio/film/${id}/layers`, {
    version: String(f.version), style: 'painterly', genres: 'comedy', format: 'asmr_loop', sound: 'music_ambience',
    note: 'quieter, and meaner',
  });
  assert.equal(r.status, 303, 'the format change is accepted');
  const after = await settle(s, id);
  assert.equal(after.stages.script.status, 'sent_back', 'format feeds the script, so the script goes back');
  assert.equal(after.stages.script.hasOutput, false, 'its old output stops counting');
  assert.equal(after.stages.research.status, 'done', 'research is upstream of the change and keeps its work');
  assert.match(after.stages.script.reworkNote ?? (await (await s.get(`/studio/film/${id}`)).text()), /quieter, and meaner|direction changed/, 'the reason travels to the stage card');

  const page = await (await s.get(`/studio/film/${id}`)).text();
  assert.match(page, /ASMR/, 'the header line now describes the new direction');
  assert.match(page, /withdrawn/, 'and says the approval was withdrawn');
  assert.doesNotMatch(page, /approved for release/i, 'a stale film cannot look released');
  await s.close();
});

test('direction cannot change while a stage is working, and the running work is left alone', async () => {
  const s = await boot(LIVE);
  const made = await s.form('/studio/films', { ...FILM, _token: 'busy3cccc3333' });
  const id = /([0-9a-f-]{36})/.exec(made.headers.get('location'))[1];
  // Claim research and deliberately do not await the work: this is the state a owner sees mid-run.
  const job = s.app.container.studio;
  const claimed = await job.claimStage(id, 'research');
  assert.equal(claimed.ok, true, `the stage should be claimable: ${JSON.stringify(claimed)}`);
  const mid = await stateOf(s, id);
  assert.deepEqual(mid.running, ['research'], 'the record says one stage is in progress');

  const r = await s.form(`/studio/film/${id}/layers`, {
    version: String(mid.version), style: 'toon_shaded_3d', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
  });
  assert.equal(r.status, 303, 'refused over the flash channel, not by breaking the page');
  const page = await follow(s, r);
  assert.match(page, /is working on this record right now/, 'it names the stage that is busy');
  assert.match(page, /finishing a brief it was never given/, 'and says why that blocks the edit');

  const after = await stateOf(s, id);
  assert.deepEqual(after.running, ['research'], 'the run was not cancelled by the refusal');
  assert.equal(after.stages.storyboard.status, 'waiting', 'nothing was reset behind its back');
  assert.equal(after.version, mid.version, 'and the record was not written at all');

  // The refusal left a claim in place, which is the point: an interrupted run is not a completed
  // one. Booting again is what resolves it, and the direction change becomes possible after that.
  await job.stopInFlight('test over');
  await s.app.close();
  OPEN.delete(s);

  const again = await start({ env: { ...LIVE, PORT: '0', DATA_DIR: s.dataDir, STUDIO_DATA_DIR: s.dataDir } });
  OPEN.add(again);
  const B = `http://127.0.0.1:${again.port}`;
  const seen = await (await fetch(`${B}/studio/film/${id}/status`, { headers: { authorization: AUTH, connection: 'close' } })).json();
  assert.deepEqual(seen.running, [], 'the interrupted run is not left claiming to be in progress');
  assert.equal(seen.stages.research.status, 'failed', 'it is recorded as interrupted, not silently done');

  const retry = await fetch(`${B}/studio/film/${id}/layers`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: AUTH, connection: 'close' },
    body: new URLSearchParams({ version: String(seen.version), style: 'toon_shaded_3d', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience' }).toString(),
    redirect: 'manual',
  });
  assert.equal(retry.status, 303, 'with nothing running, the edit is allowed again');
  const after2 = await (await fetch(`${B}/studio/film/${id}`, { headers: { authorization: AUTH, connection: 'close' } })).text();
  assert.match(after2, /Cel-shaded 3D|toon/i, 'and it took effect');
  await again.container.studio?.stopInFlight?.('done');
  await again.close();
});

test('a too-long reason is refused with the values, and writes nothing', async () => {
  const s = await boot(LIVE);
  const id = await started(s);
  const f = await settle(s, id);
  const r = await s.form(`/studio/film/${id}/layers`, {
    version: String(f.version), style: 'toon_shaded_3d', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
    note: 'x'.repeat(401),
  });
  assert.equal(r.status, 422);
  const page = await r.text();
  assert.match(page, /under 400 characters/);
  const after = await stateOf(s, id);
  assert.equal(after.version, f.version);
  await s.close();
});

test('a stale page loses to the stored record instead of applying the change twice', async () => {
  const s = await boot(LIVE);
  const id = await started(s);
  const f = await stateOf(s, id);
  const first = await s.form(`/studio/film/${id}/layers`, {
    version: String(f.version), style: 'toon_shaded_3d', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
  });
  assert.equal(first.status, 303);
  const second = await s.form(`/studio/film/${id}/layers`, {
    version: String(f.version), style: 'comic_3d', genres: 'comedy', format: 'ambient_loop', sound: 'music_ambience',
  });
  const page = await follow(s, second);
  assert.match(page, /Someone else changed this film|changed while this page was open/);
  const after = await stateOf(s, id);
  assert.match((await (await s.get(`/studio/film/${id}`)).text()), /Cel-shaded 3D|comic/, 'the first change is the one that stands');
  assert.doesNotMatch(summaryOf(after, s, id), /Cel-shaded 3D[\s\S]*and then clay/i);
  await s.close();
});

const summaryOf = (record) => JSON.stringify(record.stages);

// ------------------------------------------------------------------ the page itself

test('the film page renders one direction editor, with the consequence and the honesty limit', () => {
  const file = {
    id: '0'.repeat(36), version: 7, entryMode: 'develop_my_idea', pipelineMode: 'demo', runtimeMode: 'live',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    brief: { title: 'Salt Road', premise: 'p', notes: 'no visible faces', targetLength: '', links: [], layers: {
      style: { value: 'painterly', other: '' }, genres: [{ value: 'comedy', other: '' }], format: { value: 'ambient_loop', other: '' }, sound: { value: 'music_ambience', other: '' },
    } },
    chosenConcept: null, concepts: null, research: null, script: null, storyboards: null, assets: null, edit: null, marketing: null,
    status: 'waiting', stages: Object.fromEntries(STAGES.map((x) => [x.key, { status: STATUS.WAITING, output: null, attempts: 0 }])),
    decisions: [], history: [], callsUsed: 0,
  };
  const page = studioFilmPage({ film: file, caps: { pipelineMode: 'demo', media: {}, mediaEndpoints: {}, mediaReady: false } });
  assert.equal((page.match(/data-layer-block/g) ?? []).length, 1, 'exactly one editor on a film page');
  assert.match(page, /data-reset-rule/, 'the consequence is stated before submitting');
  assert.match(page, /data-reset-map/);
  assert.match(page, /Graphic designer/, 'naming the role the redo starts at');
  assert.match(page, /Nothing here says a generation tool can produce/, 'the honesty limit travels with the controls');
  assert.match(page, /name="version" value="7"/, 'the write carries the version it was reading');
  assert.match(page, /data-face="no visible faces"/, 'a decided face direction is carried, not recomputed in the browser');
  assert.doesNotMatch(page, /can render|will generate|produces? any look/i, 'no capability claim anywhere in the editor');
});
