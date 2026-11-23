import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createFilmStore } from './src/studio/store.js';
import { createStudioPipeline } from './src/studio/pipeline.js';
import { resolveCapabilities } from './src/studio/generation.js';
import { createPromptCatalog } from './src/model/prompts.js';
import { validateBriefInput } from './src/studio/brief.js';
const P = new URL('./prompts/', import.meta.url).pathname;
const IDEAS = { mode: 'bring_me_ideas', title: '', premise: '', notes: 'calm', targetLength: '', links: [] };
const mk = (o = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-')); const store = createFilmStore(dir);
  const model = o.model ?? null;
  const retriever = o.retrieve ? { name: 'fake-retrieval', configured: () => true, retrieve: o.retrieve } : null;
  const caps = resolveCapabilities({ model: o.enabled ? model : null, retriever: o.enabled ? retriever : null, endpoints: {}, clients: {}, enabled: o.enabled, maxOutputTokens: 100 });
  caps.maxPromptBytes = 65536;
  const pipeline = createStudioPipeline({ config: { mode: o.mode ?? 'live', studio: { demoStageDelayMs: o.delayMs ?? 0, maxCallsPerFilm: o.maxCalls ?? 6, media: {}, endpoints: {} }, model: { maxPromptBytes: 65536, maxOutputTokens: 100 } }, store, caps, prompts: createPromptCatalog(P), model: caps.text ? model : null, retriever: caps.retrieval ? retriever : null, media: null, log: () => {} });
  return { dir, store, pipeline, caps };
};
const j = (x) => JSON.stringify(x);
// A demo run
{
  const { store, pipeline, caps } = mk({ mode: 'prototype' });
  console.log('DEMO caps', caps.pipelineMode);
  const { film } = await pipeline.startFilm(validateBriefInput(IDEAS).value, 'probe-demo-1');
  const a = await pipeline.start(film.id, 'research'); console.log('research', a.ok, a.kind);
  const f1 = await store.find(film.id);
  console.log('  status', f1.stages.research.status, 'sample', f1.stages.research.sample, 'note', JSON.stringify(f1.stages.research.note).slice(0, 120));
  console.log('  output keys', Object.keys(f1.stages.research.output ?? {}));
  const b = await pipeline.start(film.id, 'concept'); const f2 = await store.find(film.id);
  console.log('concept', b.ok, '| items', f2.stages.concept.output?.items?.length, '| gate', f2.stages.gate_concept.status, '| callsUsed', f2.callsUsed);
  const g = await pipeline.start(film.id, 'script'); console.log('script before gate', g.ok, g.kind, JSON.stringify(g.error).slice(0, 90));
  const gate = await pipeline.advance(film.id); console.log('advance at gate', gate.ok, gate.kind);
}
// real with one item per stage
{
  const seen = [];
  const answers = {
    'studio-concept': JSON.stringify({ items: [{ ref: 'c1', workingTitle: 'One', oneSentenceStory: 'S1', whyItCouldWork: 'W1', mood: 'm' }, { ref: 'c2', workingTitle: 'Two', oneSentenceStory: 'S2', whyItCouldWork: 'W2', mood: 'm' }, { ref: 'c3', workingTitle: 'Three', oneSentenceStory: 'S3', whyItCouldWork: 'W3', mood: 'm' }] }),
    'studio-script': JSON.stringify({ hook: 'h', scenes: [{ n: 1, action: 'a', dialogue: 'd' }], ending: 'e' }),
    'studio-critique': JSON.stringify({ verdict: 'pass', strengths: ['s'], problems: [], notes: '' }),
    'studio-marketing': JSON.stringify({ title: 't', caption: 'c', releasePlan: [{ slot: 's', when: 'w', what: 'x', why: 'y' }] }),
  };
  const { store, pipeline } = mk({ enabled: true, model: { name: 'fake-text', modelId: 'x', configured: () => true, complete: async (a) => { seen.push(a.stage); return { ran: true, provider: 'fake-text', text: answers[a.stage] ?? '{}' }; } }, retrieve: async () => ({ ran: true, sources: [{ url: 'https://example.org/a' }] }) });
  const { film } = await pipeline.startFilm(validateBriefInput(IDEAS).value, 'probe-real-1');
  for (const k of ['research', 'concept']) { const r = await pipeline.start(film.id, k); if (!r.ok) console.log('FAIL', k, r.kind, JSON.stringify(r.error).slice(0, 140)); }
  const f = await store.find(film.id);
  console.log('REAL calls', seen.join(','), '| callsUsed', f.callsUsed, '| concept sample?', f.stages.concept.sample, '| research sources', f.stages.research.output?.sources?.length, '| generated', j(f.stages.concept.output?.generated));
  const prompt = seen.length ? null : null;
}
