// Configuration boundary: env in, typed config out. Fails closed and loudly.
// Nothing else in the app reads process.env, and no other module guesses where files live:
// relative paths are resolved here, against the app directory, so cwd does not change behaviour.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const hereOr = (p) => (p.startsWith('/') ? p : join(APP_ROOT, p));

const MODES = ['prototype', 'live'];
const PURPOSES = ['brand_enquiries']; // only the chosen purpose is implemented; others must fail, not fall back
const bool = (v, d = false) => (v === undefined || v === '' ? d : v === 'true');

function required(name, env) {
  const v = (env[name] ?? '').trim();
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}

// some knobs are legitimately zero (no artificial delay), which intOr must not accept
function int0r(value, fallback, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be zero or a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

function intOr(value, fallback, name) {
  const n = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

export function loadConfig(env = process.env) {
  const mode = (env.MODE ?? 'prototype').trim();
  if (!MODES.includes(mode)) throw new Error(`MODE must be one of ${MODES.join('|')} (got "${mode}")`);

  const purpose = (env.FORM_PURPOSE ?? 'brand_enquiries').trim();
  if (!PURPOSES.includes(purpose)) {
    throw new Error(`FORM_PURPOSE "${purpose}" is not implemented. Implemented: ${PURPOSES.join(', ')}. Nothing was substituted.`);
  }

  const port = Number(env.PORT ?? 3000);
  // 0 is valid and means "any free port" (tests, some local setups); anything else must be real.
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`PORT invalid: ${env.PORT}`);

  const cfg = {
    mode,
    purpose,
    port,
    dataDir: hereOr((env.DATA_DIR ?? 'data').trim()),
    layoutPath: hereOr((env.LAYOUT_FILE ?? 'public/layout.html').trim()),
    publicDir: hereOr((env.PUBLIC_DIR ?? 'public').trim()),
    maxFields: intOr(env.MAX_FIELDS, 30, 'MAX_FIELDS'),
    maxFieldBytes: intOr(env.MAX_FIELD_BYTES, 32 * 1024, 'MAX_FIELD_BYTES'),
    maxFiles: intOr(env.MAX_FILES, 5, 'MAX_FILES'),
    maxFileBytes: intOr(env.MAX_FILE_BYTES, 25 * 1024 * 1024, 'MAX_FILE_BYTES'),
    maxTotalRequestBytes: intOr(env.MAX_REQUEST_BYTES, 100 * 1024 * 1024, 'MAX_REQUEST_BYTES'),
    // prototype must be incapable of persisting; these are only consulted when mode === 'live'
    ownerUser: mode === 'live' ? required('OWNER_USER', env) : null,
    ownerPass: mode === 'live' ? required('OWNER_PASS', env) : null,
    trustProxy: env.TRUST_PROXY === 'true',
    model: loadModelConfig(env, mode),
    studio: loadStudioConfig(env, mode),
  };

  if (mode === 'live' && cfg.ownerPass.length < 12) {
    throw new Error('OWNER_PASS must be at least 12 characters for a public-facing deployment');
  }
  return cfg;
}

// Model wiring is deliberately fail-closed: no default provider, no default endpoint, no
// inherited key, and two separate approvals before anything can leave the machine.
function loadModelConfig(env, mode) {
  const provider = (env.MODEL_PROVIDER ?? '').trim();
  const maxCalls = intOr(env.MODEL_MAX_CALLS_PER_BRIEF, 3, 'MODEL_MAX_CALLS_PER_BRIEF');
  if (env.MODEL_API_KEY && !provider) throw new Error('MODEL_API_KEY is set but MODEL_PROVIDER is empty; name the provider instead of letting a key sit unused');
  const m = {
    provider,
    enabled: bool(env.MODEL_ENABLED),
    // dryRun defaults on: an unset MODEL_DRY_RUN shows you the prompt rather than spending.
    dryRun: bool(env.MODEL_DRY_RUN, true),
    dryRunExplicit: env.MODEL_DRY_RUN !== undefined && env.MODEL_DRY_RUN !== '',
    // approvals are env-for-env with the thing they authorise; neither implies the other
    approvals: {
      sendBriefData: bool(env.MODEL_SEND_BRIEF_DATA),
      readUploadedAssets: bool(env.OCR_IMAGE_APPROVED),
    },
    baseUrl: (env.MODEL_BASE_URL ?? '').trim(),
    apiKey: env.MODEL_API_KEY ?? '',
    modelId: (env.MODEL_ID ?? '').trim(),
    temperature: env.MODEL_TEMPERATURE === undefined ? 0.2 : Number(env.MODEL_TEMPERATURE),
    maxOutputTokens: intOr(env.MODEL_MAX_OUTPUT_TOKENS, 1200, 'MODEL_MAX_OUTPUT_TOKENS'),
    timeoutMs: intOr(env.MODEL_TIMEOUT_MS, 30000, 'MODEL_TIMEOUT_MS'),
    maxCallsPerBrief: maxCalls,
    promptsDir: hereOr((env.PROMPTS_DIR ?? 'prompts').trim()),
    layoutFile: (env.LAYOUT_FILE ?? 'public/layout.html').trim(),
    reader: {
      // unset means "this build has no asset reader"; the sandbox's helper is not reached by surprise
      script: (env.MEDIA_READ_SCRIPT ?? '').trim(),
      python: (env.MEDIA_READ_PYTHON ?? 'python3').trim(),
      approved: bool(env.OCR_IMAGE_APPROVED),
      timeoutMs: intOr(env.OCR_TIMEOUT_MS, 120000, 'OCR_TIMEOUT_MS'),
      maxImageBytes: intOr(env.OCR_MAX_IMAGE_BYTES, 8 * 1024 * 1024, 'OCR_MAX_IMAGE_BYTES'),
      // where an upload would go, and which credential names exist there. Values are never copied.
      egressHost: String(env.QW_API_BASE_URL ?? 'the sandbox document-reading endpoint').replace(/^https?:\/\//, '').split('/')[0],
      credentialNamesPresent: ['QWENWORK_ROUTER_API_KEY', 'MULEROUTER_API_KEY'].filter((k) => env[k]),
      // the child process gets exactly these, decided here rather than sniffed at call time
      childEnv: { PATH: (env.PATH ?? '/usr/local/bin:/usr/bin:/bin'), HOME: (env.HOME ?? '/tmp') },
      credentialEnv: Object.fromEntries(['QWENWORK_ROUTER_API_KEY', 'MULEROUTER_API_KEY', 'QW_API_BASE_URL'].filter((k) => env[k]).map((k) => [k, env[k]])),
    },
    maxPromptBytes: intOr(env.MODEL_MAX_PROMPT_BYTES, 64 * 1024, 'MODEL_MAX_PROMPT_BYTES'),
    echoMode: (env.ECHO_MODE ?? 'empty').trim(),
  };
  if (!Number.isFinite(m.temperature) || m.temperature < 0 || m.temperature > 2) throw new Error(`MODEL_TEMPERATURE must be 0..2, got ${env.MODEL_TEMPERATURE}`);
  if (m.enabled && !provider) throw new Error('MODEL_ENABLED=true but MODEL_PROVIDER is empty; name the provider instead of defaulting to one');
  if (m.dryRunExplicit && m.dryRun && m.approvals.sendBriefData) {
    throw new Error('MODEL_DRY_RUN=true together with MODEL_SEND_BRIEF_DATA=true: one says show me, the other says send it. Set MODEL_DRY_RUN=false to accept sending.');
  }
  if (mode === 'prototype' && (m.approvals.sendBriefData || m.approvals.readUploadedAssets)) throw new Error('approval flags are set while MODE=prototype; prototype cannot send anything, so unset the approvals instead of relying on mode to overrule them');
  return m;
}

// The studio pipeline is the owner's own workspace. Its records are draft film state the owner
// created, not a visitor's submission, so they are allowed to persist while MODE=prototype keeps
// the *enquiry form* from saving anything. STUDIO_PERSIST=off freezes it completely.
function loadStudioConfig(env, mode) {
  const capsEnv = {
    images: (env.GEN_IMAGES_ENDPOINT ?? '').trim(),
    video: (env.GEN_VIDEO_ENDPOINT ?? '').trim(),
    voice: (env.GEN_VOICE_ENDPOINT ?? '').trim(),
    music: (env.GEN_MUSIC_ENDPOINT ?? '').trim(),
    retrieval: (env.SEARCH_ENDPOINT ?? '').trim(),
  };
  const configured = Object.values(capsEnv).filter(Boolean).length;
  if (configured && mode !== 'live') {
    throw new Error(`generation endpoints are set while MODE=${mode}; the pipeline would be in real mode with enquiry storage disabled. Set MODE=live or unset the GEN_* / SEARCH_ENDPOINT vars.`);
  }
  const st = {
    persist: bool(env.STUDIO_PERSIST, true),
    dataDir: hereOr((env.STUDIO_DATA_DIR ?? 'data').trim()),
    maxCallsPerFilm: intOr(env.STUDIO_MAX_CALLS_PER_FILM, 6, 'STUDIO_MAX_CALLS_PER_FILM'),
    demoStageDelayMs: int0r(env.STUDIO_DEMO_STAGE_DELAY_MS, 0, 'STUDIO_DEMO_STAGE_DELAY_MS'),
    maxBodyBytes: intOr(env.STUDIO_MAX_BODY_BYTES, 128 * 1024, 'STUDIO_MAX_BODY_BYTES'),
    // an endpoint without a client is a refusal, never a guessed API shape
    media: {},
    endpoints: capsEnv,
    pollMs: intOr(env.STUDIO_POLL_INTERVAL_MS, 2000, 'STUDIO_POLL_INTERVAL_MS'),
  };
  if (st.demoStageDelayMs > 60_000) throw new Error('STUDIO_DEMO_STAGE_DELAY_MS above 60000 is not a test pace, it is a stall');
  return st;
}

export const isLive = (cfg) => cfg.mode === 'live';
