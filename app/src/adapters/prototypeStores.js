// Prototype adapter: the only thing it can do is refuse. It holds no path, no client, no key,
// so "prototype mode saved nothing" is a property of the object graph, not of an if-statement.

import { SAVE } from '../ports.js';

export function createPrototypeSubmissionStore() {
  return {
    async save() {
      return { saved: false, reason: SAVE.PROTOTYPE_MODE };
    },
    async list() { return []; },
    async find() { return null; },
    async remove() { /* nothing was ever written */ },
    kind: 'prototype',
  };
}

export function createPrototypeAssetStore(acceptedMediaTypes) {
  return {
    async put() { return { stored: false, reason: SAVE.PROTOTYPE_MODE }; },
    async get() { return null; },
    async remove() { },
    acceptedMediaTypes: Object.freeze([...acceptedMediaTypes]),
    kind: 'prototype',
  };
}
