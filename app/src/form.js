// Single source of truth for the brand enquiries form.
// The renderer, the validator and the stored record are all derived from this one definition,
// so a field cannot be added to the page but forgotten on the server.

import { checkEmail, checkText } from './validate.js';

export const PURPOSE = 'brand_enquiries';

// Three placement options, taken from the platforms already named in the approved copy.
export const PLACEMENT_OPTIONS = [
  { value: 'tiktok_short', label: 'A TikTok short' },
  { value: 'youtube_short', label: 'A YouTube Shorts film' },
  { value: 'instagram_reel', label: 'An Instagram Reel' },
];

export const FIELDS = [
  { name: 'company', kind: 'text', label: 'Company name', required: true, max: 200 },
  { name: 'offering', kind: 'textarea', label: 'Product or service', required: true, max: 2000, help: 'What the product or service is, in plain terms.' },
  { name: 'placement', kind: 'radio', label: 'What would you like it to be part of?', required: true, options: PLACEMENT_OPTIONS },
  { name: 'email', kind: 'email', label: 'Work email', required: true, max: 254 },
  { name: 'assets', kind: 'files', label: 'Assets (optional)', required: false, maxFiles: 5, maxFileBytes: 25 * 1024 * 1024,
    accept: ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/quicktime', 'application/pdf'],
    help: 'Logo, product photo, packshot, clip or brief. Nothing is uploaded while this preview is in demo mode.' },
];

export const fieldByName = (name) => FIELDS.find((f) => f.name === name);
export const placementLabel = (value) => PLACEMENT_OPTIONS.find((o) => o.value === value)?.label ?? null;

// Reject anything not described by the schema: no silent extra fields reaching storage.
export function validateSubmission(body) {
  const values = {};
  const errors = {};

  for (const f of FIELDS) {
    if (f.kind === 'files') continue;
    const raw = Array.isArray(body[f.name]) ? body[f.name][0] : body[f.name];
    const value = typeof raw === 'string' ? raw : '';

    if (!value.trim()) {
      if (f.required) errors[f.name] = `${f.label} is required.`;
      else values[f.name] = '';
      continue;
    }
    if (f.kind === 'email') {
      const r = checkEmail(value, f.max);
      if (r.ok) values.email = r.value; else errors.email = r.error;
    } else if (f.kind === 'radio') {
      const chosen = value.trim();
      if (!placementLabel(chosen)) errors[f.name] = `Choose one of the listed options for ${f.label.toLowerCase()}.`;
      else values[f.name] = chosen;
    } else {
      const r = checkText(value, { max: f.max, multiline: f.kind === 'textarea' });
      if (r.ok) values[f.name] = r.value; else errors[f.name] = r.error;
    }
  }

  // unknown keys are dropped, never persisted
  const unknown = Object.keys(body || {}).filter((k) => !FIELDS.some((f) => f.name === k));
  return { ok: Object.keys(errors).length === 0, values, errors, unknown };
}
