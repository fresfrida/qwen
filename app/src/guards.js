// Request guards: authentication and rate limiting. Both fail closed.

import { timingSafeEqual, createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();

function steadyEqual(a, b) {
  const ha = sha(a), hb = sha(b);          // hash first so differing lengths do not leak
  return timingSafeEqual(ha, hb);
}

/**
 * Owner-only. No credentials configured -> every owner request is refused, and the caller is
 * told why in the response it can see, rather than being served an empty "private" page.
 * @returns {{ok:boolean, reason?:string}}
 */
export function checkOwnerAuth(req, cfg) {
  if (cfg.mode !== 'live') return { ok: false, reason: 'prototype_mode' };
  if (!cfg.ownerUser || !cfg.ownerPass) return { ok: false, reason: 'not_configured' };

  const header = String(req.headers.authorization ?? '');
  if (!/^Basic /i.test(header)) return { ok: false, reason: 'no_credentials' };
  let user, pass;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i < 0) return { ok: false, reason: 'malformed' };
    user = decoded.slice(0, i);
    pass = decoded.slice(i + 1);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const userOk = steadyEqual(user, cfg.ownerUser);
  const passOk = steadyEqual(pass, cfg.ownerPass);
  return userOk && passOk ? { ok: true } : { ok: false, reason: 'bad_credentials' };
}

export const authChallenge = (realm = 'MyAIStudio owner') => `Basic realm="${realm}", charset="UTF-8"`;

/**
 * Smallest thing that stops one visitor filling the disk: a per-key fixed window in memory.
 * One process only; multi-instance deployments need the shared limit in front of it (README).
 */
export function createLimiter({ windowMs, max }) {
  const hits = new Map();
  return function allow(key) {
    const now = Date.now();
    const bucket = hits.get(key);
    if (!bucket || bucket.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 5000) for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
      return { allowed: true };
    }
    bucket.count += 1;
    return bucket.count <= max ? { allowed: true } : { allowed: false, retryAfterMs: bucket.reset - now };
  };
}

export function clientKey(req, trustProxy) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
  return fwd || req.socket.remoteAddress || 'unknown';
}
