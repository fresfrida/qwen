#!/usr/bin/env node
// Operator CLI for the model seam. Nothing here runs from a browser, and nothing here sends data
// anywhere unless MODE=live, MODEL_ENABLED=true, MODEL_PROVIDER is named, AND the stage's own
// approval is set. The default path prints text and makes no request.
//
//   node src/cli.js model-info
//   node src/cli.js model-stages
//   node src/cli.js model-preview research --brief examples/brief.json
//   node src/cli.js model-run    research --brief examples/brief.json
//   node src/cli.js asset-preview <assetKey> --brief examples/brief.json

import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { buildContainer } from './container.js';
import { providerNames } from './model/providers/registry.js';
import { fenceData, DATA_MARKER, collectLinks, clampTargetSeconds } from './model/pipeline.js';
import { redact } from './model/redact.js';

const [, , cmd = 'help', stage = '', ...rest] = process.argv;
const flags = Object.fromEntries(rest.filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

async function briefFromFile() {
  if (!flags.brief || flags.brief === true) throw new Error('this command needs --brief=<file.json> (see examples/brief.json)');
  const text = await readFile(String(flags.brief), 'utf8');
  const b = JSON.parse(text);
  for (const k of ['company', 'offering', 'placementLabel']) {
    if (typeof b[k] !== 'string' || !b[k].trim()) throw new Error(`${flags.brief}: ${k} must be a non-empty string`);
  }
  return b;
}

function switchboard(cfg) {
  const m = cfg.model;
  const lines = [
    `MODE                       ${cfg.mode}`,
    `MODEL_ENABLED              ${m.enabled}`,
    `MODEL_PROVIDER             ${m.provider || '(empty: nothing can be reached)'}`,
    `MODEL_ID                   ${m.modelId || '(empty)'}`,
    `MODEL_BASE_URL             ${m.baseUrl || '(provider default)'}`,
    // the key is reported as present or absent only: its length and tail are still secret material
    `MODEL_API_KEY              ${m.apiKey ? 'set (value not printed)' : '(empty)'}`,
    `MODEL_SEND_BRIEF_DATA      ${m.approvals.sendBriefData}`,
    `OCR_IMAGE_APPROVED         ${m.approvals.readUploadedAssets}`,
    `MODEL_DRY_RUN              ${m.dryRun} (${m.dryRunExplicit ? 'set explicitly' : 'default'})`,
    `MODEL_MAX_CALLS_PER_BRIEF  ${m.maxCallsPerBrief}`,
    `PROMPTS_DIR                ${m.promptsDir}`,
  ];
  const blockers = [];
  if (cfg.mode !== 'live') blockers.push('MODE is prototype: the pipeline refuses, and this is not overridable by any flag here');
  if (!m.enabled) blockers.push('MODEL_ENABLED is not true');
  if (!m.provider) blockers.push('MODEL_PROVIDER is empty');
  if (!m.approvals.sendBriefData) blockers.push('MODEL_SEND_BRIEF_DATA is not true (this is the approval that lets enquiry text leave the machine)');
  if (m.dryRun) blockers.push('MODEL_DRY_RUN is true: prompts are shown, never sent');
  return { lines, blockers, canSend: blockers.length === 0 };
}

async function main() {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { console.error(`refusing to start: ${e.message}`); process.exit(2); }
  const sw = switchboard(cfg);

  switch (cmd) {
    case 'model-info': {
      console.log(sw.lines.join('\n'));
      console.log(`\nproviders available: ${providerNames().join(', ')}`);
      console.log(`\ncan send anything? ${sw.canSend ? 'YES - every switch is set' : 'NO'}`);
      for (const b of sw.blockers) console.log(`  blocked by: ${b}`);
      return;
    }

    case 'model-stages': {
      const { prompts } = buildContainer(process.env);
      const list = await prompts.list();
      for (const [name, info] of Object.entries(list)) {
        const p = await prompts.get(name);
        console.log(`\n${name}  (${info.file})`);
        console.log(`  what it says : ${info.description}`);
        console.log(`  limits it sets: ${Object.entries(p.limits).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
        console.log(`  values needed : ${p.vars.join(', ') || 'none - visitor text arrives fenced, never interpolated'}`);
      }
      console.log('\nedit the .prompt.md files in ' + cfg.model.promptsDir + ' and restart; nothing else needs to change.');
      return;
    }

    case 'model-preview': {
      const { prompts } = buildContainer(process.env);
      const b = await briefFromFile();
      const stageName = stage || 'research';
      // each prompt gets only the values it declares; extra ones are a mistake, not a convenience
      const rendered = await prompts.render(stageName, stageName === 'script' ? { durationSeconds: clampTargetSeconds(b.targetSeconds) } : {});
      const links = collectLinks(b.sourceLinks);
      const blocks = [
        fenceData('company', b.company), fenceData('offering', b.offering), fenceData('placement option', b.placementLabel),
        fenceData('notes from the enquiry', b.notes ?? ''),
        fenceData('links the owner supplied', links.length ? links.join('\n') : '(none supplied)'),
      ];
      const prompt = [rendered.prompt, DATA_MARKER, blocks.map((x) => x.fenced).join('\n\n')].join('\n\n');
      console.log('=== THE EXACT TEXT A MODEL WOULD RECEIVE ===');
      console.log(prompt);
      console.log('\n=== NOT SENT ===');
      console.log(`stage ${stageName} | prompt file ${rendered.file} | ${Buffer.byteLength(prompt, 'utf8')} bytes | ${blocks.length} fenced blocks`);
      console.log('this command prints and exits; it does not contact a provider under any setting');
      return;
    }

    case 'model-run': {
      const c = buildContainer(process.env);
      const b = await briefFromFile();
      const ignored = Object.keys(b).filter((k) => !['company', 'offering', 'placementLabel', 'notes', 'targetLength', 'targetSeconds', 'sourceLinks', 'assetText'].includes(k));
      if (ignored.length) console.error(`note: key(s) in the brief file are not part of the pipeline input and were not sent: ${ignored.join(', ')}`);
      const links = collectLinks(b.sourceLinks);
      if (!sw.canSend) {
        console.error('refusing to run: not every switch is set.');
        for (const x of sw.lines) console.error('  ' + x);
        for (const x of sw.blockers) console.error('  BLOCKER ' + x);
        process.exit(3);
      }
      console.error(`sending ${stage} stage to ${cfg.model.baseUrl || cfg.model.provider} ...`);
      const res = await c.modelPipeline.run({ brief: b, sourceLinks: links });
      if (!res.ok) {
        const o = res.outcome ?? {};
        console.error(`\nNOT OK: stage ${res.stage}${res.reason ? ` (${res.reason})` : ''}`);
        console.error(`  reason: ${redact(o.rejectReason ?? o.reason ?? '')} ${o.detail ? `| ${redact(o.detail)}` : ''}`);
        console.error(`  provider ${o.provider ?? cfg.model.provider}, prompt ${o.promptFile ?? '?'}, ${o.promptBytes ?? '?'} bytes, nothing was stored`);
        process.exit(4);
      }
      console.log(JSON.stringify(res, null, 2));
      console.error(`\nsimulated=${res.simulated} reviewRequired=${res.reviewRequired} providers=${res.providers.join(',')}`);
      console.error(res.note);
      return;
    }

    case 'asset-preview': {
      const c = buildContainer(process.env);
      const b = await briefFromFile();
      const ignored = Object.keys(b).filter((k) => !['company', 'offering', 'placementLabel', 'notes', 'targetLength', 'targetSeconds', 'sourceLinks', 'assetText'].includes(k));
      if (ignored.length) console.error(`note: key(s) in the brief file are not part of the pipeline input and were not sent: ${ignored.join(', ')}`);
      if (!c.reader.configured()) { console.error('no asset reader configured (MEDIA_READ_SCRIPT)'); process.exit(2); }
      const plan = await c.reader.preview(`./data/assets/${stage}`, JSON.stringify(b));
      console.log(JSON.stringify(plan, null, 2));
      console.log('\nprinted only; nothing was read or sent. Re-running with OCR_IMAGE_APPROVED=true and MODE=live would send that file.');
      return;
    }

    default:
      console.log(`model commands:
  model-info                 every switch and what still blocks a send
  model-stages               the prompt files, their limits and their variables
  model-preview <stage> --brief <file.json>   the exact prompt text, never sent
  model-run <stage> --brief <file.json>       needs live + enabled + provider + approval
  asset-preview <assetKey> --brief <file.json>  what an upload reading would send`);
  }
}

main().catch((e) => { console.error(`error: ${redact(e.message ?? e)}`); process.exit(1); });
