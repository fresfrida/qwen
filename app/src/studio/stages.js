// One list, one vocabulary. The runner, the store, the cards, the detail view and the tests all
// read their stage names, role labels and status meanings from here, so a label cannot say one
// thing in the grid and another in the detail panel.

export const STATUS = Object.freeze({
  WAITING: 'waiting',
  RUNNING: 'in_progress',
  DONE: 'done',
  SENT_BACK: 'sent_back',
  NEEDS_APPROVAL: 'needs_my_approval',
  FAILED: 'failed',
});

export const STATUS_LABEL = Object.freeze({
  [STATUS.WAITING]: 'waiting',
  [STATUS.RUNNING]: 'in progress',
  [STATUS.DONE]: 'done',
  [STATUS.SENT_BACK]: 'sent back',
  [STATUS.NEEDS_APPROVAL]: 'needs my approval',
  [STATUS.FAILED]: 'failed',
});

/**
 * One tone vocabulary for the whole product. A stage's status and a film's summary pick their CSS
 * class from here, so the card colour, the label and the poll payload cannot drift apart.
 */
export const STATUS_TONE = Object.freeze({
  [STATUS.WAITING]: 'waiting',
  [STATUS.RUNNING]: 'running',
  [STATUS.DONE]: 'done',
  [STATUS.SENT_BACK]: 'sentback',
  [STATUS.NEEDS_APPROVAL]: 'ask',
  [STATUS.FAILED]: 'failed',
});

export const toneFor = (status) => STATUS_TONE[status] ?? 'waiting';

export const ENTRY = Object.freeze({ IDEAS: 'bring_me_ideas', PREMISE: 'develop_my_idea' });

export const KIND = Object.freeze({
  RETRIEVAL: 'retrieval',   // needs a real source-gathering tool
  MODEL: 'model',           // needs a configured text generation backend
  MEDIA: 'media',           // needs configured footage / voice / music tools
  APPROVAL: 'approval',     // a human decision, never a backend
});

/**
 * @typedef {Object} StageDef
 * @property {string} key      stable id stored in the film record
 * @property {string} role     who is doing this work, as it appears on screen
 * @property {string} job      one line on what they produce
 * @property {string} kind     which capability it needs, see KIND
 * @property {boolean} first   entry point of the pipeline
 * @property {string|null} gateFor  the stage key this approval gate unlocks
 * @property {string[]} canSendBackTo   stages a critique may return work to
 */

/** @type {readonly StageDef[]} */
export const STAGES = Object.freeze([
  {
    key: 'research', role: 'Researcher', kind: KIND.RETRIEVAL, first: true, gateFor: null, canSendBackTo: [],
    job: 'Gathers audience interests, trends and story references for this brief, keeping the sources it used. Inspiration, not copying.',
  },
  {
    key: 'concept', role: 'Creative director', kind: KIND.MODEL, first: false, gateFor: null, canSendBackTo: [],
    job: 'Proposes the story angle, mood and visual direction, and writes the concept proposal you choose from.',
  },
  {
    key: 'gate_concept', role: 'You — approval gate 1', kind: KIND.APPROVAL, first: false, gateFor: 'concept', canSendBackTo: ['research', 'concept'],
    job: 'Nothing is written or designed until you approve a concept here.',
  },
  {
    key: 'script', role: 'Scriptwriter', kind: KIND.MODEL, first: false, gateFor: null, canSendBackTo: [],
    job: 'Writes the opening hook, scenes, dialogue and ending from the approved concept.',
  },
  {
    key: 'storyboard', role: 'Graphic designer / storyboard artist', kind: KIND.MEDIA, first: false, gateFor: null, canSendBackTo: [],
    job: 'Designs characters, settings, shot sketches, title cards and the cover, in one consistent look.',
  },
  {
    key: 'assets', role: 'Digital content creator / producer', kind: KIND.MEDIA, first: false, gateFor: null, canSendBackTo: [],
    job: 'Turns the script and boards into the actual assets — footage, voice, music — using the tools that are really configured.',
  },
  {
    key: 'edit', role: 'Editor', kind: KIND.MEDIA, first: false, gateFor: null, canSendBackTo: [],
    job: 'Assembles the short and fixes pacing, captions, sound and continuity.',
  },
  {
    key: 'critique', role: 'Creative director — review pass', kind: KIND.MODEL, first: false, gateFor: null, canSendBackTo: ['research', 'concept', 'script', 'storyboard', 'assets', 'edit'],
    job: 'A separate critique of the assembled film. It can send work back to a named stage with notes, and the film does not move forward until it passes.',
  },
  {
    key: 'gate_release', role: 'You — approval gate 2', kind: KIND.APPROVAL, first: false, gateFor: 'edit', canSendBackTo: ['critique', 'edit', 'assets', 'script'],
    job: 'You approve the finished film for release. Nothing publishes itself, and approving here publishes nothing.',
  },
  {
    key: 'marketing', role: 'Digital marketer', kind: KIND.MODEL, first: false, gateFor: null, canSendBackTo: [],
    job: 'After release approval, prepares title, caption and release-plan suggestions, and later collects results to inform the next brief.',
  },
]);

export const stageDef = (key) => STAGES.find((s) => s.key === key) ?? null;
export const stageAt = (i) => STAGES[i] ?? null;
export const stageIndex = (key) => STAGES.findIndex((s) => s.key === key);
export const isStageKey = (key) => stageDef(key) !== null;

/** Stages run in this order; gates are decisions, not work. */
export const NEXT_AFTER = Object.freeze(
  STAGES.reduce((acc, s, i) => {
    const nxt = STAGES[i + 1];
    if (nxt) acc[s.key] = nxt.key;
    return acc;
  }, {}),
);

export function nextStageKey(film) {
  for (const s of STAGES) {
    const st = film.stages[s.key];
    if (!st || st.status === STATUS.WAITING) return s.key;
    if (st.status === STATUS.SENT_BACK) return s.key;                 // rework happens where it was returned
    if (st.status === STATUS.NEEDS_APPROVAL) return null;             // waiting on you
    if (st.status === STATUS.RUNNING) return null;                    // already going
    if (st.status === STATUS.FAILED) return null;                     // never retried silently
  }
  return null;
}

export const gateUnlockedBy = (film, gateKey) => {
  const def = stageDef(gateKey);
  if (!def?.gateFor) return true;
  const produced = film.stages[def.gateFor];
  return Boolean(produced?.status === STATUS.DONE && produced?.approval);
};

export const filmStatus = (film) => {
  const running = STAGES.find((s) => film.stages[s.key]?.status === STATUS.RUNNING);
  if (running) return { label: `in progress — ${running.role}`, tone: 'running', stage: running.key };
  const approval = STAGES.find((s) => film.stages[s.key]?.status === STATUS.NEEDS_APPROVAL);
  if (approval) return { label: `waiting on you — ${approval.role.replace('You — ', '')}`, tone: 'ask', stage: approval.key };
  const sent = STAGES.find((s) => film.stages[s.key]?.status === STATUS.SENT_BACK);
  if (sent) return { label: `sent back to ${sent.role}`, tone: 'sentback', stage: sent.key };
  const failed = STAGES.find((s) => film.stages[s.key]?.status === STATUS.FAILED);
  if (failed) return { label: `failed at ${failed.role}`, tone: 'failed', stage: failed.key };
  const next = STAGES.find((s) => !film.stages[s.key] || film.stages[s.key].status === STATUS.WAITING);
  if (next) return { label: `ready to run — ${next.role}`, tone: 'ready', stage: next.key };
  if (film.stages.marketing?.status === STATUS.DONE) return { label: 'complete', tone: 'finish', stage: 'marketing' };
  return { label: 'no stage is waiting', tone: 'idle', stage: null };
};
