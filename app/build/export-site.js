// Exports the public landing page exactly as the server renders it, so the design preview and the
// application can never drift apart. The owner workspace is deliberately NOT exported: it needs
// credentials, a writable store and the pipeline, none of which a static host has.

import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { renderPage, formSection } from '../src/page.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', 'site');   // the published root; nothing outside it is reachable
const config = loadConfig({ ...process.env, MODE: process.env.EXPORT_MODE ?? 'prototype' });

if (config.mode === 'live') {
  console.error('refusing to export a live page: a static host has no /enquiry to post to, so the form would lie');
  process.exit(1);
}

const html = renderPage({ config, formHtml: formSection({ config }) });

const problems = [];
if (!/MyAIStudio is a studio for original short films/.test(html)) problems.push('the approved copy is not on the exported page');
if (/Our proposed workflow/.test(html) === false) problems.push('the workflow section lost its label');
if (/<script|javascript:|onerror=|onload=/.test(html)) problems.push('the export contains script or an inline handler');
if (/(?:src|href)="https?:/.test(html)) problems.push('the export fetches from another origin');
if (/name="placement"/.test(html) === false) problems.push('the enquiry form lost its placement options');
if (/data-Studio|Studio pipeline|studioBody/.test(html)) problems.push('the studio workspace leaked onto the public page');

const refs = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
// The public page is allowed to point at the workspace - "Start a film" has to lead somewhere real -
// but only at the workspace door. A link into a specific film record would carry private data into a
// page anyone can load, and that is the thing this export must never do.
const studioRefs = refs.filter((r) => r.startsWith('/studio'));
if (studioRefs.some((r) => r !== '/studio')) problems.push(`the public page links deeper into the workspace than the door: ${studioRefs.filter((r) => r !== '/studio').join(', ')}`);
// attribute order in markup is not a contract, so find the anchor first and then read its href
const ctaTag = (html.match(/<a\b[^>]*data-cta="start-a-film"[^>]*>/) ?? [''])[0];
if (!/href="\/studio"/.test(ctaTag)) problems.push('the hero CTA no longer leads to a real creation entry point');
if (/Title pending/.test(html)) problems.push('the exported page still shows placeholder film titles');
if (!/No published films yet/.test(html)) problems.push('the stories section lost its honest empty state');

// There are two ways to write this page, and only one of them makes the form inert. This script
// emits the *application* page (enabled form, real /studio links), so running it into the preview
// root would ship controls that silently drop what you typed. The preview root belongs to
// build/render-static.js, which is what `npm run build` and verify.sh use.
const INERT_EXPORTER_ROOT = join(HERE, '..', '..', 'site');
if (process.env.EXPORT_SITE_ALLOW !== '1') {
  console.error(`export-site.js refuses to write ${INERT_EXPORTER_ROOT}: use npm run build, which also makes the form inert.\nSet EXPORT_SITE_ALLOW=1 only if you are exporting deliberately to a different directory.`);
  process.exit(2);
}
await mkdir(ROOT, { recursive: true });
for (const f of ['app.css', 'grain.svg', 'favicon.svg']) await cp(join(config.publicDir, f), join(ROOT, f));
await writeFile(join(ROOT, 'index.html'), html, 'utf8');

// The page links to /studio, so the published root has to answer that address with something true.
// A static export cannot run the studio: there is no storage, no sign-in, and no pipeline here. So
// this page says exactly that instead of pretending to be the workspace or showing a fake form.
await mkdir(join(ROOT, 'studio'), { recursive: true });
await writeFile(join(ROOT, 'studio', 'index.html'), `<!DOCTYPE html>
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

// every same-origin reference must resolve next to the file being published
for (const r of refs) {
  // a directory path resolves if the host would find an index inside it
  const candidates = [join(ROOT, r.slice(1)), join(ROOT, r.slice(1), 'index.html')];
  const exists = async (f) => { try { await readFile(f); return true; } catch { return false; } };
  if (!(await exists(candidates[0]) || await exists(candidates[1]))) { problems.push(`page references ${r}, which is not in the published root`); }
}

const counts = {
  cards: (html.match(/class="card"/g) ?? []).length,
  unfilled: (html.match(/Title pending/g) ?? []).length,
  placementOptions: (html.match(/name="placement"/g) ?? []).length,
};
if (counts.cards !== counts.unfilled) problems.push(`story grid drift: ${counts.cards} cards, ${counts.unfilled} marked unfilled`);
if (counts.placementOptions !== 3) problems.push(`placement question has ${counts.placementOptions} options, expected 3`);

console.log(`exported ${join(ROOT, 'index.html')} | mode=${config.mode} | references: ${refs.join(', ') || 'none'}`);
console.log(`cards ${counts.cards}/${counts.unfilled} unfilled | placement options ${(html.match(/name="placement"/g) ?? []).length} | scripts ${(html.match(/<script/g) ?? []).length}`);
if (problems.length) { console.error(`EXPORT FAILED:\n  - ${problems.join('\n  - ')}`); process.exit(1); }
console.log('export self-checks passed: copy intact, no script, no external origin, no link deeper than the workspace door');
