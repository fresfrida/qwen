// Prompt loading and rendering. The prompt text itself lives in ../prompts/*.md so it can be read
// and edited without touching code; this file only checks that what you edited is still sound.
//
// A prompt file is:
//   ---
//   stage: research
//   vars: company, offering, placementLabel, sourceHints
//   ---
//   <the instruction the model sees>
//
// Declaring vars is what makes an edit safe: a renamed or missing variable fails here, at load,
// instead of silently sending half the brief and inventing the rest.

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';

const NAME = /^[a-z][a-z0-9_-]{0,40}$/;
const DATA_TOKEN_RE = /=== UNTRUSTED ENQUIRY DATA ===/g;
const VAR = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;

export function parsePromptFile(text, label) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${label}: missing the --- front matter block (the file must declare stage and vars)`);
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const stage = fm.stage;
  if (!NAME.test(String(stage ?? ''))) throw new Error(`${label}: stage must be a simple name, got ${JSON.stringify(fm.stage)}`);
  // limits are declared here so the prompt text AND the code enforcement read the same number.
  // Editing "maxClaims=6" changes what the model is told and what validateResearch will accept.
  const limits = {};
  for (const entry of (fm.limits ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m2 = /^([A-Za-z][A-Za-z0-9_]{0,30})=(\d{1,6})$/.exec(entry);
    if (!m2) throw new Error(`${label}: limit ${JSON.stringify(entry)} must look like maxClaims=6`);
    if (limits[m2[1]]) throw new Error(`${label}: limit ${m2[1]} declared twice`);
    limits[m2[1]] = Number(m2[2]);
    if (limits[m2[1]] < 1) throw new Error(`${label}: limit ${m2[1]} must be positive`);
  }
  const vars = (fm.vars ?? '').split(',').map((s) => s.trim()).filter(Boolean);   // values the caller must supply
  for (const v of vars) if (!VAR.test(v)) throw new Error(`${label}: bad variable name ${JSON.stringify(v)}`);
  for (const v of vars) if (limits[v] !== undefined) throw new Error(`${label}: ${v} is both a var and a limit; a limit comes from the file, a var comes from the caller`);
  const body = m[2].trim();
  if (!body) throw new Error(`${label}: the instruction part is empty`);
  const known = new Set([...vars, ...Object.keys(limits)]);
  const used = [...body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((x) => x[1]);
  const undeclared = used.filter((v) => !known.has(v));
  if (undeclared.length) throw new Error(`${label}: template uses {{${undeclared.join('}}, {{')}} which is neither a declared var nor a limit`);
  const unused = [...known].filter((v) => !used.includes(v));
  if (unused.length) throw new Error(`${label}: declares ${unused.join(', ')} but never uses {{name}} for it. An unused limit silently stops being enforced, so delete it or use it.`);

  const markerCount = (body.match(/=== UNTRUSTED ENQUIRY DATA ===/g) ?? []).length;
  if (markerCount > 0) throw new Error(`${label}: the data marker is placed by the pipeline, so do not write it in the prompt file`);
  return { stage, vars, limits, body, label, notes: fm.description ?? null, approval: fm.approval ?? null };
}

export function createPromptCatalog(dir) {
  const cache = new Map();

  async function loadAll() {
    if (cache.size) return cache;
    let names;
    try { names = await readdir(dir); } catch (e) { throw new Error(`prompt directory ${dir} is unreadable: ${e.code || e.message}`); }
    // only *.prompt.md are prompts, so notes and README files can live beside them safely
    const files = names.filter((n) => n.endsWith('.prompt.md'));
    if (!files.length) throw new Error(`no *.prompt.md files found in ${dir}`);
    for (const f of files) {
      const p = parsePromptFile(await readFile(join(dir, f), 'utf8'), f);
      if (cache.has(p.stage)) throw new Error(`${f}: another file already declares stage "${p.stage}" - one prompt per stage, no silent winner`);
      if (p.label !== f) throw new Error(`${f}: file name should be ${p.stage}.prompt.md so the name and the declared stage agree`);
      cache.set(p.stage, p);
    }
    return cache;
  }

  return {
    dir,
    async stages() { return [...(await loadAll()).keys()].sort(); },
    async get(stage) {
      const all = await loadAll();
      if (!all.has(stage)) throw new Error(`no prompt declares stage "${stage}". Present: ${[...all.keys()].join(', ')}`);
      return all.get(stage);
    },
    async list() { return Object.fromEntries([...(await loadAll())].map(([k, v]) => [k, { file: v.label, vars: v.vars, description: v.notes }])); },
    /** Returns the rendered instruction text and the exact variable values that went in. */
    async render(stage, values) {
      const prompts = await loadAll();
      const p = prompts.get(stage);
      if (!p) throw new Error(`no prompt file declares stage "${stage}". Present: ${[...prompts.keys()].join(', ')}`);
      const out = { ...p.limits };                      // limits are always available as {{name}}
      for (const v of p.vars) {
        const raw = values[v];
        if (typeof raw !== 'string') throw new Error(`${p.label}: value for ${v} is ${raw === undefined ? 'missing' : typeof raw} - refusing to render "undefined" into a prompt`);
        if (raw.length > 20000) throw new Error(`${p.label}: ${v} is ${raw.length} chars, which looks like a mistake rather than a brief`);
        out[v] = raw;
      }
      const extras = Object.keys(values).filter((k) => !p.vars.includes(k));
      if (extras.length) throw new Error(`${p.label}: caller supplied ${extras.join(', ')} which the prompt does not declare. Editing a prompt must not leave a value stranded.`);
      let text = p.body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, v) => out[v]);
      if (/\{\{/.test(text)) throw new Error(`${p.label}: a {{placeholder}} survived rendering`);
      // Values are passed through verbatim on purpose. Containing them is the fence's job;
      // escaping them here would corrupt the brief and hide what the model actually saw.
      return { stage, file: p.label, prompt: text, used: out, vars: p.vars, limits: p.limits, approval: p.approval };
    },
  };
}
