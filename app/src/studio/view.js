// The owner-facing studio pages. Everything on screen is read out of the stored film record, and
// every status word comes from stages.js, so a card and the detail view cannot disagree and the
// CSS cannot style a state the record does not have.

import { ENTRY, KIND, STATUS, STATUS_LABEL, STAGES, filmStatus, stageDef, toneFor } from './stages.js';
import { SAMPLE, capabilitiesSummary } from './generation.js';
import { layerFields, summaryElement } from './fields.js';
import { RESET_RULE_NOTE, RESET_START, defaultLayers, layerList, resetConsequence, storedFaceLine, summaryLine } from './layers.js';
import { escapeHtml as esc } from '../validate.js';

// Same tokens, same single accent, same mobile-first rules as the public page. A studio page is not
// the landing page: no hero, no enquiry form, nothing that advertises that this area exists.
const HEAD = (title) => `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — MyAIStudio studio</title>
<meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/app.css">
</head><body class="studio-body">
<header class="nav"><div class="mark"><i></i>MyAIStudio <span>owner workspace</span></div>
<a class="jump" href="/studio">Pipeline</a><a class="jump" href="/">Public page</a></header>
<main>`;
const TAIL = `<script src="/studio.js"></script></main>
<footer><div class="wrap"><span>MyAIStudio · owner workspace</span>
<span>No analytics, no third-party requests. Nothing here publishes, posts or sends anything.</span></div></footer>
</body></html>`;

const shell = ({ title, body, openPreview = false }) => HEAD(title) + (openPreview ? openBanner() : '') + body + TAIL;

const openBanner = () => `<p class="openpreview" role="alert"><strong>This workspace is not access-controlled.</strong>
 MODE is prototype, so there are no owner credentials to check and anyone who can reach this address can read
 and change these records. Backend generation is also switched off in this mode, so no stage here can reach a
 model. Use real brand material here only once MODE=live, which makes credentials mandatory to start.</p>`;

export const statusLabel = (status) => STATUS_LABEL[status] ?? status;
export const statusTone = toneFor;

// ---------------------------------------------------------------- one stage
export function stageRow(film, def, { detail = false } = {}) {
  const st = film.stages[def.key];
  const tone = statusTone(st.status);
  const gen = st.output?.generated;
  return `<li class="pipe s-${tone}" data-stage="${esc(def.key)}" data-status="${esc(st.status)}" data-sample="${st.sample ? '1' : '0'}">
  <div class="pipe-head"><span class="pipe-dot" aria-hidden="true"></span>
    <h4>${esc(def.role)}</h4>
    <span class="pipe-status s-${tone}">${esc(statusLabel(st.status))}</span>
  </div>
  <p class="pipe-job">${esc(def.job)}</p>
  ${st.status === STATUS.DONE && st.sample ? `<p class="pipe-by">${esc(st.note ?? SAMPLE)}</p>` : ''}
  ${st.status === STATUS.DONE && !st.sample && gen ? `<p class="pipe-by">via ${esc(gen.backend ?? 'configured backend')}${gen.prompt ? ` · ${esc(gen.prompt)}` : ''}</p>` : ''}
  ${st.status === STATUS.FAILED ? `<p class="pipe-err"><strong>Failed.</strong> ${esc(st.error ?? 'no error text was kept')}<span class="pipe-retry"> Nothing is retried automatically.</span></p>` : ''}
  ${st.status === STATUS.SENT_BACK ? `<p class="pipe-back"><strong>Sent back.</strong> ${esc(st.notes ?? 'no notes were attached')}</p>` : ''}
  ${st.status === STATUS.NEEDS_APPROVAL ? `<p class="pipe-ask">${esc(askHint(def, film))}</p>` : ''}
  <p class="pipe-attempt">${st.attempts ? `attempt ${st.attempts}` : 'not started'}${st.claimedAt ? ` · claimed ${shortTime(st.claimedAt)}` : ''}${st.finishedAt ? ` · finished ${shortTime(st.finishedAt)}` : ''}</p>
  ${detail ? stageOutput(film, def, st) : ''}
</li>`;
}

const askHint = (def, film) => def.key === 'gate_concept'
  ? 'Choose a concept, then approve or reject it. Nothing is written or designed until you do.'
  : def.key === 'gate_release'
    ? 'The review has passed this film. Only you can approve it for release, and approving publishes nothing.'
    : 'Waiting for your decision.';

function stageOutput(film, def, st) {
  const o = st.output;
  if (!o) return '';
  const rows = [];
  const kv = (k, v, raw = false) => rows.push(`<p class="out-kv"><span>${esc(k)}</span>${raw ? v : esc(v)}</p>`);
  const list = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.note ?? x?.title ?? x?.action ?? JSON.stringify(x))).join(' · ') : '—');

  if (def.key === 'research') {
    kv('Audience interests', list(o.audienceInterests));
    kv('Trends', list(o.trends));
    kv('Story references', list(o.references));
    kv('Sources kept', (o.sources ?? []).length ? (o.sources ?? []).map((s) => `<a href="${esc(s.url)}" rel="noopener noreferrer nofollow">${esc(s.url)}</a>`).join('<br>') : 'none — nothing was gathered', true);
    if (o.note) kv('Researcher note', o.note);
  }
  if (def.key === 'concept') {
    rows.push(conceptChoices(film, o.items ?? []));
    if (o.note) kv('Director note', o.note);
    if (o.blocked?.length) kv('Blocked on', list(o.blocked));
  }
  if (def.key === 'script') {
    kv('Opening hook', o.hook);
    kv('Scenes', (o.scenes ?? []).map((s) => `${s.n}. ${s.action}${s.dialogue ? ` — “${s.dialogue}”` : ''}`).join('\n').replace(/\n/g, '<br>'), true);
    kv('Ending', o.ending);
    if (o.noteForHuman?.length) kv('For you', list(o.noteForHuman));
  }
  if (def.key === 'storyboard') {
    kv('Look', o.look);
    kv('Characters', list(o.characters));
    kv('Settings', list(o.settings));
    kv('Shot sketches', (o.shots ?? []).map((s) => `${s.scene}. ${s.sketch}${s.framing ? ` [${s.framing}]` : ''}`).join('<br>'), true);
    kv('Title cards and cover', [...(o.titleCards ?? []).map((t) => `${t.at}: ${t.text}`), o.cover ? (typeof o.cover === 'string' ? o.cover : o.cover.text) : ''].filter(Boolean).join('<br>') || '—', true);
    if (o.needs) kv('Needs', o.needs);
  }
  if (def.key === 'assets') {
    for (const kind of ['footage', 'voice', 'music']) {
      const items = (o[kind] ?? []).map((a) => a.ref ?? (a.produced === false ? a.reason ?? 'not produced' : a.status ?? 'produced'));
      kv(kind, items.length ? items.join('<br>') : 'none', true);
    }
    if (o.note) kv('Producer note', o.note);
  }
  if (def.key === 'edit') {
    kv('Assembly', o.assembly ?? o.renderStatus ?? '—');
    kv('Pacing', o.pacing ?? '—');
    kv('Captions', list(o.captions));
    kv('Sound', typeof o.sound === 'string' ? o.sound : list(o.sound));
    kv('Continuity', typeof o.continuity === 'string' ? o.continuity : list(o.continuity));
    kv('Render', o.renderStatus ?? '—');
  }
  if (def.key === 'critique') {
    kv('Verdict', o.verdict === 'pass' ? 'the review passed this film' : `sent back to ${stageDef(o.sendBackTo)?.role ?? o.sendBackTo ?? '—'}`);
    kv('Strengths', list(o.strengths));
    kv('Problems', list(o.problems));
    if (o.notes) kv('Notes', o.notes);
  }
  if (def.key === 'gate_concept') kv('Approved concept', (o.items ?? []).find((c) => c.approvedRef === undefined) ? '' : '', true);
  if (def.key === 'gate_release') {
    kv('Decision', o.published === false ? 'approved for release by you — nothing was published' : 'approved');
    kv('Publishing', o.publishAction ?? 'none');
  }
  if (def.key === 'marketing') {
    kv('Title', o.title);
    kv('Caption', o.caption);
    kv('Release plan', (o.releasePlan ?? []).map((p) => typeof p === 'string' ? p : `${p.slot ?? ''} ${p.when ?? ''} — ${p.what ?? p.action ?? ''}`.trim()).join('<br>') || '—', true);
    kv('Results', `${o.resultsCollection?.status ?? 'no source configured'}${o.resultsCollection?.note ? ` — ${o.resultsCollection.note}` : ''}`);
  }
  if (rows.length === 0) rows.push(`<p class="out-kv"><span>Output</span>stored, ${Object.keys(o).length} field(s)</p>`);
  return `<div class="pipe-out">${rows.join('')}</div>`;
}

function conceptChoices(film, items) {
  if (!items.length) return '<p class="empty">No concepts were filed. The run failed or returned nothing usable.</p>';
  const decided = film.stages.gate_concept.status !== STATUS.NEEDS_APPROVAL;
  return `<ul class="concepts">${items.map((c) => `<li>
    <label${decided ? '' : ''}>
      ${decided ? `<span class="radio-static" aria-hidden="true">${film.chosenConcept?.ref === c.ref ? '●' : '○'}</span>`
        : `<input type="radio" name="concept" value="${esc(c.ref)}" form="gate-form" ${film.chosenConcept?.ref === c.ref ? 'checked' : ''}>`}
      <span><strong>${esc(c.workingTitle)}</strong><br>${esc(c.oneSentenceStory)}<br>
      <em>${esc(c.whyItCouldWork)}</em><br>${esc(c.mood ?? '')}
      ${c.sources?.length ? `<br><span class="srcs">${c.sources.map((s) => esc(String(s))).join(' · ')}</span>` : ''}</span>
    </label></li>`).join('')}</ul>`;
}

export function timeline(film) {
  if (!film.history?.length) return '<p class="empty">Nothing has happened on this film yet.</p>';
  return `<ol class="timeline">${film.history.slice(-50).map((h) => `<li class="tl-${esc(h.kind)}">
    <span class="tl-time">${esc(shortTime(h.at))}</span>
    <span class="tl-who">${esc(h.actor ?? '—')}</span>
    <span class="tl-what">${esc(h.text ?? h.kind)}</span>
    ${h.to ? `<span class="tl-arrow">→ ${esc(stageDef(h.to)?.role ?? h.to)}</span>` : ''}
    ${h.notes ? `<span class="tl-notes">${esc(h.notes)}</span>` : ''}
  </li>`).join('')}</ol>`;
}

const shortTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.valueOf()) ? String(iso ?? '') : d.toISOString().slice(5, 16).replace('T', ' '); };

// ---------------------------------------------------------------- next action, shared
export function nextActionOf(film) {
  for (const s of STAGES) {
    const st = film.stages[s.key];
    if (st.status === STATUS.RUNNING) return { kind: 'running', stage: s.key };
    if (st.status === STATUS.NEEDS_APPROVAL) return { kind: 'gate', gate: s.key, stage: s.key };
    if (st.status === STATUS.FAILED) return { kind: 'failed', stage: s.key };
    if ((st.status === STATUS.WAITING || st.status === STATUS.SENT_BACK) && orderOk(film, s.key)) return { kind: 'run', stage: s.key };
  }
  return { kind: 'complete', stage: null };
}

/** Reads the same rule the pipeline uses: a stage may run once everything before it is finished. */
export const orderOk = (film, key) => {
  const idx = STAGES.findIndex((s) => s.key === key);
  for (let i = 0; i < idx; i += 1) {
    const prev = STAGES[i];
    const p = film.stages[prev.key];
    if (prev.kind === KIND.APPROVAL) { if (p.approval !== 'approve') return false; }
    else if (p.status !== STATUS.DONE) return false;
  }
  return true;
};

// ---------------------------------------------------------------- the two pages
export function studioIndex({ films = [], caps, error, notice, tokens = {}, openPreview = false, unreadable = [], mode = 'prototype', entered = null, fieldErrors = {} }) {
  // a refused entry must come back with what you typed still in it, or the fix means starting over
  const e = entered ?? {};
  const layersFor = (kind) => e.layers?.[kind] ?? e[kind] ?? defaultLayers()[kind];
  const bodies = [
    entryFormIdeas(tokens.ideas, e, layersFor, fieldErrors),
    entryFormPremise(tokens.premise, e, layersFor, fieldErrors),
  ];
  return shell({
    title: 'Studio pipeline', openPreview, body: `
<section class="studio"><div class="wrap">
  <div class="eyebrow">Owner workspace</div>
  <h1 class="h-sec">Studio pipeline</h1>
  <p class="sub">One record per film. Each role reads that record and writes back into it, so this list shows what
  has actually been produced rather than what has been started.</p>
  ${modeLine(caps)}
  ${notice ? `<p class="note-ok" role="status">${esc(notice)}</p>` : ''}
  ${error ? `<p class="note-bad" role="alert">${esc(error)}</p>` : ''}
  <div class="entry-grid">${bodies.join('')}</div>
  <h2 class="films-h">Films <span class="count">${films.length}</span></h2>
  ${films.length === 0 && unreadable.length === 0 ? '<p class="empty">No films yet. Start one above — either entry mode makes the same kind of record.</p>' : ''}
  <ul class="film-list">${films.map((f) => filmCard(f)).join('')}${unreadable.map(unreadableCard).join('')}</ul>
</div></section>`,
  });
}

const entryFormIdeas = (token, e, layersFor, errs) => `<form class="entry" method="post" action="/studio/films" data-entry="${ENTRY.IDEAS}">
  <input type="hidden" name="mode" value="${ENTRY.IDEAS}">
  <input type="hidden" name="_token" value="${esc(token)}">
  <h3>Bring me ideas</h3>
  <p class="entry-help">Three original concepts come back for you to choose from. Title and premise are not needed here.</p>
  <label>Any steer for the research (optional)<textarea name="notes" rows="3" maxlength="8000" placeholder="subject, mood, things to avoid">${esc(e.notes ?? '')}</textarea></label>
  <label>Target length (optional)<input type="text" name="targetLength" maxlength="40" value="${esc(e.targetLength ?? '')}" placeholder="30 seconds"></label>
  ${fieldError('targetLength', errs)}
  <label>Links research must include (optional)<textarea name="links" rows="2" maxlength="4096" placeholder="one http(s) link per line">${esc((e.links ?? []).join('\n'))}</textarea></label>
  ${fieldError('links', errs)}
  ${layerFields({ style: layersFor('style'), genres: layersFor('genres'), format: layersFor('format'), sound: layersFor('sound') }, errs)}
  ${summaryLineBlock(e, { kicker: 'This brief so far', unsent: true })}
  <button class="btn act" type="submit">Ask for three concepts</button>
</form>`;

const entryFormPremise = (token, e, layersFor, errs) => `<form class="entry" method="post" action="/studio/films" data-entry="${ENTRY.PREMISE}">
  <input type="hidden" name="mode" value="${ENTRY.PREMISE}">
  <input type="hidden" name="_token" value="${esc(token)}">
  <h3>Develop my idea</h3>
  <p class="entry-help">Your premise enters the same stages as a chosen concept. Title and premise are both wanted.</p>
  <label>Working title<input type="text" name="title" maxlength="120" required value="${esc(e.title ?? '')}" placeholder="a name to work with"></label>
  ${fieldError('title', errs)}
  <label>Premise or story idea<textarea name="premise" rows="4" maxlength="4000" required placeholder="what happens, and what it turns on">${esc(e.premise ?? '')}</textarea></label>
  ${fieldError('premise', errs)}
  <label>Facts or links research must include<textarea name="links" rows="2" maxlength="4096" placeholder="one http(s) link per line">${esc((e.links ?? []).join('\n'))}</textarea></label>
  ${fieldError('links', errs)}
  <label>Target length<input type="text" name="targetLength" maxlength="40" value="${esc(e.targetLength ?? '')}" placeholder="45 seconds"></label>
  ${fieldError('targetLength', errs)}
  <label>Notes (optional)<textarea name="notes" rows="2" maxlength="8000">${esc(e.notes ?? '')}</textarea></label>
  ${layerFields({ style: layersFor('style'), genres: layersFor('genres'), format: layersFor('format'), sound: layersFor('sound') }, errs)}
  ${summaryLineBlock(e, { kicker: 'This brief so far', unsent: true })}
  <button class="btn act2" type="submit">Develop this idea</button>
</form>`;

/** What the browser shows while the notes have not been read. Not a claim about the film. */
const FACE_UNREAD = '+ face direction not set yet';

const fieldError = (name, errs) => (errs[name] ? `<p class="fielderr" role="alert">${esc(errs[name])}</p>` : '');

/**
 * A film has exactly one summary of its direction, and it is built by layers.summaryLine. This
 * block is that same call with the entered values, so the card and a saved film can never say two
 * different things about the same brief.
 */
function summaryLineBlock(entered, { kicker = 'This brief so far', unsent = false, film = null } = {}) {
  const layers = entered?.layers ?? defaultLayers();
  const brief = { notes: entered?.notes ?? '', premise: entered?.premise ?? '', layers };
  // An unsent form cannot state a face direction: the notes have not been read yet. A saved film
  // already has one and carries it forward untouched.
  const face = unsent ? null : storedFaceLine({ brief });
  const text = summaryLine({ brief }, { faceText: unsent ? FACE_UNREAD : face ?? undefined });
  return `<p class="summary-line-wrap"><span class="summary-kicker">${esc(kicker)}</span>${summaryElement(text, unsent ? { faceUnread: true } : (face ? { face } : {}))}</p>`;
}

export function filmCard(film) {
  const s = filmStatus(film);
  const act = nextActionOf(film);
  return `<li class="film-card t-${esc(s.tone)}">
  <a class="film-link" href="/studio/film/${esc(film.id)}">
    <h3>${esc(film.brief?.title || film.brief?.premise?.slice(0, 60) || 'untitled film')}</h3>
    <p class="film-meta">${esc(film.entryMode === ENTRY.IDEAS ? 'Bring me ideas' : 'Develop my idea')} · ${esc(s.label)} · ${esc(film.pipelineMode)} mode · v${film.version}</p>
    <div class="film-stage">${STAGES.map((d) => {
      const st = film.stages[d.key];
      return `<span class="chip s-${statusTone(st.status)}" title="${esc(d.role)}: ${statusLabel(st.status)}">${esc(shortRole(d.role))}</span>`;
    }).join('')}</div>
  </a>
  ${act.kind === 'failed' ? `<p class="film-warn">Stopped at ${esc(stageDef(act.stage).role)}. Read the error on the film page.</p>` : ''}
  ${act.kind === 'gate' ? `<p class="film-ask">Waiting on you: ${esc(stageDef(act.gate).role.replace('You — ', ''))}.</p>` : ''}
</li>`;
}

const unreadableCard = (f) => `<li class="film-card t-failed"><h3>${esc(String(f.id).slice(0, 8))} — unreadable record</h3>
  <p class="film-meta">${esc(f.error ?? 'the stored file could not be parsed')}</p></li>`;

const shortRole = (role) => role.replace('You — ', '').replace(' — review pass', ' (review)').split(/[\s/]+/)[0].slice(0, 7);

export function studioFilmPage({ film, caps, error, notice, retry, openPreview = false, layerErrors = null, enteredLayers = null, enteredNote = '', changedLayersNote = null }) {
  const s = filmStatus(film);
  const act = nextActionOf(film);
  const next = act.stage;
  return shell({
    title: film.brief?.title || 'untitled film', openPreview, body: `
<section class="studio detail"><div class="wrap">
  <p class="backline"><a href="/studio">All films</a></p>
  <div class="eyebrow">${esc(film.entryMode === ENTRY.IDEAS ? 'Bring me ideas' : 'Develop my idea')} · ${esc(s.label)}</div>
  <h1 class="h-sec">${esc(film.brief?.title || 'untitled film')}</h1>
  <p class="brief-direction" data-direction>${esc(summaryLine(film))}</p>
  ${error ? `<p class="note-bad" role="alert">${esc(error)}</p>` : ''}
  ${notice ? `<p class="note-ok" role="status">${esc(notice)}</p>` : ''}
  ${retry ? `<p class="note-ok" role="status">${esc(retry)}</p>` : ''}
  ${changedLayersNote ? `<p class="note-ok" role="status" data-reset-result>${esc(changedLayersNote)}</p>` : ''}
  ${filmShapeWarning(film)}
  ${modeBadge(film, caps)}
  ${briefPanel(film)}
  ${directionForm(film, { layerErrors, enteredLayers, enteredNote })}
  ${actBar(film, act, next)}
  ${gateForm(film, act)}
  <h2 class="stagehdr">Stages, in order</h2>
  <ol class="pipe-list">${STAGES.map((d) => stageRow(film, d, { detail: true })).join('')}</ol>
  <h2 class="stagehdr">Handoffs</h2>
  ${timeline(film)}
  ${pollPanel(film, s, next, act)}
</div></section>`,
  });
}

const filmShapeWarning = (film) => (film.shapeProblems?.length
  ? `<p class="note-bad" role="alert"><strong>This record is inconsistent.</strong> ${film.shapeProblems.map(esc).join(' ')}</p>` : '');

const modeBadge = (film, caps) => (film.pipelineMode === 'demo'
  ? `<p class="pipemodes mode-demo" role="note"><strong>DEMO mode — no generation backend connected.</strong> Every stage below wrote
     labelled sample output so the flow can be exercised. Nothing here came from a model. <span>${esc(capabilitiesSummary(caps).parts.join(' · '))}</span></p>`
  : `<p class="pipemodes mode-real" role="note"><strong>Real mode.</strong> Stages with a configured backend used it; any stage without one says so on its card.
     <span>${esc(capabilitiesSummary(caps).parts.join(' · '))}</span></p>`);

function briefPanel(film) {
  const b = film.brief;
  return `<details class="brief" open><summary>The brief — record v${film.version}, updated ${esc(shortTime(film.updatedAt))}</summary>
    <p class="out-kv"><span>Working title</span>${esc(b.title || 'not set')}</p>
    <p class="out-kv"><span>Premise</span>${esc(b.premise || 'not supplied — this film started from proposed concepts')}</p>
    <p class="out-kv"><span>Notes</span>${esc(b.notes || '—')}</p>
    <p class="out-kv"><span>Target length</span>${esc(b.targetLength || '—')}</p>
    <p class="out-kv"><span>Links to include</span>${(b.links ?? []).length ? b.links.map((l) => `<a href="${esc(l)}" rel="noopener noreferrer nofollow">${esc(l)}</a>`).join('<br>') : 'none'}</p>
    <p class="out-kv"><span>Chosen concept</span>${esc(film.chosenConcept?.workingTitle ?? 'not chosen yet')}</p>
  </details>`;
}

/**
 * Editing the direction on a film that already exists. The controls are the same ones the entry
 * cards use - one renderer, so a value that can be chosen at the start can be chosen here too, and
 * a value that would be refused there is refused here.
 *
 * The consequence is spelled out *before* anything is submitted, and it is generated from RESET_START
 * rather than retyped: if the rule changes, this sentence changes with it.
 */
function directionForm(film, { layerErrors = null, enteredLayers = null, enteredNote = '' } = {}) {
  const stored = film.brief?.layers ?? defaultLayers();
  const shown = enteredLayers ?? stored;
  const resetRow = ['style', 'genre', 'format', 'sound']
    .map((k) => `<li><b>${esc(layerList([k]))}</b> → ${esc(stageDef(RESET_START[k]).role)}</li>`)
    .join('');
  const previous = film.brief?.layers?.changedFrom
    ? `<p class="brief-previous">Previously on this brief: <span>${esc(film.brief.layers.changedFrom)}</span></p>` : '';
  return `<details class="direction" data-direction-editor>
    <summary>Change the look, genre, format or sound</summary>
    <p class="entry-help">This edits the one brief every role reads. It does not start any work: after it
      saves, the stages that went stale are shown as sent back and you start them again.</p>
    ${previous}
    <p class="reset-rule" data-reset-rule>${esc(RESET_RULE_NOTE)}</p>
    <ul class="reset-map" data-reset-map>Where the redo starts, per layer:${resetRow}</ul>
    <form class="layer-edit" method="post" action="/studio/film/${esc(film.id)}/layers">
      <input type="hidden" name="version" value="${film.version}">
      ${layerFields(shown, layerErrors ?? {}, stored)}
      ${summaryLineBlock({ notes: film.brief?.notes ?? '', premise: film.brief?.premise ?? '', layers: shown }, { kicker: 'If you apply this', film })}
      <p class="field">
        <label for="l-change-note">Why you changed it (optional, goes on every affected stage card)</label>
        <textarea id="l-change-note" name="note" maxlength="400" placeholder="quieter, and scarier">${esc(enteredNote)}</textarea>
        ${layerErrors?.note ? `<p class="fielderr" role="alert">${esc(layerErrors.note)}</p>` : ''}
      </p>
      <div class="actions">
        <button class="btn act" type="submit" data-layers-submit>Apply this change</button>
        <a class="btn ghostbtn" href="/studio/film/${esc(film.id)}">Cancel</a>
      </div>
      <p class="fineprint">Record version ${film.version}. If another tab saved this film first, your write is
        dropped instead of applied on top, and you are told rather than quietly overwritten.</p>
    </form>
  </details>`;
}

const runForm = (film, next, extra = '') => `<form class="runform" method="post" action="/studio/film/${esc(film.id)}/run">
  <input type="hidden" name="version" value="${film.version}">
  <input type="hidden" name="stage" value="${esc(next ?? '')}">
  ${extra}
  <button class="btn act" type="submit">${esc(runLabel(film, next))}</button>
</form>`;

const runLabel = (film, next) => (film.stages[next]?.status === STATUS.SENT_BACK
  ? `Rework: ${stageDef(next).role}` : `Run: ${stageDef(next).role}`);

function actBar(film, act, next) {
  if (act.kind === 'run') return `<div class="actbar">${runForm(film, next)}<p class="actnote">This stage has not run yet. Nothing happens until you start it.</p></div>`;
  if (act.kind === 'running') return `<div class="actbar"><p class="polling" aria-live="polite">${esc(stageDef(act.stage).role)} is working. This page updates while it runs.</p></div>`;
  if (act.kind === 'failed') {
    return `<div class="actbar"><form class="retryform" method="post" action="/studio/film/${esc(film.id)}/retry">
      <input type="hidden" name="version" value="${film.version}"><input type="hidden" name="stage" value="${esc(act.stage)}">
      <button class="btn ghostbtn" type="submit">Retry ${esc(stageDef(act.stage).role)}</button></form>
      <p class="actnote">Retrying is your decision: the error above stays on record either way.</p></div>`;
  }
  if (act.kind === 'complete') return `<div class="actbar"><p class="done-note">This film is through the pipeline. Nothing was published, and nothing on this page can publish.</p></div>`;
  return '';
}

function gateForm(film, act) {
  if (act.kind !== 'gate') return '';
  const gate = act.gate;
  const st = film.stages[gate];
  if (gate === 'gate_concept') {
    const items = film.stages.concept.output?.items ?? [];
    return `<div class="decision" id="gate-concept"><h3>Approval gate 1 — the concept</h3>
      <p>Nothing is written or designed until you approve one of these.</p>
      <form id="gate-form" method="post" action="/studio/film/${esc(film.id)}/gate">
        <input type="hidden" name="version" value="${film.version}"><input type="hidden" name="gate" value="gate_concept">
        <input type="hidden" name="decision" value="approve">
        ${items.length ? '<label class="pickone">Which concept are you approving?<span class="fineprint">Choose one above or here; approving nothing is not a decision.</span></label>' : ''}
        <label>Notes for the record<textarea name="notes" rows="2" maxlength="4000" placeholder="why this one, or what the next pass must fix"></textarea></label>
        <div class="choice">
          <button class="btn act" type="submit" form="gate-form">Approve the chosen concept</button>
          <button class="btn back" type="submit" name="decision" value="reject">Reject and send back</button>
        </div>
      </form></div>`;
  }
  const targets = stageDef('critique').canSendBackTo.filter((k) => film.stages[k].status === STATUS.DONE);
  return `<div class="decision" id="gate-release"><h3>Approval gate 2 — release</h3>
    <p>The review passed this film. Approving records your decision only: this build has no publishing path.</p>
    <form method="post" action="/studio/film/${esc(film.id)}/gate">
      <input type="hidden" name="version" value="${film.version}"><input type="hidden" name="gate" value="gate_release">
      <label>Notes for the record<textarea name="notes" rows="2" maxlength="4000"></textarea></label>
      <div class="choice">
        <button class="btn act" type="submit" name="decision" value="approve">Approve for release</button>
        <button class="btn back" type="submit" name="decision" value="reject">Do not approve</button>
      </div>
      ${targets.length ? `<label class="sendto">If you do not approve, send it back to
        <select name="sendTo">${targets.map((k) => `<option value="${esc(k)}">${esc(stageDef(k).role)}</option>`).join('')}</select></label>` : ''}
    </form></div>`;
}

function pollPanel(film, s, next, act) {
  const running = act.kind === 'running';
  return `<p id="poll-status" class="poll-shell" data-film="${esc(film.id)}" data-version="${film.version}"
     data-interval="1200" data-state="${esc(s.tone)}" role="status" aria-live="polite">${running
    ? `${esc(stageDef(act.stage).role)} is running. This page reads the stored record every few seconds and stops when nothing is running.`
    : 'Nothing is running, so this page is not refreshing.'}</p>
  <p class="fineprint">The poll reads the same record a refresh would show. It stops the moment no stage is running, and it never
  starts work on its own.</p>
  ${next && act.kind !== 'gate' ? `<script type="application/json" id="next-stage">${JSON.stringify({ next })}</script>` : ''}`;
}

export const modeLine = (caps) => {
  const s = capabilitiesSummary(caps);
  return `<p class="mode mode-${esc(s.pipelineMode)}"><strong>Pipeline mode: ${esc(s.pipelineMode)}.</strong> ${
    s.pipelineMode === 'demo' ? 'No generation backend is configured, so stages write labelled samples.' : 'Backends are configured for the stages listed.'
  } <span>${esc(s.parts.join(' · '))}${s.endpointsWithoutClients?.length ? ` — endpoints with no client: ${esc(s.endpointsWithoutClients.join(', '))}` : ''}</span></p>`;
};

export function viewError({ caps, title, note, backTo = '/studio' }) {
  return shell({
    title, body: `<section class="studio"><div class="wrap"><div class="eyebrow">Owner workspace</div>
      <h1 class="h-sec">${esc(title)}</h1>
      <p class="note-bad" role="alert">${esc(note)}</p>
      <p class="mode mode-${esc(caps.pipelineMode)}">${esc(capabilitiesSummary(caps).parts.join(' · '))}</p>
      <p><a class="btn ghostbtn" href="${esc(backTo)}">Back</a></p></div></section>`,
  });
}

export function viewUnauthorized({ reason, caps }) {
  const note = reason === 'not_configured'
    ? 'MODE=live but OWNER_USER / OWNER_PASS are missing, so this workspace cannot open at all.'
    : 'Those credentials were not accepted. Nothing about your films is shown and nothing was changed.';
  return viewError({ caps, title: 'Sign in to see the pipeline', note, backTo: '/' });
}
