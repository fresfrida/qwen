// The one film brief. Every stage reads this record and writes back into it; a stage never keeps
// its own private copy, so these shapes are the contract between them.

import { ENTRY, KIND, NEXT_AFTER, STAGES, STATUS, isStageKey, stageDef } from './stages.js';
import { defaultLayers, isLayerValue, parseLayerFields } from './layers.js';
import { pushHistory } from './history.js';
// history.js holds the one implementation; re-exported so existing importers keep working
export { pushHistory };

/** Index of a stage in the pipeline order. Local because stages.js exports no such helper. */
const stageIndex = (key) => STAGES.findIndex((x) => x.key === key);
import { checkText } from '../validate.js';
import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({
  titleMax: 120,
  premiseMax: 4000,
  notesMax: 8000,
  linksMax: 12,
  linkMax: 2048,
  targetLengthMax: 40,
  ideas: 3,
});

const LENGTH_RE = /^\s*\d{1,4}\s*(seconds?|secs?|s|min(?:ute)?s?|m)\s*$/i;

/** @returns {{ok:boolean, value?:Object, errors:Object<string,string>}} */
export function validateBriefInput(body = {}) {
  const errors = {};
  const mode = String(body.mode ?? '').trim();
  if (!Object.values(ENTRY).includes(mode)) {
    errors.mode = 'Choose how you are starting: bring me ideas, or develop my idea.';
  }
  const clean = (name, max, { multiline = false, required = true } = {}) => {
    const raw = typeof body[name] === 'string' ? body[name] : '';
    if (!raw.trim()) {
      if (required) errors[name] = `${stageFieldLabel(name)} is needed.`;
      return '';
    }
    const r = checkText(raw, { max, multiline, label: stageFieldLabel(name) });
    if (!r.ok) { errors[name] = r.error; return ''; }
    return r.value;
  };

  const ownsIt = mode === ENTRY.PREMISE;
  const title = clean('title', LIMITS.titleMax, { required: ownsIt });
  const premise = clean('premise', LIMITS.premiseMax, { multiline: true, required: ownsIt });
  const notes = clean('notes', LIMITS.notesMax, { multiline: true, required: false });
  const targetLength = clean('targetLength', LIMITS.targetLengthMax, { required: false });
  if (targetLength && !LENGTH_RE.test(targetLength)) {
    errors.targetLength = 'Target length wants a number and a unit, like 30 seconds or 1 min.';
  }

  const rawLinks = body.links;
  const links = [];
  if (Array.isArray(rawLinks) ? rawLinks.length : String(rawLinks ?? '').trim()) {
    const list = (Array.isArray(rawLinks) ? rawLinks : String(rawLinks).split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > LIMITS.linksMax) errors.links = `Keep the list to ${LIMITS.linksMax} links or fewer.`;
    else {
      for (const l of list) {
        if (l.length > LIMITS.linkMax) { errors.links = `One link is longer than ${LIMITS.linkMax} characters.`; break; }
        let u;
        try { u = new URL(l); } catch { errors.links = `Not a link: ${l.slice(0, 60)}`; break; }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') { errors.links = `Only http(s) links: ${l.slice(0, 60)}`; break; }
        if (u.username || u.password) { errors.links = 'Links must not carry credentials.'; break; }
        links.push(u.toString());
      }
    }
  }

  // an empty "bring me ideas" form is a legitimate start: the studio has nothing to work from
  // except the intent, so there is nothing left to require here.
  //
  // The four layers go through the same gate as the text. An unrecognised value is an error here,
  // so nothing is stored and nothing is quietly defaulted to a different look.
  const parsed = parseLayerFields(body);
  Object.assign(errors, parsed.errors);

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: { mode, title, premise, notes, targetLength, links, layers: parsed.layers },
    layers: parsed.layers,
  };
}

const FIELD_LABELS = {
  title: 'Working title', premise: 'Premise or story idea', notes: 'Notes',
  targetLength: 'Target length', links: 'Facts or links to include', mode: 'Entry mode',
};
const stageFieldLabel = (n) => FIELD_LABELS[n] ?? n;

/** Blank stages, all waiting. Nothing is ever "done" before it has output. */
export function freshStageMap() {
  return Object.fromEntries(STAGES.map((s) => [s.key, { status: s.key === 'research' ? STATUS.WAITING : STATUS.WAITING, output: null, attempts: 0 }]));
}

/**
 * The film record. `history` is the handoff log the page shows, so "who did what" is answerable
 * from this record alone rather than from a log file nobody can open.
 */
export function createFilm(input, { mode, capabilities }) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    version: 1,
    entryMode: input.mode,
    runtimeMode: mode,                              // prototype | live
    pipelineMode: capabilities.pipelineMode,        // demo | real, decided by what is configured
    brief: {
      title: input.title,
      premise: input.premise,
      notes: input.notes,
      targetLength: input.targetLength,
      links: input.links,
      // typed layers, not free strings: {value, other} per layer plus the chosen genre list
      layers: input.layers ?? defaultLayers(),
    },
    chosenConcept: null,
    research: null,
    script: null,
    storyboards: null,
    assets: null,
    edit: null,
    status: 'ready',
    stages: freshStageMap(),
    decisions: [],
    history: [{ at: now, actor: 'You', kind: 'created', text: describeEntry(input.mode) }],
    clientToken: null,
  };
}

const describeEntry = (mode) => mode === ENTRY.IDEAS
  ? 'Started with "Bring me ideas": the studio will propose three concepts for you to choose from.'
  : 'Started with "Develop my idea": your premise goes through the same pipeline as a chosen concept.';

export function assertFilmShape(f) {
  const problems = [];
  if (!f || typeof f !== 'object') return ['film is not an object'];
  if (typeof f.id !== 'string' || !f.id) problems.push('missing id');
  if (!Number.isSafeInteger(f.version) || f.version < 1) problems.push('missing version counter');
  if (!Object.values(ENTRY).includes(f.entryMode)) problems.push(`unknown entryMode ${f.entryMode}`);
  if (!['demo', 'real'].includes(f.pipelineMode)) problems.push(`unknown pipelineMode ${f.pipelineMode}`);
  if (!f.stages || typeof f.stages !== 'object') problems.push('missing stages map');
  else {
    for (const s of STAGES) {
      const st = f.stages[s.key];
      if (!st) { problems.push(`stages.${s.key} missing`); continue; }
      if (!Object.values(STATUS).includes(st.status)) problems.push(`stages.${s.key}.status "${st.status}" is not a known status`);
      if (st.status === STATUS.DONE && !st.output) problems.push(`stages.${s.key} claims done with no output`);
      // an approval gate is a real barrier in the record, not just a UI step: nothing downstream of
      // gate 1 can be marked done while that gate is undecided
      if (s.kind !== KIND.APPROVAL && st.status === STATUS.DONE) {
        const gatesBefore = STAGES.slice(0, stageIndex(s.key)).filter((x) => x.kind === KIND.APPROVAL);
        for (const g of gatesBefore) {
          const gs = f.stages[g.key];
          if (gs && gs.approval !== 'approve') problems.push(`stages.${s.key} is not allowed to be done before ${g.role} (${g.key}) approves`);
        }
      }
      if (st.status === STATUS.FAILED && !st.error) problems.push(`stages.${s.key} claims failed with no error kept`);
    }
    for (const key of Object.keys(f.stages)) if (!isStageKey(key)) problems.push(`stages.${key} is not a pipeline stage`);
  }
  if (!Array.isArray(f.history)) problems.push('missing history');
  if (!Array.isArray(f.decisions)) problems.push('missing decisions');
  return problems;
}

/** The one write path every stage uses, so "in progress" and "done" cannot be set separately. */
export function startStage(f, key, { actor, note }) {
  const def = stageDef(key);
  if (!def) throw new Error(`unknown stage ${key}`);
  const st = f.stages[key];
  if (st.status === STATUS.DONE) throw new Error(`${def.role} already finished this stage`);
  if (st.status === STATUS.RUNNING) throw new Error(`${def.role} is already running this stage`);
  st.status = STATUS.RUNNING;
  st.startedAt = new Date().toISOString();
  st.attempts += 1;
  st.actor = def.role;
  st.error = null;
  pushHistory(f, { at: st.startedAt, actor: def.role, kind: 'started', stage: key, text: note ?? startNote(def) });
  return st;
}

const startNote = (def) => (def.kind === KIND.APPROVAL ? 'Waiting for your decision.' : `${def.role} picked up this stage.`);

export function finishStage(f, key, output, { sample, note } = {}) {
  const def = stageDef(key);
  const st = f.stages[key];
  if (!output || (typeof output === 'object' && Object.keys(output).length === 0)) {
    return failStage(f, key, new Error(`${def.role} returned nothing to store`));
  }
  st.status = STATUS.DONE;
  st.output = output;
  st.finishedAt = new Date().toISOString();
  st.sample = sample === true;
  st.note = note ?? null;
  pushHistory(f, { at: st.finishedAt, actor: def.role, kind: 'completed', stage: key, sample: st.sample, text: finishNote(def, output) });
  return st;
}

function finishNote(def, output) {
  if (def.kind === KIND.RETRIEVAL) {
    const n = Array.isArray(output?.sources) ? output.sources.length : 0;
    return `Filed ${n} source${n === 1 ? '' : 's'} and wrote up what they suggest.`;
  }
  if (Array.isArray(output?.items) && output.items.length > 1) return `Proposed ${output.items.length} options.`;
  return 'Filed its output into the film brief.';
}

export function failStage(f, key, err) {
  const def = stageDef(key);
  const st = f.stages[key];
  st.status = STATUS.FAILED;
  st.error = String(err?.message ?? err).slice(0, 600);
  st.errorKind = err?.kind ?? 'stage_failed';
  st.failedAt = new Date().toISOString();
  pushHistory(f, { at: st.failedAt, actor: def.role, kind: 'failed', stage: key, text: `${def.role} failed: ${st.error}`, errorKind: st.errorKind });
  return st;
}

/** A gate or a critique sending work back: downstream output is voided, not silently kept. */
export function sendBack(f, fromKey, toKey, notes, actorLabel) {
  if (!isStageKey(toKey)) throw new Error(`send-back target ${toKey} is not a pipeline stage`);
  const from = stageDef(fromKey);
  if (from && from.kind !== KIND.APPROVAL && !from.canSendBackTo.includes(toKey)) {
    throw new Error(`${from.role} is not allowed to send work back to ${stageDef(toKey).role}`);
  }
  const target = f.stages[toKey];
  const downstream = STAGES.slice(stageIndex(toKey));
  for (const s of downstream) {
    const st = f.stages[s.key];
    if (st.status === STATUS.DONE || st.status === STATUS.NEEDS_APPROVAL || st.status === STATUS.RUNNING) {
      st.previousOutputSaved = st.output ?? null;
      st.voidedBy = toKey;
      st.output = null;
      st.approval = null;
    }
    if (s.key !== toKey) st.status = STATUS.WAITING;
  }
  target.status = STATUS.SENT_BACK;
  target.notes = String(notes ?? '').slice(0, 4000);
  target.sentBackAt = new Date().toISOString();
  pushHistory(f, {
    at: target.sentBackAt, actor: actorLabel ?? from?.role ?? 'Creative director', kind: 'sent_back', stage: toKey,
    from: fromKey ?? toKey, text: `${actorLabel ?? from?.role ?? 'Creative director'} sent this stage back to ${stageDef(toKey).role}.`, notes: target.notes,
  });
  return target;
}

export function recordDecision(f, { gate, decision, notes, actor = 'You' }) {
  const rec = { at: new Date().toISOString(), gate, decision, notes: notes ? String(notes).slice(0, 4000) : null, actor };
  f.decisions.push(rec);
  pushHistory(f, { ...rec, kind: 'decision', text: `${actor} ${decision === 'approve' ? 'approved' : 'rejected'} at this gate.${notes ? ' ' + notes : ''}` });
  return rec;
}


export function touch(f) {
  f.updatedAt = new Date().toISOString();
  f.version += 1;
  return f;
}
