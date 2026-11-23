// The pipeline: one film record, walked stage by stage. Roles are stages over that shared record,
// not seven services and never seven model calls for the same text.
//
// What "in progress" and "done" mean here is deliberately physical:
//   - RUNNING is written and persisted before any work starts;
//   - DONE is written only with an output in the same atomic update;
//   - FAILED keeps the error and is never retried by this code;
//   - a stage whose run was interrupted is resolved at boot, not here.

import { ENTRY, KIND, NEXT_AFTER, STATUS, STAGES, filmStatus, isStageKey, stageDef, stageIndex } from './stages.js';
import { LIMITS, assertFilmShape, failStage, finishStage, pushHistory, recordDecision, sendBack, startStage } from './brief.js';
import { applyLayerChange, changedLayers, defaultLayers, layerList, parseLayerFields, resetPlan, summaryLine } from './layers.js';
import { SAMPLE, BackendUnavailable, briefDigest, capabilitiesSummary, runMediaStage, runResearchStage, runTextStage, sampleForStage } from './generation.js';
import { randomUUID } from 'node:crypto';

export class PipelineRule extends Error {
  constructor(message, reason = 'rule') { super(message); this.kind = 'rule'; this.reason = reason; }
}

export function createStudioPipeline({ config, store, caps, prompts, model, retriever = null, media = null, log = () => {} }) {
  // Fail at wiring time, not halfway through a stage. A capability advertised without an object
  // behind it would otherwise appear as a crashed stage with a message nobody can act on.
  const wiring = [];
  if (!store || !caps || !prompts) wiring.push('store, caps and prompts are all required');
  if (caps.retrieval && typeof retriever?.retrieve !== 'function') wiring.push(`caps advertises retrieval (${caps.retrieval.kind}) but no retriever.retrieve() was given`);
  if (caps.text && typeof model?.complete !== 'function') wiring.push(`caps advertises text generation (${caps.text.kind}) but no model.complete() was given`);
  if (caps.mediaReady && !media) wiring.push('caps advertises media generation but no media clients were given');
  if (wiring.length) throw new Error(`studio pipeline wiring is incomplete: ${wiring.join('; ')}`);

  caps.maxPromptBytes = caps.maxPromptBytes ?? config.model.maxPromptBytes;
  const jobs = new Map();
  const runLimit = config.studio.maxCallsPerFilm;
  const demoDelayMs = config.studio.demoStageDelayMs;

  const sleep = (ms, signal) => new Promise((res, rej) => {
    if (!ms) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener?.('abort', () => { clearTimeout(t); rej(abortError()); }, { once: true });
  });
  const abortError = () => Object.assign(new Error('the studio process stopped while this stage was running'), { kind: 'interrupted' });

  // ---------------------------------------------------------------- readiness
  function readiness(f, key) {
    const def = stageDef(key);
    if (!def) return { ok: false, reason: 'unknown_stage', error: `no pipeline stage named ${JSON.stringify(key)}` };
    const st = f.stages[key];
    if (st.status === STATUS.RUNNING) return { ok: false, reason: 'already_running', error: `${def.role} is already running this stage.` };
    if (st.status === STATUS.DONE) return { ok: false, reason: 'already_done', error: `${def.role} has already produced this. Its output is in the brief.` };
    if (st.status === STATUS.FAILED) return { ok: false, reason: 'failed', error: `${def.role} failed and nothing is retried automatically: ${truncate(st.error ?? 'no error kept', 200)}` };
    // the decision-first check comes before ordering: "a gate is not runnable" is true regardless of
    // what upstream did, and it is the sentence that stops someone hammering Run on an approval card
    if (def.kind === KIND.APPROVAL) return { ok: false, reason: 'needs_decision', error: 'Approval gates are not run; they are approved or rejected.' };
    if (st.status === STATUS.NEEDS_APPROVAL) return { ok: false, reason: 'needs_approval', error: `${def.role} is a decision for you, not a stage to run.` };

    const idx = stageIndex(key);
    for (let i = 0; i < idx; i += 1) {
      const prev = STAGES[i];
      const p = f.stages[prev.key];
      if (prev.kind === KIND.APPROVAL && p.approval !== 'approve') {
        return { ok: false, reason: 'gate_closed', error: `${def.role} cannot start before ${prev.role} is approved.` };
      }
      if (prev.kind !== KIND.APPROVAL && p.status !== STATUS.DONE) {
        return { ok: false, reason: 'upstream', error: `${def.role} comes after ${prev.role}, whose output does not exist yet (${labelOf(p.status)}).` };
      }
    }
    if (f.callsUsed >= runLimit && !def.demoOnly && caps.pipelineMode === 'real') {
      return { ok: false, reason: 'call_budget', error: `${def.role} needs a backend call and this film has used its budget of ${runLimit}. Raising it is a config decision, not something to do quietly.` };
    }
    return { ok: true, def, st };
  }

  const labelOf = (s) => ({ waiting: 'waiting', in_progress: 'in progress', done: 'done', sent_back: 'sent back', needs_my_approval: 'needs your approval', failed: 'failed' })[s] ?? s;

  const nextRun = (film) => {
    for (const s of STAGES) {
      const st = film.stages[s.key];
      if (st.status === STATUS.RUNNING) return { key: s.key, state: 'running' };
      if (st.status === STATUS.NEEDS_APPROVAL) return { key: s.key, state: 'needs_approval' };
      if (st.status === STATUS.FAILED) return { key: s.key, state: 'failed' };
      if (st.status === STATUS.WAITING || st.status === STATUS.SENT_BACK) {
        const r = readiness(film, s.key);
        return { key: s.key, state: r.ok ? 'ready' : 'blocked', blocked: r.ok ? null : r };
      }
    }
    return { key: null, state: 'complete' };
  };

  // ---------------------------------------------------------------- the work itself
  /** Demo mode is a fact about configuration, so the sample says which backend is missing. */
  // "missing" decides sample vs real. An endpoint that is configured without a client is NOT
  // missing: it must attempt and fail, because turning a half-configured backend into a sample
  // would look like progress and hide the thing you need to fix.
  const MEDIA_NEED = { storyboard: ['images'], assets: ['video', 'voice', 'music'], edit: ['video'] };
  function missingFor(def, key) {
    if (def.kind === KIND.RETRIEVAL) return caps.retrieval ? null : 'retrieval';
    if (def.kind === KIND.MODEL) return caps.text ? null : 'text generation';
    if (def.kind === KIND.MEDIA) {
      const need = MEDIA_NEED[key] ?? [];
      const anyClient = need.some((k) => caps.media[k]);
      const anyEndpointNoClient = need.some((k) => caps.mediaEndpoints?.[k] && !caps.media[k]);
      if (anyClient || anyEndpointNoClient) return null;
      return need.join(', ') + ' generation';
    }
    return null;
  }

  /**
   * Only the values a stage genuinely needs from earlier stages, so a film's concept, script and
   * edit travel together without the brief being re-summarised once per role.
   */
  function textExtras(f) {
    const extra = [];
    const chosen = (f.stages.concept.output?.items ?? []).find((c) => c.ref === (f.chosenConcept?.ref ?? f.chosenConcept));
    if (chosen) extra.push({ label: 'the concept approved at gate 1', value: JSON.stringify(chosen) });
    if (f.stages.script.output) extra.push({ label: 'the script in the brief', value: JSON.stringify(f.stages.script.output) });
    if (f.stages.edit.output) extra.push({ label: 'the assembled edit', value: JSON.stringify(f.stages.edit.output) });
    return extra;
  }

  async function doWork(f, key, signal) {
    const def = stageDef(key);
    // the test pace applies to every stage, so a run can be interrupted at any point
    if (demoDelayMs) await sleep(demoDelayMs, signal);
    const missing = missingFor(def, key);
    if (missing) {
      return { output: sampleForStage(key, f), sample: true, sampleReason: missing };
    }
    if (def.kind === KIND.RETRIEVAL) return runResearchStage({ film: f, caps, retriever, signal });
    if (def.kind === KIND.MEDIA) return runMediaStage({ key, film: f, caps, tools: media, signal });
    return runTextStage({ key, film: f, caps, prompts, model, signal, extra: textExtras(f) });
  }

  /** Writes RUNNING first, so a refresh in the middle of a run shows work that is genuinely going on. */
  async function writeRunning(filmId, key, expectedVersion) {
    const res = await store.update(filmId, expectedVersion, (f) => {
      const ready = readiness(f, key);
      if (!ready.ok) return { abort: true, error: ready.error, reason: ready.reason };
      startStage(f, key, { note: `${stageDef(key).role} picked up this stage${caps.pipelineMode === 'demo' ? ' in demo mode' : ''}.` });
      f.status = 'running';
      return null;
    });
    if (!res.ok) throw new PipelineRule(res.error ?? res.reason, res.reason ?? 'rule');
    return res.film;
  }

  function settle(filmId, key, made, startedAt) {
    return store.update(filmId, undefined, (f) => {
      const st = f.stages[key];
      if (st.status !== STATUS.RUNNING) {
        return { abort: true, error: `${stageDef(key).role} was no longer running when the backend answered, so that answer was dropped rather than written over a newer state.`, reason: 'state_changed' };
      }
      if (made.sample) {
        finishStage(f, key, made.output, { sample: true, note: `${SAMPLE}. This stage wrote labelled sample output because no ${made.sampleReason} backend is configured.` });
      } else {
        // the worker already stamped provenance; re-wrapping it here once swallowed the stage output
        if (!made.output?.generated) made.output = { ...made.output, generated: { backend: backendName(f, key), at: new Date().toISOString() } };
        finishStage(f, key, made.output, { sample: false });
        f.callsUsed = (f.callsUsed ?? 0) + 1;
      }
      mirrorIntoBrief(f, key);
      // a critique verdict of send_back is acted on here, not parked in an output nobody reads
      if (key === 'critique') {
        const v = f.stages.critique.output;
        if (v?.verdict === 'send_back') {
          sendBack(f, 'critique', v.sendBackTo, v.notes, 'Creative director — review pass');
          unlockNext(f, 'critique');
        } else unlockNext(f, key);
      } else unlockNext(f, key);
      if (startedAt) f.stages[key].claimedAt = startedAt;
      f.status = filmStatus(f).tone;
      return null;
    });
  }

  const backendName = (f, key) => (stageDef(key).kind === KIND.MODEL ? `${caps.text?.kind ?? 'model'}${caps.text?.model ? ` / ${caps.text.model}` : ''}`
    : stageDef(key).kind === KIND.RETRIEVAL ? caps.retrieval?.kind ?? 'retrieval' : Object.entries(caps.media ?? {}).filter(([, v]) => v).map(([k]) => k).join('+') || 'media');

  /** Stages write into the one record; nobody keeps a side copy of the film. */
  function mirrorIntoBrief(f, key) {
    const out = f.stages[key].output;
    if (!out) return;
    if (key === 'research') f.research = out;
    if (key === 'concept') f.concepts = out.items ?? null;
    if (key === 'script') f.script = out;
    if (key === 'storyboard') f.storyboards = out;
    if (key === 'assets') f.assets = out;
    if (key === 'edit') f.edit = out;
    if (key === 'marketing') f.marketing = out;
  }

  function unlockNext(f, key) {
    const next = NEXT_AFTER[key];
    if (!next) return;
    const def = stageDef(next);
    const st = f.stages[next];
    if (st.status !== STATUS.WAITING) return;
    if (def.kind === KIND.APPROVAL) {
      st.status = STATUS.NEEDS_APPROVAL;
      st.actor = def.role;
      pushHistory(f, {
        actor: def.role, kind: 'needs_approval', stage: next,
        text: next === 'gate_concept'
          ? 'Approve one concept before anything is written or designed'
          : 'Approve the finished film for release, or send it back. Approving publishes nothing.',
        pendingSince: new Date().toISOString(),
      });
    } else {
      pushHistory(f, { actor: stageDef(key).role, kind: 'handed_off', stage: key, to: next, text: `Handed to ${def.role}.` });
    }
  }

  // ---------------------------------------------------------------- public operations
  /**
   * Claim = persist "running" and refuse anything that breaks the order or the gates.
   * runClaimed = do the work afterwards. Split because a browser must not wait on a backend:
   * it claims, gets told the stage is in progress, and polls the record.
   */
  /**
   * Result-shaped claim for the HTTP layer: resolves the next runnable stage when none is named and
   * returns a refusal instead of throwing, so a browser gets one sentence rather than a stack.
   */
  async function claimStage(filmId, key, expectedVersion) {
    let f = await store.find(filmId);
    if (!f) return { ok: false, kind: 'not_found', error: 'no film with that id is stored here' };
    let stageKey = key;
    if (!stageKey) {
      const n = nextRun(f);
      if (!n.key) return { ok: false, kind: 'complete', error: 'this film has no stage left to run' };
      if (n.state !== 'ready') return { ok: false, kind: n.blocked?.reason ?? n.state, error: n.blocked?.error ?? `${stageDef(n.key).role} is not ready.` };
      stageKey = n.key;
    }
    const jobKey = `${filmId}:${stageKey}`;
    if (jobs.has(jobKey)) return { ok: false, kind: 'already_running', error: `${stageDef(stageKey).role} is already running this stage for this film.` };
    let claimed;
    try {
      claimed = await writeRunning(filmId, stageKey, expectedVersion ?? f.version);
    } catch (e) {
      if (e instanceof PipelineRule) return { ok: false, kind: e.reason, error: e.message };
      throw e;
    }
    jobs.set(jobKey, { controller: new AbortController(), claimedAt: new Date().toISOString() });
    return { ok: true, film: claimed, stage: stageKey };
  }

  /** The suite-facing claim: throws a PipelineRule on refusal, returns the running record. */
  async function claim(filmId, key, expectedVersion) {
    const jobKey = `${filmId}:${key}`;
    if (jobs.has(jobKey)) throw new PipelineRule(`${stageDef(key).role} is already running this stage for this film`, 'already_running');
    const claimed = await writeRunning(filmId, key, expectedVersion);
    jobs.set(jobKey, { controller: new AbortController(), claimedAt: new Date().toISOString() });
    return claimed;
  }

  function runClaimed(film, key) {
    const jobKey = `${film.id}:${key}`;
    const entry = jobs.get(jobKey);
    const signal = entry?.controller?.signal;
    const done = (result) => { jobs.delete(jobKey); return result; };
    return (async () => {
      let made;
      try { made = await doWork(film, key, signal); }
      catch (err) {
        const res = await store.update(film.id, undefined, (f) => {
          if (f.stages[key].status !== STATUS.RUNNING) return { abort: true };
          failStage(f, key, err);
          f.status = 'blocked';
          return null;
        });
        log('stage_failed', { film: film.id, stage: key, kind: err.kind ?? 'error' });
        return done({ ok: false, stage: key, error: truncate(err.message ?? String(err), 400), kind: err.kind ?? 'stage_failed', film: res.film ?? await store.find(film.id) });
      }
      const res = await settle(film.id, key, made, entry?.claimedAt);
      log(res.ok ? 'stage_done' : 'stage_settle_refused', { film: film.id, stage: key, sample: made.sample === true, reason: res.reason });
      return done(res.ok
        ? { ok: true, film: res.film, stage: key, sample: made.sample === true }
        : { ok: false, error: res.error ?? `the record refused this result (${res.reason})`, kind: res.reason, film: res.film });
    })();
  }

  /**
   * Await both halves. A rule refusal (already running, wrong order, gate closed) comes back as a
   * result rather than a throw, because callers run stages in parallel and a rejected promise in a
   * Promise.all hides which one was refused.
   */
  async function start(filmId, key, expectedVersion) {
    let claimed;
    try { claimed = await claim(filmId, key, expectedVersion); }
    catch (err) {
      if (err instanceof PipelineRule) return { ok: false, error: err.message, kind: err.reason, film: await store.find(filmId).catch(() => null) };
      throw err;
    }
    return runClaimed(claimed, key);
  }
  /** Everything sample output is paced so a run is observable rather than instantaneous. */
  async function startFilm(input, clientToken) {
    const film = {
      id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1,
      entryMode: input.mode, runtimeMode: config.mode, pipelineMode: caps.pipelineMode,
      brief: { title: input.title, premise: input.premise, notes: input.notes, targetLength: input.targetLength, links: input.links ?? [],
        layers: input.layers ?? defaultLayers() },
      chosenConcept: null, concepts: null, research: null, script: null, storyboards: null, assets: null, edit: null, marketing: null,
      status: 'ready', stages: Object.fromEntries(STAGES.map((s) => [s.key, { status: STATUS.WAITING, output: null, attempts: 0 }])),
      decisions: [], history: [], callsUsed: 0, clientToken: clientToken ?? null, modeSummary: capabilitiesSummary(caps),
    };
    pushHistory(film, {
      actor: 'You', kind: 'created', stage: 'research',
      text: input.mode === ENTRY.IDEAS ? 'Started with "Bring me ideas": three concepts will be proposed for you to choose from.'
        : 'Started with "Develop my idea": your premise goes through the same stages as a chosen concept.',
      direction: summaryLine(film),
    });
    const created = await store.create(film, clientToken ?? null);
    if (created.reused) return { ...created, warning: 'this submission repeated an earlier one; the film it first made is the one returned' };
    return created;
  }

  async function advanceClaim(filmId, expectedVersion) {
    const f = await store.find(filmId);
    if (!f) throw new PipelineRule('no such film', 'not_found');
    const n = nextRun(f);
    if (!n.key) throw new PipelineRule('this film has no stage left to run', 'complete');
    if (n.state !== 'ready') throw new PipelineRule(n.blocked?.error ?? `${stageDef(n.key).role} is ${labelOf(f.stages[n.key].status)}`, n.state);
    return { claimed: await claim(filmId, n.key, expectedVersion ?? f.version), key: n.key };
  }

  async function advance(filmId, expectedVersion) {
    let step;
    try { step = await advanceClaim(filmId, expectedVersion); }
    catch (err) {
      if (err instanceof PipelineRule) return { ok: false, error: err.message, kind: err.reason ?? 'rule', film: await store.find(filmId).catch(() => null), refused: true };
      throw err;
    }
    return runClaimed(step.claimed, step.key);
  }

  function chooseConcept(filmId, ref, expectedVersion) {
    return store.update(filmId, expectedVersion, (f) => {
      const items = f.stages.concept.output?.items ?? [];
      const picked = items.find((c) => c.ref === ref);
      if (!picked) return { abort: true, error: `${JSON.stringify(ref)} is not a concept on this film (${items.map((c) => c.ref).join(', ') || 'none produced yet'})`, reason: 'unknown_concept' };
      f.chosenConcept = { ref: picked.ref, workingTitle: picked.workingTitle, sample: f.stages.concept.sample === true };
      pushHistory(f, { actor: 'You', kind: 'chose', stage: 'concept', text: `You chose ${truncate(picked.workingTitle, 70)}.`, ref: picked.ref });
      return null;
    });
  }

  function decideGate(filmId, gate, decision, { notes, sendTo, conceptRef, expectedVersion } = {}) {
    if (!['gate_concept', 'gate_release'].includes(gate)) throw new PipelineRule(`${gate} is not an approval gate`, 'unknown_gate');
    if (!['approve', 'reject'].includes(decision)) throw new PipelineRule('a gate decision is approve or reject', 'bad_decision');
    return store.update(filmId, expectedVersion, (f) => {
      const st = f.stages[gate];
      if (st.status !== STATUS.NEEDS_APPROVAL) return { abort: true, error: gateMessage(gate, st, f), reason: 'gate_not_open' };

      if (gate === 'gate_concept') {
        if (decision === 'approve') {
          const ref = conceptRef ?? f.chosenConcept?.ref;
          const picked = (f.stages.concept.output?.items ?? []).find((c) => c.ref === ref);
          if (!picked) return { abort: true, error: 'Say which concept you are approving — the brief needs one chosen title before anything is written.', reason: 'no_concept' };
          f.chosenConcept = { ref: picked.ref, workingTitle: picked.workingTitle, sample: f.stages.concept.sample === true };
          st.approval = 'approve'; st.status = STATUS.DONE;
          st.output = { approvedRef: picked.ref, notes: notes ?? null };
          pushHistory(f, { actor: 'You', kind: 'approved', stage: gate, text: `Gate 1 approved: writing and design may now start on ${truncate(picked.workingTitle, 70)}.` });
        } else {
          const target = STAGES.find((s) => s.key === sendTo && ['research', 'concept'].includes(s.key)) ? sendTo : 'concept';
          st.approval = 'reject'; st.status = STATUS.WAITING; st.output = null;
          sendBack(f, gate, target, notes || 'Rejected at gate 1: a new pass is wanted before anything is written or designed.', 'You');
          pushHistory(f, { actor: 'You', kind: 'rejected', stage: gate, text: `Gate 1 rejected. Work goes back to ${stageDef(target).role}.` });
        }
      } else {
        const critique = f.stages.critique;
        if (decision === 'approve' && critique.output?.verdict !== 'pass') {
          return { abort: true, error: `Release approval needs the director's pass first. The review ${critique.status === STATUS.DONE ? `sent this back to ${stageDef(critique.output?.sendBackTo ?? 'edit').role}` : 'has not run yet'}.`, reason: 'critique_not_passed' };
        }
        st.approval = decision;
        if (decision === 'approve') {
          st.status = STATUS.DONE;
          st.output = { at: new Date().toISOString(), notes: notes ?? null, published: false, publishAction: 'none: this build has no publishing path' };
          pushHistory(f, { actor: 'You', kind: 'approved_release', stage: gate, text: 'Approved for release. Nothing was published, and nothing on this page can publish.' });
        } else {
          const target = stageDef('critique').canSendBackTo.includes(sendTo) ? sendTo : 'edit';
          st.status = STATUS.WAITING; st.output = null;
          sendBack(f, gate, target, notes || 'You did not approve this for release.', 'You');
          pushHistory(f, { actor: 'You', kind: 'rejected_release', stage: gate, text: `Gate 2 rejected. Back to ${stageDef(target).role}.` });
        }
      }
      recordDecision(f, { gate, decision, notes });
      unlockNext(f, gate);
      f.status = filmStatus(f).tone;
      return null;
    });
  }

  const gateMessage = (gate, st, f) => {
    if (st.status === STATUS.DONE) return 'This gate is already decided. The decision is recorded on the film.';
    if (gate === 'gate_concept') return `Gate 1 opens once ${stageDef('concept').role} proposes something. Right now that stage is ${labelOf(f.stages.concept.status)}.`;
    return `Gate 2 opens after the film is assembled and ${stageDef('critique').role} passes it. The review is ${labelOf(f.stages.critique.status)}.`;
  };

  async function critiqueSendBack(filmId, { stage, notes, expectedVersion }) {
    if (!isStageKey(stage)) return { ok: false, kind: 'unknown_stage', error: `no pipeline stage named ${JSON.stringify(stage)}`, film: await store.find(filmId).catch(() => null) };
    if (!String(notes ?? '').trim()) return { ok: false, kind: 'missing_notes', error: 'a send-back must carry the notes the named stage needs, or it is not actionable', film: await store.find(filmId).catch(() => null) };
    return store.update(filmId, expectedVersion, (f) => {
      if (!stageDef('critique').canSendBackTo.includes(stage)) return { abort: true, error: `The review pass cannot send work back to ${stageDef(stage).role}.`, reason: 'bad_target' };
      if (f.stages[stage].status !== STATUS.DONE) return { abort: true, error: `${stageDef(stage).role} has produced nothing to send back.`, reason: 'nothing_to_send_back' };
      sendBack(f, 'critique', stage, notes, 'Creative director — review pass');
      f.status = filmStatus(f).tone;
      return null;
    });
  }

  function retryFailed(filmId, stage, expectedVersion) {
    return store.update(filmId, expectedVersion, (f) => {
      const st = f.stages[stage];
      if (!st) return { abort: true, error: `no pipeline stage named ${JSON.stringify(stage)}` };
      if (st.status !== STATUS.FAILED) return { abort: true, error: `${stageDef(stage).role} is ${labelOf(st.status)}, so there is nothing to retry.`, reason: 'not_failed' };
      pushHistory(f, { actor: 'You', kind: 'retry_requested', stage, text: `You asked ${stageDef(stage).role} to try again. The error that stopped it stays on record.` });
      st.status = STATUS.WAITING;
      return null;
    });
  }

  /**
   * Editing the four brief layers on a saved film.
   *
   * Order matters here. The values are parsed and refused *before* the record is opened for
   * writing, so a submission containing one unknown look never reaches disk and never resets a
   * stage: there is no half-applied change to explain afterwards. Once it is accepted,
   * applyLayerChange resets exactly the stages RESET_START says it must, withdraws both approvals,
   * and the whole thing lands in one compare-and-set update: if another tab changed the film first,
   * this write is dropped rather than applied on top.
   */
  async function changeLayers(filmId, { fields = {}, note = '', expectedVersion } = {}) {
    const parsed = parseLayerFields(fields);
    const errors = { ...parsed.errors };
    const cleanNote = String(note ?? '').trim();
    if (cleanNote.length > 400) errors.note = 'Keep the reason under 400 characters so it stays readable on every stage card.';
    if (Object.keys(errors).length) {
      // nothing was read for writing, so the stored record is exactly as it was
      const film = await store.find(filmId).catch(() => null);
      return { ok: false, reason: 'layer_refused', errors, attempted: parsed.layers, film };
    }

    const current = await store.find(filmId).catch(() => null);
    if (!current) return { ok: false, reason: 'not_found' };
    if (current.unreadable) return { ok: false, reason: 'unreadable', error: current.error, film: current };

    const before = current.brief?.layers ?? defaultLayers();
    const changed = changedLayers(before, parsed.layers);
    if (!changed.length) {
      // Same values back. Writing this would reset stages for nothing, so the file is not touched.
      return { ok: true, unchanged: true, changed: [], plan: resetPlan([]), film: current };
    }

    const busy = STAGES.filter((x) => current.stages?.[x.key]?.status === STATUS.RUNNING).map((x) => x.key);
    if (busy.length) {
      return { ok: false, reason: 'layers_while_running', busy, film: current,
        error: `${stageDef(busy[0]).role} is working on this record right now. Changing the direction mid-run would leave it finishing a brief it was never given.` };
    }

    const stale = new Set(resetPlan(changed).stale);
    return store.update(filmId, expectedVersion, (f) => {
      const plan = applyLayerChange(f, { layers: parsed.layers, changed, note: cleanNote });
      // A gate that was asking for a decision about work that just went stale stops asking. The
      // question is asked again once that stage has produced something new.
      for (const gate of plan.gates) {
        const st = f.stages[gate];
        if (st.status !== STATUS.NEEDS_APPROVAL) continue;
        const askedAbout = STAGES[stageIndex(gate) - 1]?.key;
        if (!askedAbout || !stale.has(askedAbout)) continue;
        st.status = STATUS.WAITING;
        st.output = null;
        pushHistory(f, { actor: 'Studio', kind: 'approval_request_withdrawn', stage: gate,
          text: `The direction changed (${layerList(plan.changed)}), so the ${stageDef(askedAbout).role} you were being asked to approve no longer exists. This gate will ask again after the rework.` });
      }
      f.status = filmStatus(f).tone;
      return null;
    }).then((r) => (r.ok ? { ...r, changed, plan: resetPlan(changed) } : r));
  }

  async function stopInFlight(reason = 'shutting down') {
    for (const [, j] of jobs) { try { j.controller.abort(); } catch { /* ignore */ } }
    const waiting = [...jobs.values()].map((j) => j.job);
    jobs.clear();
    await Promise.race([Promise.allSettled(waiting), sleep(3000)]);
  }

  return {
    start, claim, claimStage, runClaimed, advance, advanceClaim, startFilm, chooseConcept, decideGate, critiqueSendBack, retryFailed, changeLayers, nextRun, readiness,
    stopInFlight, jobs, caps,
    stats: () => ({ running: jobs.size, mode: caps.pipelineMode, limit: runLimit }),
  };
}

const truncate = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
