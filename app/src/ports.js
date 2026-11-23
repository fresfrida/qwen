// Ports: the two things this app needs from the outside world, described as contracts.
// HTTP and the use case depend on these only; swapping the disk for Postgres/S3 later means
// adding one adapter file, not touching intake/routes/page.

/**
 * @typedef {Object} SaveResult
 * @property {boolean} saved   true ONLY if the record is durably stored
 * @property {string}  [id]
 * @property {string}  reason  machine-readable cause, always present when not saved
 * @property {string}  [detail]
 */

/**
 * @typedef {Object} SubmissionStore
 * @property {(r:Record<string,unknown>)=>Promise<SaveResult>} save
 * @property {()=>Promise<Array<Record<string,unknown>>>}       list
 * @property {(id:string)=>Promise<Record<string,unknown>|null>} find
 * @property {(id:string)=>Promise<void>}                       remove
 */

/**
 * @typedef {Object} AssetResult
 * @property {boolean} stored
 * @property {string}  [key]     opaque reference, safe to store alongside the record
 * @property {string}  reason
 */

/**
 * @typedef {Object} AssetStore
 * @property {(args:{bytes:Buffer,mediaType:string,declaredName:string})=>Promise<AssetResult>} put
 * @property {(key:string)=>Promise<{bytes:Buffer,mediaType:string,storedName:string}|null>}    get
 * @property {(key:string)=>Promise<void>}                                                     remove
 * @property {ReadonlyArray<string>}                                                            acceptedMediaTypes
 */

export const SAVE = {
  PROTOTYPE_MODE: 'prototype_mode_storage_disabled',
  NOT_CONFIGURED: 'storage_not_configured',
  WRITE_FAILED: 'write_failed',
  SAVED: 'saved',
};

export function assertSubmissionStore(s) {
  for (const m of ['save', 'list', 'find', 'remove']) {
    if (typeof s?.[m] !== 'function') throw new Error(`SubmissionStore adapter is missing .${m}()`);
  }
  return s;
}

export function assertAssetStore(a) {
  for (const m of ['put', 'get', 'remove']) {
    if (typeof a?.[m] !== 'function') throw new Error(`AssetStore adapter is missing .${m}()`);
  }
  return a;
}
