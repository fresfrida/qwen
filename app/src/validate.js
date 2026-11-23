// Pure, dependency-free validation helpers. No fs, no network.

export function normalize(v) {
  return typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : '';
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069\uFEFF]/;

export function checkText(raw, { max = 2000, multiline = false, label = 'This field' } = {}) {
  let v = normalize(raw).trim();
  if (CONTROL.test(v)) return { ok: false, error: `${label} contains characters that cannot be stored.` };
  if (!multiline) v = v.replace(/\s+/g, ' ');   // one line, one meaning: no newline forgery in single-line fields
  if (v.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer (this one is ${v.length}).` };
  return { ok: true, value: v };
}

// Practical, not RFC-complete: we only need a reachable work address, never a script or a header injection.
const EMAIL = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9](\.[A-Za-z]{2,})+$/;

export function checkEmail(raw, max = 254) {
  const v = normalize(raw).trim();
  if (v.length > max) return { ok: false, error: `Work email must be ${max} characters or fewer.` };
  if (CONTROL.test(v)) return { ok: false, error: 'Work email contains characters that cannot be stored.' };
  if (!EMAIL.test(v)) return { ok: false, error: 'Enter a work email address, for example name@company.com.' };
  return { ok: true, value: v };
}

// A solidus is NOT escaped: it is inert in HTML text and in a quoted attribute, and escaping it
// silently corrupted accept="image/png,..." on the first run of these checks.
// A solidus and a backslash are deliberately NOT escaped: they are inert inside HTML text and
// quoted attributes, and a first attempt that mapped them through this table silently turned
// accept="image/png" into accept="imageundefinedpng". Verify against the rendered value, not the map.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;', '=': '&#61;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"'`=]/g, (c) => ESCAPES[c] ?? c);

// Values are stored raw and escaped at render time. The one thing stored text must never do is
// carry a line break that would forge a row, since live logs are line-oriented.
export const logSafe = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 120);
