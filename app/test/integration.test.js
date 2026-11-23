import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';

const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(400, 7)]);
const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(220, 4)]);
const lyingSvg = () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');

const GOOD = { _form: 'brand_enquiries', company: 'Acme Drinks', offering: 'A canned citrus drink.', placement: 'tiktok_short', email: 'buyer@acme-drinks.example' };

async function up(env = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'myai-'));
  const app = await start({ env: { MODE: 'prototype', PORT: '0', DATA_DIR: dataDir, ...env } });
  const base = `http://127.0.0.1:${app.port}`;
  return { ...app, base, dataDir };
}
const form = (fields, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('assets', new Blob([f.bytes], { type: f.type }), f.name);
  return fd;
};
const dirEmpty = async (p) => { try { return (await readdir(p)).length === 0; } catch { return 'missing'; } };
const owner = 'Basic ' + Buffer.from('owner:correct horse battery staple').toString('base64');

const LIVE = { MODE: 'live', OWNER_USER: 'owner', OWNER_PASS: 'correct horse battery staple' };

test('landing page: headers, self-contained markup, exactly three placement options', async () => {
  const s = await up(); after(() => s.close());
  const r = await fetch(`${s.base}/`);
  const t = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((t.match(/name="placement"/g) ?? []).length, 3, 'the form must offer 1 to 3 options, not a dozen');
  assert.ok(!/<script|onclick=|javascript:|https?:\/\/(?!www\.w3\.org)/i.test(t.replace(/<svg[^>]*>/g, '')), 'page must not carry script or off-origin refs');
  assert.match(t, /Demo — submissions are not sent or saved/);
  assert.deepEqual(await readdir(s.dataDir), [], 'GET must not write anything');
});

test('PROTOTYPE: a full submission with assets is answered honestly and writes nothing', async () => {
  const s = await up(); after(() => s.close());
  const r = await fetch(`${s.base}/enquiry`, {
    method: 'POST',
    body: form(GOOD, [
      { name: 'logo.png', type: 'image/png', bytes: png() },
      { name: 'packshot.jpg', type: 'image/jpeg', bytes: jpg() },
    ]),
  });
  const t = await r.text();
  assert.match(t, /Demo only — nothing was sent\./);
  assert.ok(!/Thank you/.test(t), 'must never thank someone for a submission that was not saved');
  // values are echoed back into the re-rendered form (that is the point of a form), so the real
  // invariant is that nothing was written: neither the submission store nor the asset store ran
  assert.deepEqual(await readdir(s.dataDir), [], 'prototype mode wrote something to disk');
});

test('PROTOTYPE: hostile field values stay inert text, and a lying file is refused', async () => {
  const s = await up(); after(() => s.close());
  const r = await fetch(`${s.base}/enquiry`, {
    method: 'POST',
    body: form({ ...GOOD, company: '<img src=x onerror="alert(1)"><script>steal()</script>', offering: '</textarea><svg onload=alert(2)>' },
      [{ name: 'evil.png', type: 'image/png', bytes: lyingSvg() }]),
  });
  const t = await r.text();
  assert.ok(!/<img src=x onerror/i.test(t) && !/<script>steal/i.test(t) && !/<svg onload=alert\(2\)/i.test(t), 'stored text escaped into live markup');
  assert.match(t, /unrecognised file type|not accepted/i);
  assert.equal(await dirEmpty(s.dataDir), true);
});

test('LIVE: valid submission is stored, with an opaque file name and the type the bytes had', async () => {
  const s = await up(LIVE); after(() => s.close());
  const r = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form(GOOD, [{ name: '../../etc/Logo.PNG', type: 'image/png', bytes: png() }]) });
  const t = await r.text();
  assert.equal(r.status, 200);
  assert.match(t, /Thank you — your submission is saved\./);
  const files = await readdir(join(s.dataDir, 'submissions'));
  assert.equal(files.length, 1);
  const rec = JSON.parse(await readFile(join(s.dataDir, 'submissions', files[0]), 'utf8'));
  assert.equal(rec.company, 'Acme Drinks');
  assert.deepEqual(Object.keys(rec).sort(), ['assets', 'company', 'contactEmail', 'form', 'id', 'offering', 'placement', 'storedAt'].sort(), 'only the declared fields are persisted');
  assert.equal(rec.assets.length, 1);
  assert.match(rec.assets[0].key, /^[0-9a-f-]{36}\.png$/);
  assert.ok(!JSON.stringify(rec.assets[0].key).includes('Logo'), 'the visitor’s file name must not become a path');
  const stored = await readdir(join(s.dataDir, 'assets'));
  assert.deepEqual(stored, [rec.assets[0].key]);
  assert.equal((await stat(join(s.dataDir, 'assets', stored[0]))).mode & 0o777, 0o600);
  const publicPage = await (await fetch(`${s.base}/`)).text();
  assert.ok(!publicPage.includes('buyer@acme-drinks.example'), 'the public page must not list enquiries');
});

test('LIVE: invalid input is refused before the adapters run, and nothing is thanked', async () => {
  let puts = 0, saves = 0;
  const s = await up(LIVE); 
  const inner = s.container.intake;
  after(() => s.close());
  const spyAssets = { put: async (a) => { puts++; return s.container.assets.put(a); }, get: (k) => s.container.assets.get(k), remove: (k) => s.container.assets.remove(k), acceptedMediaTypes: s.container.assets.acceptedMediaTypes };
  const { createIntake } = await import('../src/intake.js');
  s.container.intake = createIntake({ config: s.container.config, submissions: { save: async (r) => { saves++; return s.container.submissions.save(r); }, list: () => s.container.submissions.list(), find: (i) => s.container.submissions.find(i), remove: (i) => s.container.submissions.remove(i) }, assets: spyAssets, log: () => {} });
  const r = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form({ ...GOOD, email: 'not-an-email', placement: 'a-podcast' }, [{ name: 'a.png', type: 'image/png', bytes: png() }]) });
  const t = await r.text();
  assert.equal(r.status, 422);
  assert.match(t, /Work email/);
  assert.ok(!/Thank you/.test(t));
  assert.equal(puts, 0, 'a rejected form must not write a single asset');
  assert.equal(saves, 0);
  assert.deepEqual(await readdir(s.dataDir), [], 'a rejected submission created storage on disk');
});

test('LIVE: a storage failure is reported as a failure, never as a thank-you', async () => {
  const s = await up(LIVE); after(() => s.close());
  const okRes = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form(GOOD) });
  assert.match(await okRes.text(), /Thank you — your submission is saved\./);
  await chmod(join(s.dataDir, 'submissions'), 0o500);          // disk refuses writes mid-flight
  const bad = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form({ ...GOOD, company: 'Second Co' }, [{ name: 'b.png', type: 'image/png', bytes: png() }]) });
  const t = await bad.text();
  assert.equal(bad.status, 503);
  assert.match(t, /Nothing was saved\./);
  assert.ok(!/Thank you/.test(t), 'a failed write must not be dressed up as success');
  const files = await readdir(join(s.dataDir, 'submissions'));
  assert.equal(files.length, 1, 'the failed submission left no partial record');
  const assets = await readdir(join(s.dataDir, 'assets'));
  assert.equal(assets.length, 0, 'the asset from the failed write was left behind as an orphan');
  await chmod(join(s.dataDir, 'submissions'), 0o700);
});

test('LIVE: the owner view needs the right credentials and refuses to list without them', async () => {
  const s = await up(LIVE); after(() => s.close());
  await fetch(`${s.base}/enquiry`, { method: 'POST', body: form(GOOD, [{ name: 'c.png', type: 'image/png', bytes: png() }]) });
  const anon = await fetch(`${s.base}/owner`);
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate') ?? '', /^Basic /);
  assert.ok(!(await anon.text()).includes('buyer@acme-drinks.example'), 'the challenge page must not leak the enquiry');
  const wrong = await fetch(`${s.base}/owner`, { headers: { authorization: 'Basic ' + Buffer.from('Owner:Correct horse battery stapl').toString('base64') } });
  assert.equal(wrong.status, 401, 'case differences are not typos, they are not authorised');
  const good = await fetch(`${s.base}/owner`, { headers: { authorization: owner } });
  assert.equal(good.status, 200);
  const t = await good.text();
  assert.match(t, /buyer@acme-drinks\.example/);
  const key = (t.match(/\/owner\/asset\/([0-9a-f-]{36}\.png)/) ?? [])[1];
  assert.ok(key, 'owner view must offer the stored asset');
  const asset = await fetch(`${s.base}/owner/asset/${key}`, { headers: { authorization: owner } });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.match(asset.headers.get('content-disposition'), /attachment/);
  assert.match(asset.headers.get('content-security-policy'), /sandbox/);
  const anonAsset = await fetch(`${s.base}/owner/asset/${key}`);
  assert.equal(anonAsset.status, 401);
  const traversal = await fetch(`${s.base}/owner/asset/..%2f..%2fsubmissions%2fwhatever.json`, { headers: { authorization: owner } });
  assert.ok([400, 401, 404].includes(traversal.status), `traversal attempt returned ${traversal.status}`);
  const rawPath = await fetch(`${s.base}/../../${s.dataDir}`, { headers: { authorization: owner } });
  assert.ok([400, 404].includes(rawPath.status));
});

test('PROTOTYPE: owner routes cannot read another environment’s data and cannot be reached by guessing', async () => {
  const s = await up(); after(() => s.close());
  const anon = await fetch(`${s.base}/owner`);
  assert.equal(anon.status, 409);
  assert.match(await anon.text(), /Prototype mode stores nothing/);
  const withCreds = await fetch(`${s.base}/owner`, { headers: { authorization: owner } });
  assert.equal(withCreds.status, 409, 'presenting a password must not turn a prototype into a live store');
});

test('LIVE: oversized files and malformed bodies are refused without saving', async () => {
  const s = await up({ ...LIVE, MAX_FILE_BYTES: '10000', MAX_REQUEST_BYTES: '2000000' }); after(() => s.close());
  const huge = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(3_000_000, 7)]);
  const r = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form(GOOD, [{ name: 'big.png', type: 'image/png', bytes: huge }]) });
  const t = await r.text();
  assert.ok([400, 413].includes(r.status), `expected rejection, got ${r.status}`);
  assert.ok(!/Thank you/.test(t));
  assert.equal(await dirEmpty(join(s.dataDir, 'submissions')), 'missing');

  const malformed = await fetch(`${s.base}/enquiry`, { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=none' }, body: 'not really multipart at all' });
  assert.ok([400, 415].includes(malformed.status), `malformed body got ${malformed.status}`);
  assert.ok(!/Thank you/.test(await malformed.text()));

  const wrongForm = await fetch(`${s.base}/enquiry`, { method: 'POST', body: form({ _form: 'owner_briefs', secret: 'x'.repeat(50) }) });
  assert.equal(wrongForm.status, 400, 'a form this page does not declare must be refused, not filed');
});
