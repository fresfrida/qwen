// Stage work for the film pipeline. Two rules decide everything here:
//   - with no backend for a stage, the stage writes clearly labelled SAMPLE output and says which
//     backend is missing. It never guesses, and it never leaves the field blank and marked done;
//   - with a backend, the stage gets one request built from the shared brief. Roles are stages over
//     one record, not seven services re-deriving the same context.

import { ENTRY, KIND, stageDef } from './stages.js';
import { faceDirection, summaryLine } from './layers.js';
import { DATA_MARKER, fenceData, verifyFences } from '../model/pipeline.js';
import { LIMITS } from './brief.js';

/**
 * A stage could not produce real work. Thrown rather than returned, so the runner records a failure
 * with this reason instead of quietly writing a sample and calling it done.
 */
/**
 * A stage could not produce real work. Thrown rather than returned, so the runner records a failure
 * with this reason instead of quietly writing a sample and calling it done.
 * The message always carries the reason: "provider says slow down" on its own tells you nothing
 * about which backend said it.
 */
export class BackendUnavailable extends Error {
  constructor(message, reason = 'backend_unavailable') {
    const text = message && message.toLowerCase().includes(reason) ? message : `${reason}: ${message}`;
    super(text);
    this.name = 'BackendUnavailable';
    this.kind = reason;
  }
}
export const SAMPLE = 'SAMPLE — no generation backend connected';

export function capabilitiesSummary(caps) {
  const parts = [
    `text=${caps.text ? caps.text.kind + (caps.text.model ? ` (${caps.text.model})` : '') : 'none'}`,
    `retrieval=${caps.retrieval ? caps.retrieval.kind : 'none'}`,
    `media=${Object.entries(caps.media).map(([k, v]) => `${k}:${v ? 'configured' : 'none'}`).join(' ')}`,
  ];
  return {
    pipelineMode: caps.pipelineMode,
    parts,
    // where an endpoint exists but no client does, say so: it is the difference between
    // "nothing configured" and "configured, and this build refused to guess the API"
    endpointsWithoutClients: Object.entries(caps.mediaEndpoints ?? {}).filter(([k, v]) => v && !caps.media[k]).map(([k]) => k),
  };
}

/** `real` only when at least one stage could actually be generated; otherwise `demo`. */
export function resolveCapabilities({ model, retriever, endpoints = {}, clients = {}, enabled = true, maxOutputTokens = 1200 }) {
  const textReady = enabled && model && model.name !== 'none' && typeof model.complete === 'function' && model.configured();
  const caps = {
    text: textReady ? { kind: model.name, model: model.modelId ?? null, maxOutputTokens } : null,
    retrieval: enabled && retriever?.configured?.() ? { kind: retriever.name } : null,
    // a capability counts only when there is both an endpoint AND a client for it
    media: Object.fromEntries(['images', 'video', 'voice', 'music'].map((k) => [k, Boolean(endpoints[k] && clients[k])])),
    mediaEndpoints: Object.fromEntries(['images', 'video', 'voice', 'music'].map((k) => [k, Boolean(endpoints[k])])),
  };
  caps.mediaReady = Object.values(caps.media).some(Boolean);
  const anythingReal = caps.text || caps.retrieval || caps.mediaReady || Object.values(caps.mediaEndpoints).some(Boolean);
  caps.pipelineMode = anythingReal ? 'real' : 'demo';
  return caps;
}

/**
 * One block of brief context, reused by every text stage. Without this the pipeline would ask a
 * model to re-derive the same facts once per role, which costs more and drifts.
 */
export function briefDigest(film) {
  const b = film.brief ?? {};
  const chosen = film.chosenConcept?.workingTitle ?? null;
  const lines = [
    `entry mode: ${film.entryMode === ENTRY.IDEAS ? 'bring me ideas' : 'develop my idea'}`,
    `working title: ${b.title || 'not set'}`,
    `premise: ${b.premise || 'not set'}`,
    `target length: ${b.targetLength || 'not set'}`,
    `owner notes: ${b.notes || 'none'}`,
    `links to include: ${(b.links ?? []).join(' ') || 'none'}`,
  ];
  // the four layers are part of the shared brief, so every stage that needs direction reads them
  // from here rather than each role re-deriving them from the notes
  if (b.layers) {
    lines.push(`direction (look / genre / format / sound): ${summaryLine(film)}`);
    const face = faceDirection(film);
    if (face.mode === 'avoid') lines.push('face direction: no visible faces - silhouettes, backs of heads, hands, objects and places only');
    else if (face.mode === 'unclear') lines.push(`face direction: unclear (${face.note}) - do not settle it yourself`);
  }
  if (chosen) lines.push(`approved concept: ${chosen}`);
  if (film.research) lines.push(`research summary: ${Array.isArray(film.research.audienceInterests) ? film.research.audienceInterests.slice(0, 4).join('; ') : 'filed'}`);
  if (film.script) lines.push(`script exists: yes, ${film.script.scenes?.length ?? 0} scenes`);
  return lines.join('\n');
}

async function callOnce({ key, film, caps, prompts, model, signal, extra = [] }) {
  // Same fence the enquiry pipeline uses: one implementation, so a studio brief cannot be
  // contained more loosely than a visitor's enquiry text.
  const rendered = await prompts.render(`studio-${key}`, {});
  const data = [{ label: 'film brief', value: briefDigest(film) }, ...extra];
  const blocks = data.map((d) => fenceData(d.label, d.value));
  const prompt = [rendered.prompt, DATA_MARKER, blocks.map((b) => b.fenced).join('\n\n')].join('\n\n');
  const contained = verifyFences(prompt, blocks.map((b) => b.token));
  if (!contained.ok) throw new BackendUnavailable(`the brief for ${stageDef(key).role} could not be contained safely: ${contained.problems.join('; ')}`, 'fence_unverifiable');
  if (Buffer.byteLength(prompt) > (caps.maxPromptBytes ?? 64 * 1024)) {
    throw new BackendUnavailable(`the prompt for ${stageDef(key).role} is ${Buffer.byteLength(prompt)} bytes, over the ${caps.maxPromptBytes} limit. Trim the brief; do not raise the limit to make a call fit.`, 'prompt_too_large');
  }
  const answer = await model.complete({ prompt, stage: `studio-${key}`, signal, maxOutputTokens: caps.text.maxOutputTokens });
  if (answer?.ran !== true) throw new BackendUnavailable(answer?.detail ?? answer?.reason ?? 'the text backend refused or failed', answer?.reason ?? 'backend_failed');
  if (answer.simulated === true) {
    // an offline test provider is not a generation backend: keep the sample, do not launder it
    return { sample: true, output: null, provider: answer.provider };
  }
  // limits travel with the prompt, so what the model was told and what we accept are the same numbers
  return { sample: false, text: answer.text ?? '', provider: answer.provider, promptFile: rendered.file, limits: rendered.limits };
}

/** One text stage: ask, parse, shape. A parse failure is a stage failure, never a silent sample. */
export async function runTextStage({ key, film, caps, prompts, model, signal, extra }) {
  const called = await callOnce({ key, film, caps, prompts, model, signal, extra });
  if (called.sample) {
    // a simulated provider is not a generation backend: keep the labelled sample, and say who sent it
    return { output: { ...sampleForStage(key, film), viaProvider: called.provider }, sample: true };
  }
  let parsed;
  try { parsed = JSON.parse(called.text.trim().replace(/^```(?:json)?\s*\n?|\n?```$/g, '')); }
  catch (e) { throw new BackendUnavailable(`${stageDef(key).role} answered with something that is not JSON: ${String(e.message).slice(0, 120)}`, 'unreadable_output'); }
  const shaped = shapeRealOutput(key, parsed, film, called.limits);
  return {
    output: { ...shaped, generated: { backend: `${called.provider}${caps.text.model ? ` / ${caps.text.model}` : ''}`, prompt: called.promptFile, limits: called.limits, at: new Date().toISOString() } },
    sample: false,
  };
}

export async function runResearchStage({ film, caps, retriever, signal }) {
  if (!caps.retrieval || !retriever) throw new BackendUnavailable('no retrieval backend is configured, so nothing could be gathered', 'no_retrieval');
  const found = await retriever.retrieve({ query: briefDigest(film), signal });
  if (!found?.ran) throw new BackendUnavailable(found?.detail ?? 'the retrieval backend did not answer', found?.reason ?? 'retrieval_failed');
  const sources = (found.sources ?? []).filter((s) => /^https?:\/\//i.test(String(s?.url ?? ''))).slice(0, LIMITS.linksMax);
  if (!sources.length) throw new BackendUnavailable('the retrieval backend answered with no usable sources, so this stage has nothing to file', 'no_sources');
  return {
    output: {
      audienceInterests: listOrNull(found.audienceInterests), trends: listOrNull(found.trends), references: listOrNull(found.references),
      sources: sources.map((x) => ({ url: String(x.url).slice(0, LIMITS.linkMax), note: String(x.note ?? '').slice(0, 300), retrievedAt: x.retrievedAt ?? found.retrievedAt ?? null })),
      note: 'Gathered by the configured retrieval backend. Sources are listed rather than summarised, so a person can check them.',
      generated: { backend: caps.retrieval.kind, at: new Date().toISOString() },
    },
    sample: false,
  };
}

const listOrNull = (v) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 400)) : []);

/** Media stages need a client per capability; endpoints with no client fail loudly, per user rule. */
export async function runMediaStage({ key, film, caps, tools, signal }) {
  // voice and music are recorded as missing, not called: no client exists for them in this build
  const need = { storyboard: ['images'], assets: ['video'], edit: ['video'] }[key] ?? [];
  for (const kind of need) {
    if (!caps.media?.[kind]) throw new BackendUnavailable(`no ${kind} backend is configured for ${stageDef(key).role}`, 'no_backend');
    if (!tools?.[kind]) {
      throw new BackendUnavailable(`a ${kind} endpoint is configured but there is no client for it, and this build will not guess an API shape`, 'no_client');
    }
  }
  const out = { perKind: {} };
  for (const kind of need) {
    const r = await tools[kind].generate({ brief: briefDigest(film), stage: key, signal });
    if (r?.ran !== true) throw new BackendUnavailable(r?.detail ?? `${kind} generation failed`, r?.reason ?? 'generation_failed');
    out.perKind[kind] = r;
  }
  return {
    output: { ...shapeMediaOutput(key, out, film), generated: { backend: need.join('+'), at: new Date().toISOString() } },
    sample: false,
  };
}

// ---------------------------------------------------------------- labelled samples

const conceptShapes = (film) => {
  const seed = film.entryMode === ENTRY.PREMISE ? film.brief.premise || film.brief.title : '';
  const shapes = [
    { angle: 'one object, one continuous take', mood: 'close and quiet' },
    { angle: 'a promise made in one place, kept in another', mood: 'warm, a little dry' },
    { angle: 'the final minute of something nobody filmed', mood: 'spare and tense' },
  ];
  return shapes.map((s, i) => ({
    ref: `c${i + 1}`,
    workingTitle: `${SAMPLE}: concept ${i + 1}${seed ? ` for ${trim(seed, 34)}` : ''}`,
    oneSentenceStory: `${SAMPLE}: a short built on ${s.angle}.`,
    whyItCouldWork: `${SAMPLE}: a visual turn in the middle means the film survives a muted vertical watch — this is a shape, not a recommendation.`,
    mood: s.mood,
    sources: [],
  }));
};

export function sampleForStage(key, film) {
  const chosenRef = film.chosenConcept?.ref ?? 'c1';
  switch (key) {
    case 'research':
      return {
        marker: SAMPLE, audienceInterests: [], trends: [], references: [], sources: [],
        note: `${SAMPLE}: nothing was gathered, so nothing is cited. Fill this by configuring a retrieval backend; do not accept invented sources here.`,
      };
    case 'concept': {
      const items = film.entryMode === ENTRY.PREMISE ? [conceptShapes(film)[0]] : conceptShapes(film);
      return { marker: SAMPLE, items, note: `${SAMPLE}: structural slots so the choice and the gates can be exercised. No generation backend was called, so these are not proposals.` };
    }
    case 'script':
      return {
        marker: SAMPLE, conceptRef: chosenRef, targetLength: film.brief.targetLength || 'unspecified',
        hook: `${SAMPLE}: an opening line that puts the subject on screen within two seconds.`,
        scenes: [
          { n: 1, action: `${SAMPLE}: establish the single visual idea.`, dialogue: '' },
          { n: 2, action: `${SAMPLE}: turn it, using the approved mood.`, dialogue: `${SAMPLE}: one line if the film needs one.` },
          { n: 3, action: `${SAMPLE}: end on an image rather than an explanation.`, dialogue: '' },
        ],
        ending: `${SAMPLE}: the last shot carries the title.`,
        note: `${SAMPLE}: a shape to route through the pipeline, not a draft to produce.`,
      };
    case 'storyboard':
      return {
        marker: SAMPLE, look: `${SAMPLE}: one treatment stated once and reused, so the film does not change skin between shots.`,
        characters: [{ name: `${SAMPLE}: subject`, design: 'one colour rule, one light rule, held everywhere' }],
        settings: [{ name: `${SAMPLE}: single location`, design: 'one location, restrained palette' }],
        shots: (film.script?.scenes ?? [{ n: 1 }, { n: 2 }, { n: 3 }]).map((s) => ({ scene: s.n, sketch: `${SAMPLE}: shot sketch for beat ${s.n}`, framing: 'vertical 9:16' })),
        titleCards: [{ at: 'end', text: `${SAMPLE}: title card copy` }],
        cover: { text: `${SAMPLE}: cover frame`, ratio: '9:16' },
        needs: 'image generation backend',
      };
    case 'assets':
      return {
        marker: SAMPLE,
        footage: [{ id: 'f1', produced: false, reason: `${SAMPLE}: no video backend configured` }],
        voice: [{ id: 'v1', produced: false, reason: `${SAMPLE}: no voice backend configured` }],
        music: [{ id: 'm1', produced: false, reason: `${SAMPLE}: no music backend configured` }],
        note: 'This is the stage where a real tool would be called. With none configured it records what is missing instead of inventing a file.',
      };
    case 'edit':
      return {
        marker: SAMPLE, assembly: `${SAMPLE}: an edit plan from the script beats, with no rendered media to place.`,
        pacing: `${SAMPLE}: two beats shorter, one held longer.`, captions: [{ at: '00:00', text: `${SAMPLE}: caption line` }],
        sound: `${SAMPLE}: one bed, one dip under the final line.`, continuity: `${SAMPLE}: nothing to check against, because no footage exists.`,
        renderStatus: 'not rendered — no media backend', needs: 'video editing or render backend',
      };
    case 'critique':
      return {
        marker: SAMPLE, verdict: 'pass', strengths: [`${SAMPLE}: one brief moved through every role without being lost.`],
        problems: [`${SAMPLE}: with no real assets this is a shape, not a film.`], sendBackTo: null,
        notes: `${SAMPLE}: the send-back route is wired and shown in the demo film; this text is a placeholder, not a director's judgement.`,
      };
    case 'marketing':
      return {
        marker: SAMPLE, title: `${SAMPLE}: title slot`, caption: `${SAMPLE}: caption slot`,
        releasePlan: [{ at: 'day 0', action: `${SAMPLE}: a single vertical release. No posting happens from this build.` }],
        resultsCollection: { status: 'no source configured', note: 'Results need an approved analytics or platform source. None is configured, so no numbers exist here and none are invented.' },
      };
    default:
      throw new Error(`no work defined for stage ${key}`);
  }
}

/**
 * Limits come from the prompt file that produced this answer. A value over its declared limit is a
 * rejection, not something to truncate: cutting a model's sentence to fit a field would quietly
 * change what it said, and the owner would read the shortened version as the answer.
 */
export function shapeRealOutput(key, parsed, film, limits = {}) {
  if (!limits || Object.keys(limits).length === 0) throw new BackendUnavailable(`no limits arrived from the ${key} prompt file`, 'prompt_limits_missing');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BackendUnavailable(`${stageDef(key).role} did not return an object`, 'unreadable_output');
  switch (key) {
    case 'concept': {
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      if (!items.length) throw new BackendUnavailable('the concept stage returned no items', 'empty_output');
      if (items.length > limits.maxConcepts) throw new BackendUnavailable(`the backend returned ${items.length} concepts; the prompt allows ${limits.maxConcepts}`, 'wrong_shape');
      if (film.entryMode === ENTRY.IDEAS && items.length !== limits.maxConcepts) {
        throw new BackendUnavailable(`"bring me ideas" needs exactly ${limits.maxConcepts} concepts; the backend returned ${items.length}`, 'wrong_shape');
      }
      if (film.entryMode === ENTRY.PREMISE && items.length !== 1) {
        throw new BackendUnavailable(`the owner's own premise should come back as one concept to approve, not ${items.length}`, 'wrong_shape');
      }
      const out = items.map((c, i) => {
        const title = need(c?.workingTitle, 'workingTitle', limits.conceptTitleMax, key);
        const story = need(c?.oneSentenceStory, 'oneSentenceStory', limits.storyMax, key);
        return {
          ref: String(c?.ref ?? `c${i + 1}`), workingTitle: title, oneSentenceStory: story,
          whyItCouldWork: need(c?.whyItCouldWork, 'whyItCouldWork', 1000, key), mood: str(c?.mood, 300),
          sources: (Array.isArray(c?.sources) ? c.sources : []).map((u) => linkOrThrow(u, i, key)),
        };
      });
      return { items: out, flagged: list(parsed.flagged_requests), blocked: list(parsed.blocked) };
    }
    case 'script': {
      if (!str(parsed.hook).trim()) throw new BackendUnavailable('the script stage returned no opening hook', 'wrong_shape');
      if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) throw new BackendUnavailable('the script stage returned no scenes', 'wrong_shape');
      if (!str(parsed.ending).trim()) throw new BackendUnavailable('the script stage returned no ending', 'wrong_shape');
      return {
        hook: str(parsed.hook, 1200), ending: str(parsed.ending, 1200), conceptRef: film.chosenConcept?.ref ?? null,
        targetLength: film.brief.targetLength || null,
        scenes: parsed.scenes.map((s, i) => ({ n: Number(s?.n) || i + 1, action: str(s?.action, 1200), dialogue: str(s?.dialogue, 800) })),
      };
    }
    case 'critique': {
      const verdict = parsed.verdict === 'send_back' ? 'send_back' : parsed.verdict === 'pass' ? 'pass' : null;
      if (!verdict) throw new BackendUnavailable('the review pass must answer pass or send_back', 'wrong_shape');
      const target = verdict === 'send_back' ? String(parsed.sendBackTo ?? '') : null;
      if (verdict === 'send_back') {
        const def = stageDef(target);
        if (!def || !stageDef('critique').canSendBackTo.includes(target)) throw new BackendUnavailable(`the review named ${JSON.stringify(target)}, which it cannot send work back to`, 'wrong_shape');
        if (!str(parsed.notes).trim()) throw new BackendUnavailable('a send-back must carry notes for the stage it names', 'wrong_shape');
      }
      return { verdict, strengths: list(parsed.strengths), problems: list(parsed.problems), sendBackTo: target, notes: str(parsed.notes, 4000) };
    }
    case 'marketing': {
      if (!str(parsed.title).trim() || !str(parsed.caption).trim()) throw new BackendUnavailable('the marketer returned no title or caption', 'wrong_shape');
      return {
        title: str(parsed.title, 200), caption: str(parsed.caption, 2000),
        releasePlan: list(parsed.releasePlan),
        resultsCollection: { status: 'no source configured', note: 'Suggestions only. No posting and no metrics: results need an approved source.' },
      };
    }
    default:
      throw new Error(`no output shape for stage ${key}`);
  }
}

export function shapeMediaOutput(key, raw, film) {
  const refs = Object.entries(raw.perKind).map(([kind, r]) => ({ kind, ref: String(r.ref ?? ''), at: r.at ?? null }));
  if (refs.some((r) => !r.ref)) throw new BackendUnavailable('a media backend returned work without a reference to store', 'wrong_shape');
  if (key === 'storyboard') return { look: 'per the approved concept', shots: refs, boards: refs, cover: refs[0]?.ref ?? null, needs: null };
  if (key === 'assets') return { footage: refs.filter((r) => r.kind === 'video'), voice: refs.filter((r) => r.kind === 'voice'), music: refs.filter((r) => r.kind === 'music'), note: 'Produced by the configured tools.' };
  return { assembly: refs.find((r) => r.kind === 'video')?.ref ?? null, renderStatus: 'rendered by the configured backend', captions: [], sound: [], pacing: [], continuity: [] };
}

const str = (v, max = 2000) => {
  const t = String(v ?? '').trim();
  if (t.length > max) throw new BackendUnavailable(`a ${max}-character limit was exceeded by ${t.length} characters`, 'wrong_shape');
  return t;
};
const need = (v, field, max, key) => {
  const t = String(v ?? '').trim();
  if (!t) throw new BackendUnavailable(`${stageDef(key).role} left ${field} empty`, 'wrong_shape');
  return str(t, max);
};
const linkOrThrow = (u, i, key) => {
  const t = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(t)) throw new BackendUnavailable(`concept ${i + 1} cites ${JSON.stringify(t.slice(0, 60))}, which is not an http(s) source URL`, 'wrong_shape');
  return str(t, 2048);
};
const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.slice(0, 400) : String(x?.action ?? x?.note ?? JSON.stringify(x)).slice(0, 400))) : []);
const trim = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
