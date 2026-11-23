// The owner-only HTTP surface of the studio.
//
// Contract with routes.js: return TRUE if this function answered, FALSE if the path is not the
// studio's. Every branch therefore ends in a `done`/`redirect`/`json` helper that returns true.
// A view branch that returned undefined would fall through to the caller's 404 and write a second
// response onto a socket that had already been answered.

import { STATUS, STAGES, filmStatus, isStageKey, stageDef } from './stages.js';
import { validateBriefInput } from './brief.js';
import { capabilitiesSummary } from './generation.js';
import { authChallenge, checkOwnerAuth } from '../guards.js';
import { PipelineRule } from './pipeline.js';
import { layerList, resetConsequence } from './layers.js';

const CSP_STUDIO = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; object-src 'none'";
const ID = '[0-9a-f-]{36}';
const FLASH = new Map();
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const putFlash = (msg, tone = 'bad') => {
  const id = Math.random().toString(36).slice(2, 12);
  FLASH.set(id, { msg, tone });
  setTimeout(() => FLASH.delete(id), 120_000).unref?.();
  return id;
};
const takeFlash = (id) => { const f = FLASH.get(id); if (f) FLASH.delete(id); return f ?? null; };

/**
 * Every refusal the studio can answer with, in words an owner can act on. An unmapped reason
 * prints itself rather than disappearing, because a silent 500 is how a rule becomes invisible.
 */
export const REFUSALS = {
  storage_unavailable: 'The studio could not write its own record, so nothing was changed. The film you were looking at is unaffected.',
  not_found: 'No film with that id is stored here. Nothing was created in its place.',
  version_conflict: 'Someone else changed this film while this page was open. The stored record won and your action was dropped, not applied twice.',
  invalid_after_change: 'That change would have left the record inconsistent, so it was not written.',
  rejected_by_rule: 'The pipeline refused that.',
  already_running: 'That stage is already running for this film.',
  needs_decision: 'Approval gates are decided, not run.',
  needs_approval: 'A gate is waiting for your decision, not for a run.',
  gate_closed: 'That stage has not been unlocked yet.',
  upstream: 'The stage before this one has not produced anything yet.',
  call_budget: 'This film has used its backend-call budget.',
  failed: 'That stage failed and is not retried automatically.',
  unknown_stage: 'There is no stage by that name.',
  unknown_gate: 'That is not an approval gate.',
  bad_decision: 'A gate decision is approve or reject.',
  no_concept: 'Say which concept you are approving.',
  unknown_concept: 'That concept is not on this film.',
  gate_not_open: 'That gate is not waiting for a decision.',
  critique_not_passed: 'The director review has not passed this film.',
  missing_notes: 'A send-back must carry the notes the named stage needs.',
  bad_target: 'The review cannot send work back to that stage.',
  nothing_to_send_back: 'That stage has produced nothing to send back.',
  layer_refused: 'That direction value is not one this studio knows, so nothing was written and no stage was reset.',
  layers_while_running: 'A stage is working on this film right now, so the direction cannot change until it stops.',
  not_failed: 'That stage is not failed, so there is nothing to retry.',
  state_changed: 'The record changed underneath that stage, so its result was dropped instead of written over a newer state.',
  duplicate_submission: 'That entry repeated an earlier submission. The film it first made is the one shown here.',
  interrupted: 'A stage was interrupted mid-run and is recorded as failed, not done.',
  bad_body: 'The form body could not be read.',
};

const refusalText = (reason, error) => error || REFUSALS[reason] || `The studio refused that (${reason ?? 'no reason given'}).`;
const clip = (s, n = 240) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
const briefTitle = (f) => f.brief?.title || clip(f.brief?.premise, 44) || 'untitled film';
const capLine = (caps) => { const c = capabilitiesSummary(caps); return `pipeline mode ${c.pipelineMode} (${c.parts.join(' · ')})`; };
const fieldErrors = (errors) => Object.values(errors ?? {}).map(String).join(' ');

export function createStudioRoutes({ config, store, pipeline, caps, view }) {
  const tokenFor = (kind) => `${kind}-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-6)}`;

  // HEAD reads the same document as GET (the body is dropped by Node). Writes stay POST-only.
  const READ = (m) => m === 'GET' || m === 'HEAD';

  return async function studioRoutes({ req, res, url, json }) {
    const path = url.pathname.replace(/\/+$/, '') || '/studio';
    if (path !== '/studio' && path.startsWith('/studio') === false) return false;

    const send = (status, markup, extra = {}) => {
      const buf = Buffer.from(String(markup));
      res.writeHead(status, {
        'content-length': buf.length, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': CSP_STUDIO, ...extra,
      });
      res.end(buf);
      return true;
    };
    const to = (location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); return true; };
    const back = (id, msg, tone = 'bad') => to(`/studio/film/${id}?i=${putFlash(msg, tone)}`);

    // --- owner only. prototype has no credentials by design, so the workspace is open on this
    // machine and every page says so; live is refused. Both paths use the same guard as /owner.
    const auth = checkOwnerAuth(req, config);
    if (!auth.ok) {
      if (auth.reason !== 'prototype_mode') {
        return send(401, view.unauthorized({ reason: auth.reason, caps }), { 'www-authenticate': authChallenge() });
      }
    }
    const openPreview = config.mode !== 'live';
    const flash = url.searchParams.get('i');
    const f = flash ? takeFlash(flash) : null;
    const viewOpts = { openPreview, error: f?.tone === 'bad' ? f.msg : undefined, notice: f?.tone === 'ok' ? f.msg : undefined, retry: f?.tone === 'retry' ? f.msg : undefined };

    async function bodyOf() {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > config.studio.maxBodyBytes) return { tooLarge: true };
        chunks.push(c);
      }
      if (String(req.headers['content-type'] ?? '').includes('json')) {
        try { return { fields: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }; } catch { return { bad: true }; }
      }
      const out = {};
      for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) if (out[k] === undefined) out[k] = v;
      return { fields: out };
    }
    const versionOf = (b) => { const v = Number(b?.version); return Number.isSafeInteger(v) && v > 0 ? v : undefined; };

    // ------------------------------------------------------------------ GET views
    if (READ(req.method) && path === '/studio') {
      let films;
      try { films = await store.list(); }
      catch (e) { return send(500, view.error({ caps, title: 'Nothing could be listed', note: REFUSALS.storage_unavailable, openPreview, backTo: '/studio' })); }
      const tokens = { ideas: tokenFor('ideas'), premise: tokenFor('premise') };
      return send(200, view.index({
        films: films.filter((x) => !x.unreadable), unreadable: films.filter((x) => x.unreadable),
        caps, tokens, ...viewOpts,
        mode: config.mode, counts: films.length,
      }));
    }

    const detail = new RegExp(`^/studio/film/(${ID})$`).exec(path);
    if (READ(req.method) && detail) {
      const film = await store.find(detail[1]);
      if (!film) return send(404, view.error({ caps, title: 'No such film', note: REFUSALS.not_found, openPreview, backTo: '/studio' }));
      if (film.unreadable) return send(404, view.error({ caps, title: 'This film record cannot be read', note: film.error ?? REFUSALS.bad_body, openPreview, backTo: '/studio' }));
      return send(200, view.film({ film, caps, ...viewOpts }));
    }

    // ------------------------------------------------------------------ status + state (the poll)
    const statusApi = new RegExp(`^/studio/film/(${ID})/status$`).exec(path);
    if (READ(req.method) && statusApi) {
      const film = await store.find(statusApi[1]);
      if (!film) { json(404, { ok: false, reason: 'not_found' }); return true; }
      const s = filmStatus(film);
      json(200, {
        ok: true, id: film.id, version: film.version, status: s, pipelineMode: film.pipelineMode, unreadable: Boolean(film.shapeProblems),
        shapeProblems: film.shapeProblems ?? null,
        running: STAGES.filter((x) => film.stages[x.key].status === STATUS.RUNNING).map((x) => x.key),
        waitingOnYou: STAGES.filter((x) => film.stages[x.key].status === STATUS.NEEDS_APPROVAL).map((x) => x.key),
        failed: STAGES.filter((x) => film.stages[x.key].status === STATUS.FAILED).map((x) => ({ stage: x.key, error: film.stages[x.key].error })),
        stages: Object.fromEntries(STAGES.map((x) => [x.key, {
          status: film.stages[x.key].status, sample: film.stages[x.key].sample === true,
          hasOutput: Boolean(film.stages[x.key].output), attempts: film.stages[x.key].attempts ?? 0,
        }])),
      });
      return true;
    }

    if (READ(req.method) && path === '/studio/api/state') {
      const films = await store.list();
      json(200, {
        ok: true, runtimeMode: config.mode, pipelineMode: caps.pipelineMode, capabilities: capabilitiesSummary(caps),
        films: films.filter((x) => !x.unreadable).map((x) => ({ id: x.id, title: briefTitle(x), status: filmStatus(x), version: x.version })),
        unreadable: films.filter((x) => x.unreadable).map((x) => x.id),
      });
      return true;
    }

    // ------------------------------------------------------------------ create a film
    if (req.method === 'POST' && path === '/studio/films') {
      const raw = await bodyOf();
      if (raw.tooLarge) return send(413, view.error({ caps, title: 'That entry was too large', note: REFUSALS.bad_body, openPreview, backTo: '/studio' }));
      if (raw.bad) return send(400, view.error({ caps, title: 'That entry could not be read', note: REFUSALS.bad_body, openPreview, backTo: '/studio' }));
      const b = raw.fields;
      const token = TOKEN_RE.test(String(b._token ?? '')) ? String(b._token) : null;
      const checked = validateBriefInput(b);
      if (!checked.ok) {
        const films = await store.list();
        return send(422, view.index({
          films: films.filter((x) => !x.unreadable), unreadable: [], caps,
          tokens: { ideas: tokenFor('ideas'), premise: tokenFor('premise') },
          error: fieldErrors(checked.errors), openPreview, mode: config.mode,
          // what was typed comes back, including the layer choices, so a refused entry is repaired
          // rather than re-entered from scratch
          entered: {
            title: b.title, premise: b.premise, notes: b.notes, targetLength: b.targetLength,
            links: Array.isArray(b.links) ? b.links : String(b.links ?? '').split(/\r?\n/).filter(Boolean),
            layers: checked.layers,
          },
          fieldErrors: checked.errors,
        }));
      }
      try {
        const created = await pipeline.startFilm(checked.value, token);
        if (created.reused) return back(created.film.id, REFUSALS.duplicate_submission, 'ok');
        return back(created.film.id, `Film started. ${capLine(caps)}.`, 'ok');
      } catch (e) {
        const note = /storage could not be written/.test(String(e?.message)) ? REFUSALS.storage_unavailable : `The studio could not start this film: ${clip(e?.message)}`;
        return send(503, view.error({ caps, title: 'Nothing was saved', note, openPreview, backTo: '/studio' }));
      }
    }

    // ------------------------------------------------------------------ change the direction
    // Validation happens inside pipeline.changeLayers, before the record is opened for writing, so
    // a refused value cannot leave a partially-updated brief behind.
    const layersApi = new RegExp(`^/studio/film/(${ID})/layers$`).exec(path);
    if (req.method === 'POST' && layersApi) {
      const id = layersApi[1];
      const raw = await bodyOf();
      if (raw.tooLarge || raw.bad) return back(id, REFUSALS.bad_body);
      const b = raw.fields ?? {};
      const r = await pipeline.changeLayers(id, { fields: b, note: b.note, expectedVersion: versionOf(b) });
      if (!r.ok) {
        if (r.reason === 'layer_refused' || r.reason === 'unreadable' || !r.film || r.film.unreadable) {
          if (!r.film) return send(404, view.error({ caps, title: 'No such film', note: REFUSALS.not_found, openPreview, backTo: '/studio' }));
          return send(422, view.film({
            film: r.film, caps, openPreview,
            error: r.reason === 'layer_refused' ? REFUSALS.layer_refused : refusalText(r.reason, r.error),
            layerErrors: r.errors ?? null, enteredLayers: r.attempted ?? null, enteredNote: String(b.note ?? ''),
          }));
        }
        return back(id, refusalText(r.reason, r.error));
      }
      if (r.unchanged) {
        return back(id, 'Nothing was saved: those are already the values on this brief, so no stage was reset.', 'ok');
      }
      // The flash line carries the consequence in full, from the same rule the write used.
      return back(id, `Direction saved (${layerList(r.changed)}). ${resetConsequence(r.changed)}`, 'ok');
    }

    // ------------------------------------------------------------------ actions on one film
    const act = new RegExp(`^/studio/film/(${ID})/(run|gate|choose|send-back|retry)$`).exec(path);
    if (req.method === 'POST' && act) {
      const [, id, verb] = act;
      const raw = await bodyOf();
      if (raw.tooLarge || raw.bad) return back(id, REFUSALS.bad_body);
      const b = raw.fields ?? {};
      const refused = (reason, error) => back(id, refusalText(reason, error));

      try {
        if (verb === 'run') {
          if (b.stage && !isStageKey(b.stage)) return refused('unknown_stage');
          // Claim and answer. The work continues against the stored record, so a refresh during a
          // run sees "in progress", a crash leaves a claim to recover, and one HTTP request cannot
          // hold a browser hostage for the length of a backend call.
          const step = await pipeline.claimStage(id, b.stage ?? null, versionOf(b));
          if (!step.ok) return refused(step.kind, step.error);
          pipeline.runClaimed(step.film, step.stage).catch((e) => logRefusal(id, step.stage, e));
          return back(id, `${stageDef(step.stage).role} started. This page reads the stored record and stops refreshing by itself when nothing is running.`, 'started');
        }
        if (verb === 'choose') {
          const r = await pipeline.chooseConcept(id, String(b.ref ?? ''), versionOf(b));
          if (!r.ok) return refused(r.reason, r.error);
          return back(id, `Chosen: ${clip(r.film.chosenConcept?.workingTitle, 80)}. Gate 1 still needs your decision.`, 'ok');
        }
        if (verb === 'gate') {
          const r = await pipeline.decideGate(id, String(b.gate ?? ''), String(b.decision ?? ''), {
            notes: b.notes, sendTo: b.sendTo, conceptRef: b.ref, expectedVersion: versionOf(b),
          });
          if (!r.ok) return refused(r.reason, r.error);
          const word = b.decision === 'approve' ? 'Approved' : 'Rejected';
          const extra = b.gate === 'gate_release' && b.decision === 'approve' ? ' Nothing was published by that decision.' : '';
          return back(id, `${word} at ${stageDef(b.gate).role.replace('You — ', '')}.${extra} ${filmStatus(r.film).label}.`, 'ok');
        }
        if (verb === 'send-back') {
          const r = await pipeline.critiqueSendBack(id, { stage: b.stage, notes: b.notes, expectedVersion: versionOf(b) });
          if (!r.ok) return refused(r.kind ?? r.reason, r.error);
          return back(id, `Sent back to ${stageDef(b.stage)?.role ?? b.stage}. Every stage after it is voided rather than left looking finished.`, 'ok');
        }
        if (verb === 'retry') {
          const r = await pipeline.retryFailed(id, String(b.stage ?? ''), versionOf(b));
          if (!r.ok) return refused(r.reason, r.error);
          return back(id, `${stageDef(b.stage).role} is waiting again. Nothing has run yet - press Run when you want it to.`, 'retry');
        }
      } catch (e) {
        if (e instanceof PipelineRule) return refused(e.reason, e.message);
        if (/storage could not be written/.test(String(e?.message))) return refused('storage_unavailable');
        return refused('rejected_by_rule', `The studio could not do that: ${clip(e?.message)}`);
      }
    }

    return false;
  };
}

function logRefusal(filmId, stage, err) {
  // the browser already left; keep a line so a vanished failure is not invisible
  process.emitWarning(`studio stage ${stage} on ${filmId} ended unexpectedly: ${String(err?.message ?? err).slice(0, 200)}`);
}

const lastRunningStage = (film) => (film ? STAGES.find((s) => film.stages[s.key].status === STATUS.DONE && s.key !== 'research')?.key ?? 'research' : null);
