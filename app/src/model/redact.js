// Keys must not be able to reach a log, an error message, or a prompt. This is a belt-and-braces
// layer: callers should never pass a secret into these paths in the first place.

import { createHash } from 'node:crypto';

export const promptSha = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

export function redact(text, extraSecrets = []) {
  let out = String(text ?? '');
  for (const s of extraSecrets.filter((x) => typeof x === 'string' && x.length >= 6)) out = out.split(s).join('[redacted]');
  out = out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1[redacted]')
    .replace(/\b(sk|pk|api[-_]?key|authorization|token|secret|password)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, 'sk-[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  return out.slice(0, 300);
}
