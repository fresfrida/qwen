// The one use case: take what the visitor sent, decide honestly whether it is saved.
// It knows nothing about HTTP and nothing about which adapter is plugged in.

import { validateSubmission, FIELDS } from './form.js';
import { checkUpload, safeDisplayName } from './uploads.js';

export const OUTCOME = {
  DEMO: 'demo',            // prototype: accepted by the UI, stored nowhere
  SAVED: 'saved',          // live: durable write confirmed by read-back
  REJECTED: 'rejected',    // the visitor's input was not valid; nothing to undo
  FAILED: 'failed',        // storage could not take it; must never be reported as success
};

const fileField = FIELDS.find((f) => f.kind === 'files');

function inspectFiles(files, config) {
  const out = [];
  for (const [i, f] of files.entries()) {
    if (!f || !f.bytes || f.bytes.length === 0) { out.push({ index: i, skipped: true, name: safeDisplayName(f?.name) }); continue; }
    const verdict = checkUpload({
      bytes: f.bytes,
      declaredType: f.type,
      declaredName: f.name,
      fieldMaxBytes: Math.min(fileField.maxFileBytes, config.maxFileBytes),
    });
    out.push({
      index: i,
      name: safeDisplayName(f.name),
      bytes: f.bytes.length,
      ok: verdict.ok,
      mediaType: verdict.mediaType ?? null,
      error: verdict.ok ? null : verdict.error,
      handle: f,
    });
  }
  return out;
}

export function createIntake({ config, submissions, assets, log = () => {} }) {
  return async function intakeSubmit({ fields, files }) {
    const { values, errors, unknown } = validateSubmission(fields);
    const checked = inspectFiles(files ?? [], config);
    const acceptedUploads = checked.filter((f) => !f.skipped && f.ok);
    const fileErrors = checked.filter((f) => f.error).map((f) => `${f.name}: ${f.error}`);
    const tooMany = acceptedUploads.length > fileField.maxFiles
      ? `Only ${fileField.maxFiles} assets can be accepted in one submission.` : null;

    if (config.mode === 'prototype') {
      // No adapter call at all. Byte counts are reported so the owner can see what *would* have
      // been kept; the content is dropped on the floor.
      log('prototype', { wouldStore: Object.keys(values).length, files: acceptedUploads.map((f) => ({ name: f.name, bytes: f.bytes })) });
      return {
        outcome: OUTCOME.DEMO,
        values,
        errors,
        fileErrors: [...fileErrors, ...(tooMany ? [tooMany] : [])],
        discardedBytes: (files ?? []).reduce((n, f) => n + (f?.bytes?.length ?? 0), 0),
        discardedFiles: checked.map((f) => ({ name: f.name, bytes: f.bytes ?? 0, mediaType: f.mediaType })),
        unknownFields: unknown,
      };
    }

    const hasFieldErrors = Object.keys(errors).length > 0;
    if (hasFieldErrors || fileErrors.length || tooMany) {
      return { outcome: OUTCOME.REJECTED, values, errors, fileErrors: [...fileErrors, ...(tooMany ? [tooMany] : [])], unknownFields: unknown };
    }

    const writtenKeys = [];
    const assetsMeta = [];
    try {
      for (const f of acceptedUploads) {
        const put = await assets.put({ bytes: f.handle.bytes, declaredType: f.handle.type, declaredName: f.handle.name });
        if (!put.stored) throw new Error(`asset: ${put.reason}`);
        writtenKeys.push(put.key);
        assetsMeta.push({ key: put.key, displayName: f.name, mediaType: put.mediaType, bytes: f.bytes });
      }

      const saved = await submissions.save({
        form: config.purpose,
        contactEmail: values.email,
        company: values.company,
        offering: values.offering,
        placement: values.placement,
        assets: assetsMeta,
      });
      if (!saved.saved) throw new Error(saved.detail ? `submissions: ${saved.detail}` : 'submissions rejected the write');

      return { outcome: OUTCOME.SAVED, id: saved.id, values, assets: assetsMeta };
    } catch (err) {
      // mid-write failure: undo what this request wrote, so no half-submission is counted as saved
      for (const k of writtenKeys) await assets.remove(k).catch(() => {});
      log('save_failed', { cause: String(err?.message ?? err) });
      return {
        outcome: OUTCOME.FAILED,
        values,
        reason: 'the studio’s storage could not accept this submission',
        cause: String(err?.message ?? err).slice(0, 200),
      };
    }
  };
}
