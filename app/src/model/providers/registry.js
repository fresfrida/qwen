// Provider registry. Swapping a model is one environment variable: nothing above this file knows
// a vendor's name, because the pipeline only ever calls complete()/configured().
//
//   MODEL_PROVIDER=none | echo | openai | openai-compatible | ollama
//
// 'echo' is the honest fake: it fabricates nothing, is labelled simulated everywhere, and keeps
// the test suite off the network so nothing is ever sent or spent by a test run.

import { REFUSE, refused, assertModelPort } from '../port.js';
import { createOpenAiCompatibleProvider } from './openai-compatible.js';
import { createEchoProvider } from './echo.js';

const PROVIDERS = {
  none: () => ({
    name: 'none',
    configured: () => false,
    async complete() { return refused('none', REFUSE.NO_PROVIDER, 'MODEL_PROVIDER=none, so nothing can be sent'); },
  }),
  echo: (cfg) => createEchoProvider(cfg),
  openai: (cfg) => createOpenAiCompatibleProvider({ ...cfg, label: 'openai', defaultBase: 'https://api.openai.com/v1', requiresKey: true }),
  'openai-compatible': (cfg) => createOpenAiCompatibleProvider({ ...cfg, label: 'openai-compatible', defaultBase: '', requiresKey: false }),
  ollama: (cfg) => createOpenAiCompatibleProvider({ ...cfg, label: 'ollama', defaultBase: 'http://127.0.0.1:11434/v1', requiresKey: false, localOnly: true }),
};

export const providerNames = () => Object.keys(PROVIDERS);

export function createModelProvider(name, cfg) {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`MODEL_PROVIDER "${name}" is not implemented. Available: ${providerNames().join(', ')}. Nothing was substituted.`);
  return assertModelPort(factory({ ...cfg, providerName: name }));
}
