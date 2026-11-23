// Rendering only. Every value that came from a person or from disk goes through escapeHtml
// before it can become markup, in both modes, including names, labels and file names.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIELDS, PLACEMENT_OPTIONS } from './form.js';
import { STAGES } from './studio/stages.js';
import { escapeHtml } from './validate.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LAYOUT = join(HERE, '..', 'public', 'layout.html');
let LAYOUT = null;

/** The config boundary decides which template is live; this module only renders. */
export function loadLayout(path = DEFAULT_LAYOUT) { LAYOUT = readFileSync(path, 'utf8'); return LAYOUT; }

const COPY = {
  prototype: {
    badge: 'prototype preview',
    eyebrow: 'Prototype preview',
    modeFact: '<span>Demo mode — stores nothing</span>',
    ctaNote: 'Starting a film opens the studio workspace, which needs no sign-in in demo mode — and nothing is saved.',
    footer: 'Nothing on this page is stored or sent anywhere. No script, no third-party requests.',
    heading: 'Brand placements — demo form',
    sub: 'Ask whether a product or service could be part of a film. This preview is wired to the real form but storage is switched off, so filling it in teaches you nothing about the studio’s data.',
    availability: 'Enquiry only: submitting this stores nothing and confirms nothing.',
  },
  live: {
    badge: 'live',
    eyebrow: 'Brand placements',
    modeFact: '',
    ctaNote: 'Submissions are saved on this server and visible only to the studio. Starting a film opens the studio workspace, which asks for the studio sign-in.',
    footer: 'Enquiries are saved on this server for the studio to read. No third-party requests from this page.',
    heading: 'Brand placements',
    sub: 'Ask whether a product or service could be part of a film.',
    availability: 'Saving an enquiry is not a booking: it does not confirm availability, schedule, or placement.',
  },
};

function fieldHtml(f, values, errors, hasValue) {
  const name = escapeHtml(f.name);
  const err = errors[f.name];
  const described = [];
  let control = '';

  if (f.kind === 'text' || f.kind === 'email') {
    const v = escapeHtml(values[f.name] ?? '');
    control = `<input id="f-${name}" name="${name}" type="${f.kind === 'email' ? 'email' : 'text'}" value="${v}" maxlength="${f.max}" autocomplete="organization" required>`;
  } else if (f.kind === 'textarea') {
    control = `<textarea id="f-${name}" name="${name}" rows="4" maxlength="${f.max}" required>${escapeHtml(values[f.name] ?? '')}</textarea>`;
  } else if (f.kind === 'radio') {
    described.push(`f-${name}-legend`);
    const chosen = values[f.name];
    control = `<div class="opts" role="radiogroup" aria-labelledby="f-${name}-legend">${f.options.map((o, i) => `
      <label class="opt"><input type="radio" name="${name}" value="${escapeHtml(o.value)}" ${chosen === o.value ? 'checked' : ''}><span>${escapeHtml(o.label)}</span></label>`).join('')}
      <p class="hint" id="f-${name}-legend">Choose one${f.options.length > 1 ? ` of ${f.options.length}` : ''}.</p></div>`;
  } else if (f.kind === 'files') {
    described.push(`f-${name}-help`);
    control = `<input id="f-${name}" name="${name}" type="file" multiple accept="${escapeHtml(f.accept.join(','))}">
      <input type="hidden" name="_maxfiles" value="${f.maxFiles}">`;
  }

  const help = f.help ? `<p class="hint" id="f-${name}-help">${escapeHtml(f.help)}</p>` : '';
  const error = err ? `<p class="fielderr" id="f-${name}-err">${escapeHtml(err)}</p>` : '';
  if (err) described.push(`f-${name}-err`);
  return `<div class="field">
    <label for="f-${name}" ${f.kind === 'radio' ? `id="f-${name}-legend"` : ''}>${escapeHtml(f.label)}${f.required ? '<em aria-hidden="true"> *</em>' : ''}</label>
    ${control}${help}${error}
  </div>`;
}

export function formSection({ config, values = {}, errors = {}, fileErrors = [], notice = null, savedId = null }) {
  const c = COPY[config.mode];
  const demo = config.mode === 'prototype';
  const maxBytesMB = Math.round(FIELDS.find((f) => f.kind === 'files').maxFileBytes / 1024 / 1024);
  const noticeHtml = notice
    ? `<div class="result ${escapeHtml(notice.tone)}" role="status" aria-live="polite"><strong>${escapeHtml(notice.title)}</strong> ${escapeHtml(notice.body ?? '')}</div>`
    : '';
  const fieldErrs = fileErrors.length ? `<div class="result error" role="alert"><strong>Assets not accepted</strong><ul>${fileErrors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul></div>` : '';

  return `<section id="form">
  <div class="wrap">
    <div class="eyebrow">${escapeHtml(c.eyebrow)}</div>
    <h2 class="h-sec">${escapeHtml(c.heading)}</h2>
    <p class="sub">${escapeHtml(c.sub)}</p>
    ${demo ? `<div class="demo-notice"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg><span>Demo — submissions are not sent or saved</span></div>` : ''}
    ${noticeHtml}${fieldErrs}
    <form class="enquiry" method="post" action="/enquiry" enctype="multipart/form-data">
      <input type="hidden" name="_form" value="${escapeHtml(config.purpose)}">
      ${FIELDS.map((f) => fieldHtml(f, values, errors, false)).join('\n      ')}
      <p class="fineprint">Files up to ${maxBytesMB} MB each, ${FIELDS.find((f) => f.kind === 'files').maxFiles} at most: PNG, JPEG, WebP, MP4, MOV or PDF. Type is checked from the file’s own bytes.</p>
      <p class="fineprint">${escapeHtml(c.availability)}</p>
      <div class="actions">
        <button class="btn submit" type="submit">Send enquiry</button>
      </div>
    </form>
  </div>
</section>`;
}

/**
 * The landing page describes the workflow in four short steps. Each step names the *same roles*
 * the engine runs, read out of STAGES rather than retyped here, so renaming or reordering a role
 * in the pipeline changes this page too instead of leaving marketing copy describing a pipeline
 * that no longer exists.
 */
const STEP_GROUPS = [
  { keys: ['research'], title: 'Research', sentences: [
    'The Researcher looks into the subject and files where each fact came from, so sources can be checked later.',
    'The plan treats references as inspiration to cite, not as material to absorb into an unfounded claim.',
  ] },
  { keys: ['concept', 'gate_concept'], title: 'Direction', sentences: [
    'The Creative director proposes a story angle, a mood, and a treatment that answers the look, genre, format and sound you chose.',
    'Nothing is written or designed until you approve a concept at the first gate.',
  ] },
  { keys: ['script', 'storyboard', 'assets', 'edit'], title: 'Making', sentences: [
    'The Scriptwriter, storyboard artist, producer and editor each add their part to the one brief record, so no role works from a private copy of the idea.',
    'Sound direction rides along on the same brief: the look of a video and its audio are decided together, not by separate messages.',
  ] },
  { keys: ['critique', 'gate_release', 'marketing'], title: 'Review and release', sentences: [
    'The Creative director reviews the assembled film as a separate pass and can send named stages back with notes before anything advances.',
    'You approve release at the second gate. Approval does not publish: this build has no publishing path and sends nothing anywhere.',
  ] },
];

function workflowSteps() {
  const roleOf = (key) => STAGES.find((s) => s.key === key)?.role ?? null;
  const cards = STEP_GROUPS.map((g, i) => {
    const names = [...new Set(g.keys.map(roleOf).filter(Boolean))];
    return `<article class="step">
      <div class="n">0${i + 1}</div>
      <h3>${escapeHtml(g.title)}</h3>
      <p>${escapeHtml(g.sentences[0])}</p>
      <p>${escapeHtml(g.sentences[1])}</p>
      <p class="step-roles">${escapeHtml(names.join('  ·  '))}</p>
    </article>`;
  }).join('\n');
  return `<div class="steps cols2">\n${cards}\n</div>`;
}

export function renderPage({ config, formHtml }) {
  const c = COPY[config.mode];
  if (!LAYOUT) loadLayout();
  // replaceAll, not replace: {{MODE_BADGE}} appears in the nav AND the footer, and String.replace
  // with a plain string argument only ever fixes the first one - the footer then shipped the raw
  // token to the browser. The invariant below makes any future duplicate fail here instead.
  const SUBSTITUTIONS = [
    ['{{MODE_BADGE}}', escapeHtml(c.badge)],
    ['{{MODE_EYEBROW}}', escapeHtml(c.eyebrow)],
    ['{{MODE_FACT}}', c.modeFact],
    ['{{CTA_NOTE}}', escapeHtml(c.ctaNote)],
    ['<!--@WORKFLOW_STEPS@-->', workflowSteps()],
    ['{{FOOTER_STATUS}}', escapeHtml(c.footer)],
    ['<!--@FORM_SECTION@-->', formHtml],
  ];
  const out = SUBSTITUTIONS.reduce((html, [token, value]) => html.replaceAll(token, value), LAYOUT);
  const leaked = out.match(/\{\{[A-Z_]+\}\}|<!--[A-Z_]+@-->|@\w+@(?=-->)/g);
  if (leaked) throw new Error(`template tokens were not substituted: ${[...new Set(leaked)].join(', ')}`);
  return out;
}

export function noticeFor(result) {
  switch (result.outcome) {
    case 'demo':
      return { tone: 'demo', title: 'Demo only — nothing was sent.', body: 'Storage is switched off in prototype mode, so this enquiry was discarded at the server.' };
    case 'saved':
      return { tone: 'ok', title: 'Thank you — your submission is saved.', body: `Reference ${result.id}.` };
    case 'failed':
      return { tone: 'error', title: 'Nothing was saved.', body: 'The studio’s storage could not accept this submission. It was not sent and is not queued.' };
    default:
      return null;
  }
}

export function ownerListPage({ config, rows, assetNote }) {
  const body = rows.length === 0
    ? '<p class="sub">Nothing stored yet.</p>'
    : `<table class="owner"><thead><tr><th>Saved</th><th>Company</th><th>Product or service</th><th>Placement</th><th>Work email</th><th>Assets</th></tr></thead><tbody>${rows.map((r) => `<tr>
        <td>${escapeHtml(r.storedAt ?? '')}</td>
        <td>${escapeHtml(r.company ?? '')}</td>
        <td class="wrap-text">${escapeHtml(r.offering ?? '')}</td>
        <td>${escapeHtml(PLACEMENT_OPTIONS.find((o) => o.value === r.placement)?.label ?? r.placement ?? '')}</td>
        <td>${escapeHtml(r.contactEmail ?? '')}</td>
        <td>${(r.assets ?? []).map((a) => `<a href="/owner/asset/${encodeURIComponent(a.key)}">${escapeHtml(a.displayName)} (${Math.round((a.bytes ?? 0) / 1024)} KB)</a>`).join('<br>') || '—'}</td>
      </tr>`).join('')}</tbody></table>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Enquiries — MyAIStudio</title><link rel="stylesheet" href="/app.css"></head><body class="owner-page"><header class="nav"><div class="mark"><i></i>MyAIStudio <span>owner only</span></div><a class="jump" href="/">Public page</a></header><main><section><div class="wrap"><div class="eyebrow">Owner view</div><h2 class="h-sec">Saved enquiries</h2><p class="sub">${escapeHtml(assetNote ?? 'Authenticated view. These are not public and are never listed on the landing page.')}</p>${body}</div></section></main></body></html>`;
}

export function simplePage({ config, title, note, tone = 'error' }) {
  return renderPage({
    config,
    formHtml: `<section id="form"><div class="wrap"><div class="eyebrow">Notice</div><h2 class="h-sec">${escapeHtml(title)}</h2><div class="result ${tone}" role="alert">${escapeHtml(note)}</div><p class="sub"><a href="/">Back to the form</a></p></div></section>`,
  });
}
