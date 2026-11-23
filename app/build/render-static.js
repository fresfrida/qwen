// Renders the prototype page to static HTML for the design preview, then verifies its own output.
// This is the only place the form is made inert, and the only reason it exists is that a static
// host has no /enquiry to post to. If a live control survives, the build fails instead of shipping
// a page that looks functional and silently drops what you typed.

import { mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, formSection } from '../src/page.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
const OUT_DIR = join(HERE, '..', '..', 'site');
const config = { mode: 'prototype', purpose: 'brand_enquiries' };

let html = renderPage({ config, formHtml: formSection({ config }) });

html = html
  // no destination on a static host, so remove the payload and switch every field off
  .replace(/<input\b[^>]*type="hidden"[^>]*>/g, '')
  .replace(/<form class="enquiry"[^>]*>/, '<form class="enquiry" data-static-preview="no destination on this host">')
  .replace(/<button class="btn submit" type="submit">Send enquiry<\/button>/,
    '<button class="btn submit" type="button" disabled aria-disabled="true">Send enquiry — unavailable in this preview</button>')
  .replace(/<(input|textarea|select)\b([^>]*)>/g, (m, tag, attrs) => (/\bdisabled\b/.test(attrs) ? m : `<${tag}${attrs} disabled>`))
  .replace(/\s{2,}/g, ' ');

const inertNote = `<p class="fineprint" role="note">This preview is a static file: there is no destination to send to and every field is switched off. The running application renders these same fields enabled and answers a submission with &ldquo;Demo only — nothing was sent.&rdquo;</p>`;
html = html.replace('</form>', `${inertNote}\n    </form>`);

// ---- self-checks: this page must be unable to send, and unable to render broken ----
const problems = [];
if (/<form[^>]*(?:action|method|enctype)=/i.test(html)) problems.push('the exported form still has a submission target');
if (/<(?:button|input)[^>]*type="submit"/i.test(html)) problems.push('an enabled submit control survived');
const editable = [...html.matchAll(/<(input|textarea|select)\b([^>]*)>/g)].filter((m) => !/\bdisabled\b/.test(m[2]));
if (editable.length) problems.push(`${editable.length} field(s) not switched off: ${editable.map((m) => m[2].trim().slice(0, 40)).join(' | ')}`);
if (!/Demo — submissions are not sent or saved/.test(html)) problems.push('the demo notice disappeared');
if (/undefined|\[object Object\]|NaN/.test(html)) problems.push('the render contains a JavaScript placeholder value');
if ((html.match(/<textarea[^>]*disabled[^>]*>/g) ?? []).length === 0) problems.push('the textarea was not switched off');
const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
// "Start a film" has to lead somewhere. In the static export it can only lead to the workspace door,
// so the door must exist, must not be a fake form, and must not reach into anyone's film records.
const studioRefs = refs.filter((r) => r.startsWith('/studio'));
if (studioRefs.some((r) => r !== '/studio')) problems.push(`links reach deeper into the workspace than the door: ${studioRefs.filter((r) => r !== '/studio').join(', ')}`);
const ctaTag = (html.match(/<a\b[^>]*data-cta="start-a-film"[^>]*>/) ?? [''])[0];
if (!/href="\/studio"/.test(ctaTag)) problems.push('the hero CTA no longer leads to a real creation entry point');
if (/Title pending/.test(html)) problems.push('placeholder film titles came back');
if (!/No published films yet/.test(html)) problems.push('the stories section lost its honest empty state');
if (/data-summary|brief-direction/.test(html)) problems.push('a saved brief direction leaked onto the public page');
if (/<link rel="stylesheet" href="\/app\.css"/.test(html) && !refs.includes('/app.css')) problems.push('stylesheet not discovered by the reference check');
if (/accept=""/.test(html)) problems.push('the file input lost its accept list (over-escaping?)');
const acceptList = (html.match(/accept="([^"]*)"/) ?? [])[1] ?? '';
if (!acceptList.includes('image/png')) problems.push(`accept list is wrong: "${acceptList}"`);

// ---- copy the files the page references beside it, then fail if any reference is missing ----
await mkdir(OUT_DIR, { recursive: true });
for (const f of ['app.css', 'grain.svg', 'favicon.svg']) await cp(join(PUB, f), join(OUT_DIR, f));
await writeFile(join(OUT_DIR, 'index.html'), html, 'utf8');

// /studio is part of the running app: it needs storage, sign-in, and a pipeline. A static file has
// none of those, so the published root answers that address with its limitation instead of a dead
// link or a mock workspace that pretends to make films.
await mkdir(join(OUT_DIR, 'studio'), { recursive: true });
await writeFile(join(OUT_DIR, 'studio', 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Studio workspace - not available in this export</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="nav"><div class="mark"><i></i>MyAIStudio <span>static export</span></div></header>
<main><section class="hero">
<div class="wrap">
  <div class="eyebrow">Studio workspace</div>
  <h1>Nothing to show here yet</h1>
  <p class="lede">Starting a film happens in the studio workspace, which is part of the running app.
  This folder is a static export: it has no storage, no sign-in, and no pipeline, so there are no
  films to list and no brief to fill in. Opening the app serves the same address with the real
  workspace behind it.</p>
  <div class="cta-row"><a class="btn" href="/">Back to the overview</a></div>
  <p class="cta-note">This page states a limitation. It is not a preview of the workspace.</p>
</div>
</section></main>
</body>
</html>
`, 'utf8');

for (const r of refs) {
  if (r.startsWith('/enquiry') || r.startsWith('/owner')) continue;
  const direct = join(OUT_DIR, r.replace(/^\//, ''));
  const asDir = join(direct, 'index.html');
  const exists = async (f) => { try { await readFile(f); return true; } catch { return false; } };
  if (!(await exists(direct)) && !(await exists(asDir))) problems.push(`the page references ${r}, which is not beside it`);
}

console.log(`wrote ${join(OUT_DIR, 'index.html')} (${html.length} bytes) | referenced: ${refs.join(', ') || 'nothing'}`);
if (problems.length) { console.error(`STATIC EXPORT FAILED:\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('static export self-checks passed: no submission target, no enabled field, all references present');
