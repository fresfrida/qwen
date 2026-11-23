// Layer logic: parse a posted form into typed values, read them back as labels, decide the face
// direction from what the owner wrote, and work out what a change makes stale.
//
// The vocabulary itself is data in lexicon.js, so adding a format or renaming a sound never means
// hunting through the validator, the reset rule, the summary line and four views.
//
// Values are typed: a layer is always {value, other}. A value outside the vocabulary is refused with
// the field named - it is never defaulted, because a silently replaced style changes the whole film.

import { KIND, STAGES, stageDef, stageIndex } from './stages.js';
import { FORMATS, GENRES, OTHER, SOUNDS, STUDIO_SUGGESTS, STYLE_GROUPS, findOption, isValidLayerValue } from './lexicon.js';
import { pushHistory } from './history.js';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const MAX_OTHER_CHARS = 500;
export const MAX_GENRES = 8;

const SUGGEST_LABEL = 'Let the studio suggest';
const OTHER_LABEL = 'Other';

const one = (v) => (Array.isArray(v) ? v[0] : v);
const many = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean));

const styleGroups = () => STYLE_GROUPS.map((g) => ({ group: g.group, options: g.options.map((o) => ({ ...o, kind: 'style' })) }));
const flat = (kind) => kind === 'style'
  ? styleGroups().flatMap((g) => g.options)
  : (kind === 'genre' ? GENRES : kind === 'format' ? FORMATS : SOUNDS).map((o) => ({ ...o, kind }));

/** The vocabulary of one layer, including the two non-committal options. Used by the form and the help. */
export function layerChoices(kind) {
  if (kind === 'style') return [...styleGroups(), { group: null, options: [{ value: STUDIO_SUGGESTS, label: SUGGEST_LABEL, kind }, { value: OTHER, label: OTHER_LABEL, kind }] }];
  return { group: null, options: [...flat(kind), { value: STUDIO_SUGGESTS, label: SUGGEST_LABEL, kind }, { value: OTHER, label: OTHER_LABEL, kind }] };
}

export const isLayerValue = (kind, value) => value === STUDIO_SUGGESTS || value === OTHER || isValidLayerValue(kind, value);

/**
 * A value that was refused is echoed back so the form can show what you sent - but it is never
 * spoken about as if it were the direction. "not accepted" keeps the label free for the field error.
 */
export function layerLabelSafe(choice, kind) {
  if (choice?.rejected) return 'not accepted';
  return layerLabel(kind, choice?.value, choice?.other);
}

export function layerLabel(kind, value, other = '') {
  if (value === OTHER) return other ? `Other: ${clip(other, 90)}` : `${OTHER_LABEL} (no text given)`;
  if (value === STUDIO_SUGGESTS) return SUGGEST_LABEL;   // print the option's own words, not a paraphrase
  return findOption(kind, value)?.label ?? value;
}

const readSingle = (kind, valueField, otherField, fields, errors) => {
  const value = String(one(fields[valueField]) ?? '').trim();
  if (!value) {
    // An absent layer means "the form did not ask", which has a documented answer: the default.
    // This is not a guess about taste - format defaults to a story short film, look and sound to
    // "let the studio suggest". An unrecognised value is a different case and is refused below.
    return defaultLayer(kind);
  }
  if (!isLayerValue(kind, value)) {
    errors[valueField] = `${LAYER_QUESTIONS[kind]} "${clip(value, 60)}" is not a value this studio knows, so nothing was saved.`;
    return null;
  }
  if (value === OTHER) {
    const other = String(one(fields[otherField]) ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!other) { errors[otherField] = `${LAYER_QUESTIONS[kind]} "${OTHER_LABEL}" needs one line describing it.`; return null; }
    if (other.length > MAX_OTHER_CHARS) { errors[otherField] = `${LAYER_QUESTIONS[kind]} "${OTHER_LABEL}" is ${other.length} characters. The limit is ${MAX_OTHER_CHARS}, so keep it to a line - the rest would not be carried into the work.`; return null; }
    return { value: OTHER, other };
  }
  if (String(one(fields[otherField]) ?? '').trim()) {
    errors[otherField] = `${LAYER_QUESTIONS[kind]} You typed a line while ${layerLabel(kind, value)} is selected. Choose "${OTHER_LABEL}" to have your own wording used.`;
    return null;
  }
  return { value, other: '' };
};

/**
 * Parses the four layer fields from a request body. Returns { layers, errors }; when errors is not
 * empty the caller must write nothing, because a half-applied layer set is worse than none.
 */
export function parseLayerFields(fields = {}) {
  const errors = {};
  const style = readSingle('style', 'style', 'otherStyle', fields, errors);
  const format = readSingle('format', 'format', 'otherFormat', fields, errors);
  const sound = readSingle('sound', 'sound', 'otherSound', fields, errors);

  const rawGenres = many(one(fields.genres));
  const genres = [];
  const seen = new Set();
  for (const g of rawGenres) {
    if (seen.has(g)) continue;
    seen.add(g);
    if (!isLayerValue('genre', g)) { errors.genres = `${LAYER_QUESTIONS.genre} "${clip(g, 60)}" is not a value this studio knows, so nothing was saved.`; continue; }
    if (g === OTHER) {
      const other = String(one(fields.otherGenre) ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
      if (!other) { errors.otherGenre = `${LAYER_QUESTIONS.genre} "${OTHER_LABEL}" needs one line describing it.`; continue; }
      if (other.length > MAX_OTHER_CHARS) { errors.otherGenre = `${LAYER_QUESTIONS.genre} "${OTHER_LABEL}" is ${other.length} characters; the limit is ${MAX_OTHER_CHARS}.`; continue; }
      genres.push({ value: OTHER, other });
      continue;
    }
    genres.push({ value: g, other: '' });
  }
  if (genres.length > MAX_GENRES) errors.genres = `${LAYER_QUESTIONS.genre} Keep it to ${MAX_GENRES} or fewer.`;

  const face = String(one(fields.faceDirection) ?? '').trim();
  if (face && !['avoid', 'allow', 'either'].includes(face)) errors.faceDirection = 'The face direction must be "avoid", "allow" or "either".';

  // What is kept when a field is refused: the raw value you sent, marked rejected, so the form can
  // still show "oil_painting_not_real" next to the error instead of falling back to a default and
  // making it look like your choice took effect.
  const kept = (kind, parsed, field) => parsed ?? { value: String(one(fields[field]) ?? '').trim() || defaultLayer(kind).value, other: '', rejected: true };
  const layers = {
    style: kept('style', style, 'style'),
    format: kept('format', format, 'format'),
    sound: kept('sound', sound, 'sound'),
    genres: Object.keys(errors).length && genres.length === 0 ? [] : genres,
    faceDirection: face || 'either',
  };
  return { layers, errors, ok: Object.keys(errors).length === 0 };
}

/** The documented default for one layer, used when the field is absent from a request. */
export function defaultLayer(kind) {
  if (kind === 'format') return { value: defaultFormat().value, other: '' };
  if (kind === 'genre') return [];
  return { value: STUDIO_SUGGESTS, other: '' };
}

export function defaultLayers() {
  return { style: defaultLayer('style'), genres: [], format: defaultLayer('format'), sound: defaultLayer('sound'), faceDirection: 'either' };
}

export const LAYER_QUESTIONS = Object.freeze({
  style: 'Video style',
  genre: 'Genre / mood',
  format: 'Format',
  sound: 'Sound',
});

// ---------------------------------------------------------------- reading a stored record

export const layersOf = (film) => film?.brief?.layers ?? null;

/** Labels for every layer on a record, in the order the form shows them. */
export function layerLabels(film) {
  const l = layersOf(film) ?? {};
  return {
    style: layerLabelSafe(l.style ?? { value: STUDIO_SUGGESTS }, 'style'),
    genres: (l.genres ?? []).map((g) => layerLabelSafe(g, 'genre')),
    format: layerLabelSafe(l.format ?? defaultLayer('format'), 'format'),
    sound: layerLabelSafe(l.sound ?? { value: STUDIO_SUGGESTS }, 'sound'),
  };
}

export const defaultFormat = () => FORMATS.find((f) => f.default) ?? FORMATS[0];

/**
 * The one readable line, built from the same label function every view uses:
 *   "2D anime (hand-drawn look) + fantasy / mythical + Off-camera narrated story + Music + ambience"
 * plus "no visible faces" when that direction is stated. Unpicked layers say so in the option's own
 * words ("Let the studio suggest", "genre not chosen") rather than being left blank or guessed.
 */
/**
 * The four choices, in one line. `faceText` overrides the last clause: a saved film already knows
 * its face direction (it was read from the notes when they were written), while an unsent form does
 * not - and the page must not imply that the browser has read them.
 */
export function summaryLine(film, { faceText } = {}) {
  const l = layerLabels(film);
  const face = faceDirection(film);
  const parts = [l.style, l.genres.length ? l.genres.join(' / ') : 'genre not chosen', l.format, l.sound];
  const avoid = faceText !== undefined ? faceText : (face.mode === 'avoid' ? 'no visible faces' : null);
  if (avoid) parts.push(avoid);
  return parts.filter(Boolean).join(' + ');
}

export function summaryFromLayers(layers = {}, opts = {}) {
  return summaryLine({ brief: { layers } }, opts);
}

/** The clause a saved film carries, or null when it has none. Read-only view for the form layer. */
export const storedFaceLine = (film) => (faceDirection(film).mode === 'avoid' ? 'no visible faces' : null);

// ---------------------------------------------------------------- face direction: read, not guessed

// Exact phrases an owner would write. "faceless" alone is matched because the industry uses it for
// "no creator on camera" - which is NOT the same claim, so it must not trigger the stricter rule.
// A prohibition has to contain a negation. The first version of these rules let an optional
// "not" float loose, so "faces appear" and "no visible faces" both looked like instructions and
// the studio's most common phrasing came out as *no instruction at all*. Same for permission:
// "visible faces" inside "no visible faces" is not permission, and ALLOW is therefore tested
// against text with the prohibitions masked out (below, in faceDirection).
const AVOID = /\bno (?:visible |on[- ]screen )?faces\b|\bwithout (?:any )?faces\b|\bfaces? (?:must |should |will |can |do |could |would |may )?(?:not|never) (?:appear|be shown|be visible|be seen|show)\b|\bfaces? (?:are|is|can) ?(?:not|never) (?:shown|visible|seen)\b|\bfaces? cannot (?:be )?(?:seen|shown|visible)\b|\bsilhouettes? (?:only|only shots)\b|\bbacks of (?:the |their )?heads? only\b|\bonly hands\b|\bfaces? stay hidden\b/i;
const ALLOW = /\b(?:with|showing) faces\b|\bvisible faces\b|\bfaces? (?:are|can be|may be|will be|should be|could be) (?:shown|visible|seen|on camera)\b|\b(?:a |the |their )?faces? (?:appears?|appear|is shown|are shown|can be seen|may be seen)\b|\bcharacters? (?:may|can|will) (?:be seen|have faces|appear)\b|\bfaces? (?:are|can be) allowed\b/i;
// Every prohibition, matched globally so it can be blanked out of the text before permission is
// looked for. Derived from AVOID itself: one list of negations, no chance of them diverging.
const AVOID_G = new RegExp(AVOID.source, 'gi');
// "faceless" on its own is an industry term for having no presenter on camera. That is a different
// claim from "no character may show a face", so it must not decide anything by itself.
const AMBIGUOUS_WORD = /\bfaceless(?:ly)?\b/i;

/**
 * Whether characters may show faces is a direction the owner writes down - there is no toggle for it.
 * Three readings are possible from free text, and the one that is genuinely ambiguous is reported as
 * ambiguous instead of being decided here: "faceless" on its own means no creator on camera, which
 * does not forbid animated characters from having faces, so choosing either way would be a guess.
 */
export function faceDirection(film) {
  const l = layersOf(film) ?? {};
  if (l.faceDirection === 'avoid') return { mode: 'avoid', note: 'You said no visible faces.' };
  if (l.faceDirection === 'allow') return { mode: 'allow', note: 'You said faces are fine.' };
  const text = [film?.brief?.notes, film?.brief?.premise, film?.brief?.idea, l.style?.other, l.format?.other, l.sound?.other,
    ...(l.genres ?? []).map((g) => g.other)].filter(Boolean).join(' \n ');
  if (!text) return { mode: 'either', note: '' };
  const avoid = AVOID.test(text);
  // The permission phrase has to be found *outside* a refusal. Without this mask, "no visible
  // faces" matches ALLOW on the substring "visible faces", the studio calls its most common
  // faceless instruction ambiguous, and the saved brief silently loses the clause.
  const allow = ALLOW.test(text.replace(AVOID_G, ' '));
  if (avoid && !allow) return { mode: 'avoid', note: 'Your notes rule out showing faces.' };
  if (allow && !avoid) return { mode: 'allow', note: 'Your notes allow faces.' };
  if (avoid && allow) return { mode: 'unclear', note: 'Your notes ask for both, so nothing is assumed. Set the face direction on the brief.' };
  if (AMBIGUOUS_WORD.test(text)) return { mode: 'either', note: 'Your notes say "faceless", which here means no presenter on camera. It does not rule out faces on animated characters.' };
  return { mode: 'either', note: '' };
}

export const faceDirectionNote = (film) => faceDirection(film).note;

// ---------------------------------------------------------------- the reset rule

/**
 * Where a layer change starts making work stale.
 *   - the look is carried by everything visual: design / storyboard onward
 *   - genre, format and sound shape the telling: the script and everything after it
 *   - the research and the approved concept are upstream of all four, so they survive a change
 */
export const RESET_START = Object.freeze({ style: 'storyboard', genre: 'script', format: 'script', sound: 'script' });

export function resetPlan(changed = []) {
  const bad = changed.filter((c) => !RESET_START[c]);
  if (bad.length) throw new Error(`no reset rule for layer(s): ${bad.join(', ')}`);
  if (!changed.length) return { changed: [], fromStage: null, stale: [], gates: [] };
  const from = Math.min(...changed.map((c) => stageIndex(RESET_START[c])));
  const stale = STAGES.slice(from).filter((s) => s.kind !== KIND.APPROVAL).map((s) => s.key);
  const gates = STAGES.filter((s) => s.kind === KIND.APPROVAL).map((s) => s.key);
  return { changed: [...changed].sort(), fromStage: STAGES[from].key, stale, gates };
}

/**
 * Applies a layer change to the record. The stages the change reached go back to "sent back" with
 * the reason; their output stops counting. The two approval gates are withdrawn - a release approval
 * on a stale film is the "stale approved final" this rule exists to prevent - and the stages upstream
 * of the change keep their state.
 */
export function applyLayerChange(film, { layers, changed, note, actor = 'You' }) {
  const plan = resetPlan(changed);
  const before = summaryLine(film);
  film.brief.layers = { ...film.brief.layers, ...layers, changedAt: new Date().toISOString(), changedFrom: before };

  for (const key of plan.stale) {
    const st = film.stages[key];
    const def = stageDef(key);
    if (st.status === 'done' && st.output) st.previousOutput = st.output;
    if (['done', 'needs_my_approval'].includes(st.status) || st.output) {
      st.status = 'sent_back';
      st.output = null;
      st.approval = null;
      st.reworkNote = `${note ? `Your note: ${clip(note, 300)}. ` : ''}The direction changed (${layerList(plan.changed)}), so this stage has to be redone before the film can move on.`;
      pushHistory(film, { actor: def.role, kind: 'sent_back', stage: key, text: `${def.role} sent back: the direction changed (${layerList(plan.changed)})`, note: st.reworkNote });
    }
  }
  for (const gate of plan.gates) {
    const st = film.stages[gate];
    if (st.approval || st.status === 'done') {
      st.approval = null;
      st.status = 'waiting';
      st.output = null;
      pushHistory(film, { actor: 'Studio', kind: 'approval_withdrawn', stage: gate, text: `${stageDef(gate).role} withdrawn while the direction is being reworked (${layerList(plan.changed)}). It needs to be given again.` });
    }
  }
  pushHistory(film, { actor, kind: 'layers_changed', stage: plan.fromStage, changed: plan.changed.join(','), note: note ? clip(note, 400) : null,
    text: `You changed the ${layerList(plan.changed)}: ${before}  →  ${summaryLine(film)}` });
  return plan;
}

/**
 * "look, format and sound" - the changed layers named in one clean list, in the order the form
 * shows them, instead of "the format and sound and style".
 */
const LAYER_WORDS = Object.freeze({ style: 'look', genre: 'genre', format: 'format', sound: 'sound' });
const LAYER_ORDER = ['style', 'genre', 'format', 'sound'];

export function layerList(changed = []) {
  const words = LAYER_ORDER.filter((k) => changed.includes(k)).map((k) => LAYER_WORDS[k]);
  if (!words.length) return 'the direction';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * What applying a change to these layers would do, said before it is done. Every word is derived
 * from RESET_START and the stage list, so this cannot drift away from the rule that actually runs.
 */
export function resetConsequence(changed = []) {
  const plan = resetPlan(changed);
  if (!plan.stale.length) return 'No stage would be redone, because none of these layers feed work that has been produced yet.';
  const roles = plan.stale.map((k) => stageDef(k).role);
  return `Changing the ${layerList(changed)} sends work back for a redo from ${stageDef(plan.fromStage).role} onwards: ${roles.join(', ')}. `
    + 'Both approval gates are withdrawn, so an approval given to the older version cannot be mistaken for approval of this one.';
}

/** The rule in owner words, for a page that has not been submitted yet. */
export const RESET_RULE_NOTE = 'Changing one of these four is not cosmetic. Anything produced from the affected point onward is sent back for a redo, and both approvals are withdrawn.';

/** Which layer fields differ between two layer sets - the basis for asking to confirm a reset. */
export function changedLayers(current = {}, next = {}) {
  const out = [];
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (!same(current.style, next.style)) out.push('style');
  if (!same(current.genres, next.genres)) out.push('genre');
  if (!same(current.format, next.format)) out.push('format');
  if (!same(current.sound, next.sound)) out.push('sound');
  if (!same(current.faceDirection, next.faceDirection)) out.push('style', 'genre');  // faces reach both the look and the story
  return [...new Set(out)];
}

// ---------------------------------------------------------------- what stages are told

/**
 * The direction block a stage reads. It names the four layers and the face decision in the same words
 * the owner used, and it states the limit of the claim: these are directions on the brief, not
 * promises about what any generation tool can produce.
 */
export function layerDirection(film) {
  const l = layerLabels(film);
  const face = faceDirection(film);
  const lines = [
    `Visual direction (${LAYER_QUESTIONS.style}): ${l.style}`,
    `Story direction (${LAYER_QUESTIONS.genre}): ${l.genres.join(' / ') || 'not chosen'}`,
    `Video kind (${LAYER_QUESTIONS.format}): ${l.format}`,
    `Audio direction (${LAYER_QUESTIONS.sound}): ${l.sound}`,
  ];
  if (face.mode !== 'either') lines.push(`Faces: ${face.mode === 'avoid' ? 'no visible faces - use silhouettes, backs of heads, hands, objects and places' : face.mode === 'allow' ? 'characters may show faces' : `unclear (${face.note}) - ask the owner before deciding`}`);
  lines.push('These are directions on the owner\'s brief. Do not state or imply that any tool can or cannot produce them, and do not treat a reference named in a label as owned by us.');
  return lines.join('\n');
}

/** The format a stage should shape its work to, or null when the story is a plain short film. */
export function formatPlan(film) {
  const value = layersOf(film)?.format?.value;
  if (!value || value === STUDIO_SUGGESTS) return null;
  const f = FORMATS.find((x) => x.value === value);
  return f ? { value, label: f.label, hint: f.hint, noOnCameraPresenter: f.noPresenter === true, loopable: f.loopable === true } : null;
}

export const layerQuestion = (kind) => LAYER_QUESTIONS[kind] ?? kind;
export { OTHER, STUDIO_SUGGESTS };
