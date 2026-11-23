import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntake } from '../src/intake.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const goodFields = { company: 'Acme', offering: 'A drink', placement: 'tiktok_short', email: 'me@acme.example' };

const stubSubmissions = (impl = {}) => ({ calls: [], async save(r) { this.calls.push(r); return impl.save ? impl.save(r) : { saved: true, id: 'x'.repeat(36) }; }, async list() { return []; }, async find() { return null; }, async remove() { } });
const stubAssets = (impl = {}) => {
  const puts = [], removed = [];
  return {
    puts, removed,
    acceptedMediaTypes: ['image/png'],
    async put(a) { puts.push(a); return impl.put ? impl.put(a) : { stored: true, key: 'k1', mediaType: 'image/png' }; },
    async get() { return null; },
    async remove(k) { removed.push(k); },
  };
};

test('prototype: the use case cannot reach the adapters at all', async () => {
  const submissions = stubSubmissions({ save: () => { throw new Error('prototype mode called save()'); } });
  const assets = stubAssets({ put: () => { throw new Error('prototype mode called put()'); } });
  const intake = createIntake({ config: { mode: 'prototype', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const res = await intake({ fields: goodFields, files: [{ name: 'logo.png', type: 'image/png', bytes: png }] });
  assert.equal(res.outcome, 'demo');
  assert.equal(submissions.calls.length, 0, 'prototype wrote a submission');
  assert.equal(assets.puts.length, 0, 'prototype wrote an asset');
  assert.equal(res.discardedBytes, png.length, 'the demo answer must state what was dropped');
});

test('live + invalid input: rejected before any adapter is touched', async () => {
  const submissions = stubSubmissions();
  const assets = stubAssets();
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const res = await intake({ fields: { ...goodFields, email: 'nope' }, files: [{ name: 'a.png', type: 'image/png', bytes: png }] });
  assert.equal(res.outcome, 'rejected');
  assert.equal(assets.puts.length, 0, 'a rejected form must not leave an asset behind');
  assert.equal(submissions.calls.length, 0);
});

test('live: a submission that fails to store removes the assets it already wrote', async () => {
  const submissions = stubSubmissions({ save: () => { throw new Error('disk gone'); } });
  const assets = stubAssets();
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const res = await intake({ fields: goodFields, files: [{ name: 'a.png', type: 'image/png', bytes: png }] });
  assert.equal(res.outcome, 'failed');
  assert.deepEqual(assets.removed, ['k1'], 'orphaned asset was not cleaned up');
});

test('live: an asset refused by the store fails the submission instead of silently dropping it', async () => {
  const submissions = stubSubmissions();
  const assets = stubAssets({ put: () => ({ stored: false, reason: 'quota' }) });
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const res = await intake({ fields: goodFields, files: [{ name: 'a.png', type: 'image/png', bytes: png }] });
  assert.equal(res.outcome, 'failed');
  assert.equal(submissions.calls.length, 0, 'a submission missing the assets the visitor intended must not be filed as complete');
});

test('live: more assets than the form allows is refused, not truncated to the limit', async () => {
  const submissions = stubSubmissions();
  const assets = stubAssets();
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const many = Array.from({ length: 8 }, (_, i) => ({ name: `a${i}.png`, type: 'image/png', bytes: png }));
  const res = await intake({ fields: goodFields, files: many });
  assert.equal(res.outcome, 'rejected');
  assert.match(res.fileErrors.join(' '), /at most|more than|five|5/);
  assert.equal(submissions.calls.length, 0);
});

test('live: happy path stores declared fields only', async () => {
  const submissions = stubSubmissions();
  const assets = stubAssets();
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets });
  const res = await intake({ fields: { ...goodFields, admin: 'true', note: 'x'.repeat(500) }, files: [{ name: 'a.png', type: 'image/png', bytes: png }] });
  assert.equal(res.outcome, 'saved');
  const row = submissions.calls[0];
  assert.equal('admin' in row, false, 'a field the form never declared reached storage');
  assert.equal('note' in row, false);
  assert.equal(row.company, 'Acme');
  assert.deepEqual(row.assets, [{ key: 'k1', displayName: 'a.png', mediaType: 'image/png', bytes: png.length }]);
});

test('a submission whose text would forge a log line is stored without the newline', async () => {
  const submissions = stubSubmissions();
  const intake = createIntake({ config: { mode: 'live', purpose: 'brand_enquiries', maxFileBytes: 1e6 }, submissions, assets: stubAssets() });
  await intake({ fields: { ...goodFields, company: 'Acme\n{"event":"saved","id":"fake"}' }, files: [] });
  assert.ok(!submissions.calls[0].company.includes('\n'), 'stored text can forge a line-oriented log');
});
