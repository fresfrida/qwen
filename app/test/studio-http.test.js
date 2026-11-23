// Studio behaviour through the real HTTP surface: forms, redirects, status polling, auth walls,
// double submits, oversized briefs and storage that fails mid-write. No fakes: each test boots the
// server the way production does.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, chmod, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../src/server.js';

const LIVE = { MODE: 'live', OWNER_USER: 'owner', OWNER_PASS: 'correct horse battery staple' };
const AUTH = 'Basic ' + Buffer.from('owner:correct horse battery staple').toString('base64');

// Servers that a failing test never got to close. Node's test runner waits for the event loop to
// drain, so one leaked listener after an assertion failure looks like a hung suite. This registry
// lets the file clean itself up at the end, which keeps a red test red instead of silent.
const OPEN = new Set();

async function boot(extra = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'studio-http-'));
  const app = await start({ env: { MODE: 'prototype', PORT: '0', DATA_DIR: dataDir, STUDIO_DATA_DIR: dataDir, ...extra } });
  const base = `http://127.0.0.1:${app.port}`;
  // Connection: close on every request, so no pooled socket is left holding server.close() open.
  const form = (path, fields, { auth = null } = {}) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', ...(auth ? { authorization: auth } : {}) },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  const get = (path, { auth = null } = {}) => fetch(base + path, { headers: { connection: 'close', ...(auth ? { authorization: auth } : {}) }, redirect: 'manual' });
  let closed = false;
  const srv = { app, base, dataDir, form, get, async close() {
    if (closed) return;
    closed = true;
    OPEN.delete(srv);
    await app.container.studio?.stopInFlight?.();
    await app.close();
  } };
  OPEN.add(srv);
  return srv;
}

after(async () => {
  for (const s of [...OPEN]) await s.close().catch(() => {});
});
const idOf = (location) => /([0-9a-f-]{36})/.exec(location ?? '')?.[1] ?? null;
// Every request below sends Connection: close. Without it, undici's pooled keep-alive sockets stay
// open for a minute, server.close() waits on them, and the test process never exits on its own.
const settle = async (s, id, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const v = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
    if (!v.running.length) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
};
const versionOf = async (s, id) => String((await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json()).version);
const json = async (res) => JSON.parse(await res.text());

// ---------------------------------------------------------------- the workspace is not public

test('the studio is invisible and unusable without credentials in live mode', async () => {
  const s = await boot(LIVE);
  const anon = await s.get('/studio');
  assert.equal(anon.status, 401, 'an anonymous visit must be asked to sign in, not shown a page');
  assert.match(anon.headers.get('www-authenticate') ?? '', /^Basic /);
  const body = await anon.text();
  assert.ok(!/DEMO mode|Salt Road|brought to you/.test(body), 'the challenge page disclosed workspace content');
  assert.ok(!/Bring me ideas/.test(body), 'the entry forms must not be rendered to an anonymous visitor');

  const poll = await s.get('/studio/api/state');
  assert.equal(poll.status, 401);
  const created = await s.form('/studio/films', { mode: 'bring_me_ideas', _token: 'anon-token-1' });
  assert.equal(created.status, 401, 'an unauthenticated request must not be able to start films');
  assert.equal((await readdir(join(s.dataDir, 'studio')).catch(() => [])).length, 0, 'the refused request still wrote something');

  const wrong = await s.form('/studio/films', { mode: 'bring_me_ideas', _token: 'wrong-pw-0001' }, { auth: 'Basic ' + Buffer.from('owner:not-the-password').toString('base64') });
  assert.equal(wrong.status, 401);

  const right = await s.get('/studio', { auth: AUTH });
  assert.equal(right.status, 200);
  const page = await right.text();
  assert.match(page, /Bring me ideas/);
  assert.match(page, /Develop my idea/);
  assert.ok(!/class="openpreview"/.test(page), 'the live workspace must not claim to be an open prototype');
  await s.close();
});

test('live mode keeps the enquiry form honest while the studio stays private', async () => {
  const s = await boot(LIVE);
  const home = await s.get('/');
  const page = await home.text();
  assert.equal(home.status, 200);
  // The public page links to /studio on purpose now — "Start a film" has to lead somewhere real, and
  // creation lives in the owner workspace. What has to stay true is that the link is the *only*
  // bridge: a public visitor gets no film record, no film id, and no owner data out of this page.
  assert.ok(page.includes('data-cta="start-a-film"'), 'the hero has to lead into creation');
  assert.ok(!page.includes('/studio/film/'), 'the public page must not link into a specific film record');
  assert.ok(!/data-summary|brief-direction/.test(page), 'no saved brief direction may appear publicly');
  // in live mode an enquiry really is saved, so a "not sent or saved" notice would be the lie
  assert.match(page, /Submissions are saved on this server and visible only to the studio/);
  assert.doesNotMatch(page, /Demo — submissions are not sent or saved/, 'live mode must not claim to be a demo');
  // 'a@b.example' is refused by the enquiry form's existing work-email rule; that rule is
  // protected behaviour, so the test data was corrected rather than the validator loosened.
  const r = await s.form('/enquiry', { _form: 'brand_enquiries', company: 'Acme', offering: 'A drink', placement: 'tiktok_short', email: 'buyer@acme-drinks.example' });
  const after = await r.text();
  assert.match(after, /Thank you — your submission is saved\./);
  const films = await (await s.get('/studio/api/state', { auth: AUTH })).json();
  assert.equal(films.films.length, 0, 'a public enquiry must not appear as a film');
  await s.close();
});

// ---------------------------------------------------------------- entry, both modes

test('an empty brief and a 400k-character brief are refused over the wire, by name', async () => {
  const s = await boot({ ...LIVE });
  const empty = await s.form('/studio/films', { mode: 'develop_my_idea', _token: 'empty-brief-1' }, { auth: AUTH });
  assert.equal(empty.status, 422, 'an empty premise brief must not create a film');
  const emptyBody = await empty.text();
  assert.match(emptyBody, /Working title is needed|Premise or story idea is needed/);
  assert.match(emptyBody, /role="alert"/, 'the refusal has to be announced to assistive tech');
  assert.ok(!emptyBody.includes('x'.repeat(50)), 'the refused payload must not be echoed back');

  const huge = await s.form('/studio/films', {
    mode: 'develop_my_idea', title: 'T'.repeat(300_000), premise: 'p'.repeat(400_000), links: '', notes: '', targetLength: '', _token: 'huge-brief-1',
  }, { auth: AUTH });
  assert.ok([413, 422].includes(huge.status), `a 400k brief got ${huge.status}`);
  const hugeBody = await huge.text();
  assert.match(hugeBody, /characters|too large|need(s)? attention/i);
  assert.equal(idOf(huge.headers.get('location')), null, 'an oversized brief created a film anyway');

  const state = await (await s.get('/studio/api/state', { auth: AUTH })).json();
  assert.equal(state.films.length, 0, 'neither refused brief should have left a record');
  assert.deepEqual(await readdir(join(s.dataDir, 'studio')).catch(() => []).then((n) => n.filter((x) => x.startsWith('film-'))), [],
    'a refused brief must not leave a film record (and the store need not even create the directory)');
  await s.close();
});

test('both entry modes create the same record and each says which it is', async () => {
  const s = await boot({ ...LIVE });
  const a = await s.form('/studio/films', { mode: 'bring_me_ideas', notes: 'quiet, morning light', _token: 'entry-ideas-1' }, { auth: AUTH });
  const b = await s.form('/studio/films', { mode: 'develop_my_idea', title: 'Salt Road', premise: 'Two strangers share a night drive.', targetLength: '45 seconds', links: 'https://example.org/ref', _token: 'entry-premise-1' }, { auth: AUTH });
  assert.equal(a.status, 303); assert.equal(b.status, 303);
  const [ida, idb] = [idOf(a.headers.get('location')), idOf(b.headers.get('location'))];
  for (const loc of [a.headers.get('location'), b.headers.get('location')]) {
    assert.match(loc ?? '', /^\/studio\/film\/[0-9a-f-]{36}(\?|$)/, `create should land on the new film's own page, saw ${loc}`);
  }

  const [sa, sb] = [await (await s.get(`/studio/film/${ida}/status`, { auth: AUTH })).json(), await (await s.get(`/studio/film/${idb}/status`, { auth: AUTH })).json()];
  assert.deepEqual(Object.keys(sa.stages), Object.keys(sb.stages), 'two entry modes produced two different pipelines');
  assert.equal(sa.status.tone, 'ready');
  assert.equal(sb.status.tone, 'ready');
  const pageB = await (await s.get(`/studio/film/${idb}`, { auth: AUTH })).text();
  assert.match(pageB, /Salt Road/);
  assert.match(pageB, /https:\/\/example\.org\/ref/, 'the owner-supplied link has to be visible on the record');
  assert.match(pageB, /DEMO mode — no generation backend connected|pipeline mode demo/i);
  await s.close();
});

test('a double submit creates one film, and says which record it repeated', async () => {
  const s = await boot({ ...LIVE });
  const fields = { mode: 'develop_my_idea', title: 'Twin', premise: 'One film only.', _token: 'double-submit-1' };
  const both = await Promise.all([
    s.form('/studio/films', fields, { auth: AUTH }),
    s.form('/studio/films', fields, { auth: AUTH }),
  ]);
  const ids = both.map((r) => idOf(r.headers.get('location')));
  assert.equal(new Set(ids).size, 1, `two films were created: ${ids.join(' / ')}`);
  const state = await (await s.get('/studio/api/state', { auth: AUTH })).json();
  assert.equal(state.films.length, 1);

  // a different token is genuinely a different film
  const other = await s.form('/studio/films', { ...fields, _token: 'double-submit-2' }, { auth: AUTH });
  assert.notEqual(idOf(other.headers.get('location')), ids[0]);
  assert.equal((await (await s.get('/studio/api/state', { auth: AUTH })).json()).films.length, 2);
  await s.close();
});

// ---------------------------------------------------------------- running, refreshing, failing

test('a stage shows as running while it runs, and a refresh sees the same truth', async () => {
  const s = await boot({ ...LIVE, STUDIO_DEMO_STAGE_DELAY_MS: '700' });
  const created = await s.form('/studio/films', { mode: 'bring_me_ideas', _token: 'midrun-1' }, { auth: AUTH });
  const id = idOf(created.headers.get('location'));
  const run = await s.form(`/studio/film/${id}/run`, { version: await versionOf(s, id) }, { auth: AUTH });
  assert.equal(run.status, 303);
  const flash = idOf(run.headers.get('location')) ? new URL(run.headers.get('location'), s.base).searchParams.get('i') : null;
  assert.ok(flash, 'the answer should redirect to the record with a one-shot notice');

  const during = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
  assert.deepEqual(during.running, ['research'], `expected research to be running, saw ${JSON.stringify(during.running)}`);
  assert.equal(during.status.tone, 'running');

  const pageDuring = await (await s.get(`/studio/film/${id}`, { auth: AUTH })).text();
  assert.match(pageDuring, /data-stage="research" data-status="in_progress"/);
  assert.match(pageDuring, /is working|not running/i);

  await new Promise((r) => setTimeout(r, 1200));
  const after = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
  assert.deepEqual(after.running, []);
  assert.equal(after.stages.research.status, 'done');
  assert.equal(after.stages.research.sample, true);
  await s.close();
});

test('a stage left running by a crash comes back failed after a restart, never done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-kill-'));
  const env = { ...LIVE, PORT: '0', DATA_DIR: dir, STUDIO_DATA_DIR: dir, STUDIO_DEMO_STAGE_DELAY_MS: '1200' };
  const app = await start({ env });
  const base = `http://127.0.0.1:${app.port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', authorization: AUTH }, body: new URLSearchParams(b).toString(), redirect: 'manual' });
  const st = async (b = base) => (await (await fetch(`${b}/studio/film/${id}/status`, { headers: { connection: 'close', authorization: AUTH } })).json());
  const id = idOf((await post('/studio/films', { mode: 'bring_me_ideas', _token: 'kill-token-1' })).headers.get('location'));
  await post(`/studio/film/${id}/run`, { version: String((await st()).version) });

  const running = await st();
  assert.deepEqual(running.running, ['research'], 'the run must be observable as running before the crash');

  // A kill -9 gets no chance to write anything, so the record is read exactly as it stands on disk
  // while the stage is still mid-run. Closing the server politely would let it record its own
  // shutdown, which is a different case and must not be tested as if it were a crash.
  const onDisk = JSON.parse(await readFile(join(dir, 'studio', `film-${id}.json`), 'utf8'));
  assert.equal(onDisk.stages.research.status, 'in_progress', 'the killed record should still say running');

  // a new process boots over the same directory and resolves the orphaned claim
  const second = await start({ env: { ...env, PORT: '0', STUDIO_DATA_DIR: dir, DATA_DIR: dir } });
  const base2 = `http://127.0.0.1:${second.port}`;
  const after = await st(base2);
  assert.equal(after.stages.research.status, 'failed', 'a killed stage must come back failed, never done and never silently retried');
  assert.match(JSON.stringify(after.failed), /running|interrupted|stopped/i);
  const page = await (await fetch(`${base2}/studio/film/${id}`, { headers: { connection: 'close', authorization: AUTH } })).text();
  assert.match(page, /data-stage="research" data-status="failed"/);
  assert.match(page, /Nothing is retried automatically/i);

  // the abandoned job from the first process must not resurrect its own result
  const late = await st(base2);
  assert.equal(late.stages.research.status, 'failed', 'a late answer from the dead process overwrote the recovered state');
  assert.equal(late.stages.research.attempts, 1, 'recovery must not count as a retry');

  await app.close();
  await second.close();
});

test('the poll cannot start or repeat work by itself', async () => {
  const s = await boot({ ...LIVE, STUDIO_DEMO_STAGE_DELAY_MS: '500' });
  const id = idOf((await s.form('/studio/films', { mode: 'bring_me_ideas', _token: 'poll-1' }, { auth: AUTH })).headers.get('location'));
  const pollFor = async (n) => { for (let i = 0; i < n; i += 1) await s.get(`/studio/film/${id}/status`, { auth: AUTH }); };
  await pollFor(10);
  let st = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
  assert.equal(st.stages.research.attempts, 0, 'reading the record ran a stage');
  assert.deepEqual(st.running, []);

  await s.form(`/studio/film/${id}/run`, { version: st.version }, { auth: AUTH });
  // twelve fetches used to be the way this waited; with a fire-and-forget run the stage can still be
  // in flight at fetch twelve, so an "in progress" answer is correct and the old expectation lied.
  const settled = await settle(s, id, 4000);
  st = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
  assert.ok(settled, `research never left the running state: ${JSON.stringify(st.running)}`);
  assert.equal(st.stages.research.attempts, 1, 'polling repeated the stage');
  assert.equal(st.stages.research.status, 'done');

  // the refusal is carried as a one-shot notice, so the test must follow the redirect to read it
  const again = await s.form(`/studio/film/${id}/run`, { version: st.version, stage: 'research' }, { auth: AUTH });
  assert.equal(again.status, 303, 'a refused action still redirects back to the record');
  const noticeUrl = new URL(again.headers.get('location'), s.base);
  assert.ok(noticeUrl.searchParams.get('i'), 'the refusal should arrive as one-shot notice, not a silent redirect');
  const back = await (await fetch(s.base + noticeUrl.pathname + noticeUrl.search, { headers: { connection: 'close', authorization: AUTH } })).text();
  assert.match(back, /already produced|already running|not be run again/i, `a second run of a finished stage was accepted`);
  assert.equal((await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json()).stages.research.attempts, 1);
  await s.close();
});

// ---------------------------------------------------------------- storage failure honesty

test('when the record cannot be written the page says so and shows no success', async () => {
  const s = await boot(LIVE);
  const id = idOf((await s.form('/studio/films', { mode: 'bring_me_ideas', _token: 'wet-1' }, { auth: AUTH })).headers.get('location'));

  await chmod(join(s.dataDir, 'studio'), 0o500);           // the disk stops taking writes
  const res = await s.form(`/studio/film/${id}/run`, { version: await versionOf(s, id) }, { auth: AUTH });
  const page = await (await s.get(`/studio/film/${id}`, { auth: AUTH })).text();
  await chmod(join(s.dataDir, 'studio'), 0o700);

  assert.match(page, /Nothing|could not be written|failed/i, 'a refused write must be reported on the page');
  assert.ok(!/research.*done/.test(page), 'a stage whose write failed cannot show as done');
  const st = await (await s.get(`/studio/film/${id}/status`, { auth: AUTH })).json();
  assert.equal(st.stages.research.status, 'waiting', 'the record must be unchanged, not half-written');
  assert.doesNotMatch(page, /started\.|wrote labelled sample/, 'a refused write must not read as work that happened');
  void res;
  await s.close();
});

test('a brand new film cannot be written when storage is already read-only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-ro-'));
  await (await import('node:fs/promises')).mkdir(join(dir, 'studio'), { recursive: true });
  await chmod(join(dir, 'studio'), 0o500);
  const app = await start({ env: { ...LIVE, PORT: '0', DATA_DIR: dir, STUDIO_DATA_DIR: dir } });
  const base = `http://127.0.0.1:${app.port}`;
  const r = await fetch(base + '/studio/films', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: AUTH },
    body: new URLSearchParams({ mode: 'bring_me_ideas', _token: 'ro-new-1' }).toString(), redirect: 'manual',
  });
  const body = await r.text();
  assert.ok([500, 503, 303].includes(r.status), `unexpected status ${r.status}`);
  if (r.status === 303) {
    const page = await (await fetch(base + new URL(r.headers.get('location'), base).pathname, { headers: { connection: 'close', authorization: AUTH } })).text();
    assert.match(page, /could not write|Nothing was changed|failed/i, 'a failed create that redirects must still say it failed');
  } else {
    assert.match(body, /could not be written|could not write|Nothing was saved/i);
  }
  assert.ok(!/Thank you|saved\./.test(body), 'a failure must never read as a success');
  await chmod(join(dir, 'studio'), 0o700);
  await app.close();
});

test('pipeline state survives a restart of the whole process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-persist-'));
  const env = { ...LIVE, PORT: '0', DATA_DIR: dir, STUDIO_DATA_DIR: dir };
  const first = await start({ env });
  const b1 = `http://127.0.0.1:${first.port}`;
  const mk = (p, body) => fetch(b1 + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', connection: 'close', authorization: AUTH }, body: new URLSearchParams(body).toString(), redirect: 'manual' });
  const readVer = async () => String((await (await fetch(`${b1}/studio/film/${id}/status`, { headers: { connection: 'close', authorization: AUTH } })).json()).version);
  const id = idOf((await mk('/studio/films', { mode: 'develop_my_idea', title: 'Kept', premise: 'Survives a restart.', _token: 'persist-1' })).headers.get('location'));
  await mk(`/studio/film/${id}/run`, { version: await readVer() });
  await new Promise((r) => setTimeout(r, 300));
  const before = await (await fetch(`${b1}/studio/film/${id}/status`, { headers: { connection: 'close', authorization: AUTH } })).json();
  assert.equal(before.stages.research.status, 'done');
  await first.close();

  const second = await start({ env: { ...env, PORT: '0' } });
  const after = await (await fetch(`http://127.0.0.1:${second.port}/studio/film/${id}/status`, { headers: { connection: 'close', authorization: AUTH } })).json();
  assert.equal(after.stages.research.status, 'done', 'a stage that finished before the restart came back as something else');
  assert.equal(after.version, before.version, 'the record version changed across a restart that did no work');
  assert.equal(after.briefTitle ?? undefined, undefined);
  await second.close();
});
