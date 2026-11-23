// Type is decided by the bytes, never by the name or the browser's claim.
// SVG is deliberately absent: an SVG can carry a script, which is exactly how an "image" upload
// becomes executed code on the owner's screen.

const TYPES = [
  { mediaType: 'image/png', ext: 'png', maxBytes: 25 * 1024 * 1024, test: (b) => b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: 'image/jpeg', ext: 'jpg', maxBytes: 25 * 1024 * 1024, test: (b) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mediaType: 'image/webp', ext: 'webp', maxBytes: 25 * 1024 * 1024, test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mediaType: 'video/mp4', ext: 'mp4', maxBytes: 100 * 1024 * 1024, test: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(b.subarray(8, 12).toString('latin1')) },
  { mediaType: 'video/quicktime', ext: 'mov', maxBytes: 100 * 1024 * 1024, test: (b) => b.length > 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1') === 'qt  ' },
  { mediaType: 'application/pdf', ext: 'pdf', maxBytes: 25 * 1024 * 1024, test: (b) => b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-' },
];

export const ACCEPTED = Object.freeze(TYPES.map((t) => t.mediaType));

export function maxBytesFor(mediaType) {
  return TYPES.find((t) => t.mediaType === mediaType)?.maxBytes ?? 0;
}

/** @returns {{mediaType:string,ext:string}|null} */
export function sniff(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const hit = TYPES.find((t) => t.test(buffer) && buffer.length <= t.maxBytes);
  if (!hit) return null;
  return { mediaType: hit.mediaType, ext: hit.ext, maxBytes: hit.maxBytes };   // carry the cap out with the type
}

/**
 * Both must agree, and both must be on the allowlist.
 * A browser that claims image/png while sending something else is rejected, not trusted.
 */
export function checkUpload({ bytes, declaredType, declaredName, fieldMaxBytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, error: 'empty file' };
  const real = sniff(bytes);
  if (!real) return { ok: false, error: 'unrecognised file type (the bytes, not the name, decide)' };
  if (!ACCEPTED.includes(real.mediaType)) return { ok: false, error: `type ${real.mediaType} is not accepted` };
  if (declaredType && declaredType !== 'application/octet-stream' && declaredType !== real.mediaType) {
    return { ok: false, error: `browser declared ${declaredType} but the bytes are ${real.mediaType}` };
  }
  const declaredCap = Number.isSafeInteger(fieldMaxBytes) && fieldMaxBytes > 0 ? fieldMaxBytes : real.maxBytes;
  const cap = Math.min(real.maxBytes, declaredCap);
  if (!Number.isSafeInteger(cap) || cap <= 0) return { ok: false, error: 'no usable size limit for this type' };
  if (bytes.length > cap) return { ok: false, error: `file is larger than ${cap} bytes` };
  if (typeof declaredName === 'string' && declaredName.length > 300) return { ok: false, error: 'file name too long' };
  return { ok: true, mediaType: real.mediaType, ext: real.ext };
}

// The owner's saved listing may show what the visitor called the file. That string is untrusted:
// it must not carry a path, control characters, or markup.
export function safeDisplayName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001F\u007F\u202A-\u202E]/g, '').replace(/[<>"'`&;/]/g, '_').replace(/\.+/g, '.').trim().replace(/^\.+/, '');
  return (clean || 'asset').slice(0, 120);
}
