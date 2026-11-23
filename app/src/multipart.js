// Request body parsing with hard caps. A malformed or oversized body must fail here rather than
// reach the use case, because that is the only place the byte count is known.

import Busboy from 'busboy';
import { escapeHtml } from './validate.js';

const MAX_KEYS = 40;

export async function readBody(req, { maxFields, maxFieldBytes, maxFiles, maxFileBytes, maxTotal }) {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  const budget = { used: 0 };
  const over = () => budget.used > maxTotal;

  if (type.startsWith('application/x-www-form-urlencoded')) {
    const raw = await readRaw(req, maxTotal, budget);
    const params = new URLSearchParams(raw);
    const fields = {}; const files = [];
    for (const [k, v] of params) {
      if (fields[k] === undefined) fields[k] = v;
      else if (Array.isArray(fields[k])) { if (fields[k].length < 10) fields[k].push(v); }
    }
    return { fields, files, errors: Object.keys(fields).length > MAX_KEYS ? ['too many fields'] : [] };
  }

  if (!type.startsWith('multipart/form-data')) {
    throw Object.assign(new Error('unsupported content type'), { status: 415 });
  }

  return await new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: { fieldNameSize: 100, fieldSize: maxFieldBytes, fields: maxFields, files: maxFiles, fileSize: maxFileBytes, headerPairs: 20 },
    });
    const fields = {};
    const files = [];
    const errors = [];
    let done = 0;
    let total = 0;

    busboy.on('field', (name, value) => {
      total += value.length;
      if (Object.keys(fields).length >= MAX_KEYS) { errors.push('too many fields'); return; }
      if (fields[name] !== undefined) return;              // first value wins; no array smuggling
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      if (name !== 'assets') { errors.push(`unexpected file field "${escapeHtml(name).slice(0, 40)}"`); stream.resume(); return; }
      if (files.length >= maxFiles) { errors.push(`more than ${maxFiles} files`); stream.resume(); return; }
      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (c) => {
        size += c.length; total += c.length; budget.used += c.length;
        if (size <= maxFileBytes) chunks.push(c);
        if (over()) { truncated = true; stream.destroy(); reject(Object.assign(new Error('request body too large'), { status: 413 })); }
      });
      stream.on('limit', () => { truncated = true; stream.resume(); });
      stream.on('close', () => {
        done += 1;
        if (truncated) { errors.push(`${escapeHtml(String(info.filename ?? 'file').slice(0, 60))} is larger than ${maxFileBytes} bytes`); return; }
        files.push({ name: String(info.filename ?? ''), type: String(info.mimeType ?? ''), bytes: Buffer.concat(chunks) });
      });
    });

    busboy.on('error', (err) => reject(Object.assign(err, { status: err?.code === 'LIMIT_HEADER_COUNT' || /malformed/i.test(String(err)) ? 400 : 400, parseError: true })));
    busboy.on('finish', () => {
      if (errors.length === 0 && Object.keys(fields).length === 0 && files.length === 0) errors.push('empty submission');
      resolve({ fields, files, errors });
    });
    req.on('aborted', () => reject(Object.assign(new Error('aborted'), { status: 400 })));
    req.pipe(busboy);
  });
}

async function readRaw(req, maxTotal, budget) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    budget.used += c.length;
    if (size > maxTotal) throw Object.assign(new Error('request body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
