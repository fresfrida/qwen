// Composition root: the only file that knows which adapters exist.
// Moving storage from disk to Postgres/S3 is an edit here and one new adapter - routes and the
// use case never learn the difference.

import { loadConfig } from './config.js';
import { assertSubmissionStore, assertAssetStore } from './ports.js';
import { createPrototypeSubmissionStore, createPrototypeAssetStore } from './adapters/prototypeStores.js';
import { createFileSubmissionStore } from './adapters/fileSubmissionStore.js';
import { createFileAssetStore } from './adapters/fileAssetStore.js';
import { createIntake } from './intake.js';
import { createPromptCatalog } from './model/prompts.js';
import { createModelProvider } from './model/providers/registry.js';
import { createAssetReader } from './model/assetReader.js';
import { createPipeline } from './model/pipeline.js';
import { loadLayout } from './page.js';
import { ACCEPTED } from './uploads.js';
import { createFilmStore } from './studio/store.js';
import { createStudioPipeline } from './studio/pipeline.js';
import { resolveCapabilities } from './studio/generation.js';
import { createStudioRoutes } from './studio/api.js';
import * as studioView from './studio/view.js';

export function buildContainer(env = process.env) {
  const config = loadConfig(env);

  // prototype mode is not "live with a flag ignored": the live adapters are never constructed,
  // so there is no code path from a request to a disk write.
  const submissions = config.mode === 'live'
    ? createFileSubmissionStore(config.dataDir)
    : createPrototypeSubmissionStore();

  const assets = config.mode === 'live'
    ? createFileAssetStore(config.dataDir, { maxFileBytes: config.maxFileBytes })
    : createPrototypeAssetStore(ACCEPTED);

  const log = config.logToConsole === false ? () => {} : (event, data) => {
    // line-oriented and value-free: no enquiry text, no email, no file names
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`);
  };

  // Model wiring. An empty MODEL_PROVIDER resolves to 'none', whose only behaviour is to refuse;
  // nothing here opens a socket or spends a credit unless live + enabled + approved all line up.
  loadLayout(config.layoutPath);                              // one template, path decided by config
  const prompts = createPromptCatalog(config.model.promptsDir);
  const model = createModelProvider(config.model.provider || 'none', { ...config.model, echoMode: config.model.echoMode });
  const reader = createAssetReader({ ...config.model.reader, dryRun: config.model.dryRun });
  const pipelineModel = config.model.provider ? model : null;

  // The studio pipeline. Its records are the owner's own drafts, so they persist even while the
  // enquiry form is storage-less; STUDIO_PERSIST=off removes the write path entirely.
  const films = config.studio.persist ? createFilmStore(config.studio.dataDir) : null;
  const caps = resolveCapabilities({
    model: config.mode === 'live' && config.model.enabled && config.model.provider ? model : null,
    retriever: null,                        // no source-gathering tool is wired; research says so
    endpoints: config.studio.endpoints,
    clients: config.studio.media,           // empty until a documented client is written for one
    enabled: config.mode === 'live',
    maxOutputTokens: config.model.maxOutputTokens,
  });
  caps.maxPromptBytes = config.model.maxPromptBytes;
  // Only hand the pipeline the objects the caps actually claim. Passing a provider that caps says is
  // unavailable would trip the wiring guard, which is the point of the guard.
  const studio = films ? createStudioPipeline({
    config,
    store: films,
    caps,
    prompts,
    model: caps.text ? model : null,
    retriever: null,     // no source-gathering tool is wired in this build
    media: null,         // no image/video/voice/music clients are wired in this build
    log,
  }) : null;
  const studioRoutes = studio ? createStudioRoutes({
    config, store: films, pipeline: studio, caps,
    view: { index: studioView.studioIndex, film: studioView.studioFilmPage, error: studioView.viewError, unauthorized: studioView.viewUnauthorized },
  }) : null;

  return {
    config,
    films,
    studio,
    studioRoutes,
    studioCaps: caps,
    prompts,
    model,
    reader,
    modelPipeline: createPipeline({ config, prompts, model, reader: config.model.approvals.readUploadedAssets ? reader : null, log }),
    submissions: assertSubmissionStore(submissions),
    assets: assertAssetStore(assets),
    intake: createIntake({ config, submissions, assets, log }),
    log,
  };
}
