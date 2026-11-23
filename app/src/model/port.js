// The model port. One method, on purpose: the pipeline asks a model to answer a prompt and
// nothing else. Providers are interchangeable behind it; nothing in the app knows whether
// the answer came from a hosted API, a local Ollama, or an OCR helper.

/**
 * @typedef {Object} ModelAnswer
 * @property {boolean} ran           true ONLY if a provider was actually called and answered
 * @property {string}  provider      which provider answered or refused
 * @property {string}  [text]        raw provider output, still untrusted
 * @property {string}  [finishReason]
 * @property {string}  reason        why it did not run, when ran === false
 * @property {string}  [detail]
 */

/**
 * @typedef {Object} ModelPort
 * @property {string} name
 * @property {(args:{prompt:string, signal?:AbortSignal, maxOutputTokens?:number})=>Promise<ModelAnswer>} complete
 * @property {()=>boolean} configured   honest: can this provider actually run right now?
 */

export const REFUSE = {
  DISABLED: 'model_disabled',
  NO_PROVIDER: 'no_provider_selected',
  NO_CREDENTIAL: 'credential_missing',
  INSECURE_ENDPOINT: 'endpoint_not_https',
  BUDGET: 'call_budget_exhausted',
  TIMEOUT: 'timed_out',
  PROVIDER_ERROR: 'provider_error',
  NOT_IN_PROTOTYPE: 'prototype_mode',
};

export function assertModelPort(p) {
  if (typeof p?.complete !== 'function') throw new Error('model provider is missing complete()');
  if (typeof p?.configured !== 'function') throw new Error('model provider is missing configured()');
  if (typeof p?.name !== 'string' || !p.name) throw new Error('model provider needs a name');
  return p;
}

export const refused = (provider, reason, detail) => ({ ran: false, provider, reason, ...(detail ? { detail } : {}) });
