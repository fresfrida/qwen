// HTTP layer. Translation only: parse input, call the use case, render the answer.
// No business rule lives here, so the same intake can be driven by a CLI or a queue later.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody } from './multipart.js';
import { renderPage, formSection, noticeFor, ownerListPage, simplePage } from './page.js';
import { checkOwnerAuth, authChallenge, createLimiter, clientKey } from './guards.js';
import { OUTCOME } from './intake.js';


// an allowlist, not a directory mount: nothing outside this map can be read through the web server
const STATIC = { '/app.css': 'text/css; charset=utf-8', '/grain.svg': 'image/svg+xml', '/favicon.svg': 'image/svg+xml' };
const CSP_PAGE = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'none'; object-src 'none'; connect-src 'none'";
const CSP_FILE = "default-src 'none'; sandbox";
// The owner workspace needs one thing the public page must never have: a poll. Separate CSP, so a
// script allowance cannot leak onto the page a visitor sees.
const CSP_STUDIO = "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'; script-src 'self'; connect-src 'self'; object-src 'none'";

const send = (res, status, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { 'content-length': buf.length, ...headers });
  res.end(buf);
};
const html = (res, status, markup, extra = {}) => send(res, status, markup, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'content-security-policy': CSP_PAGE, ...extra });
const studioHtml = (res, status, markup) => send(res, status, markup, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'content-security-policy': CSP_STUDIO });

export function createHandler(container) {
  const PUB = container.config.publicDir;   // chosen by config, so the served set cannot drift from the export
  const { config, intake, submissions, assets, log, studioRoutes } = container;
  const limit = createLimiter({ windowMs: 10 * 60_000, max: config.mode === 'live' ? 8 : 200 });

  async function page(ctx = {}) {
    return renderPage({ config, formHtml: formSection({ config, ...ctx }) });
  }

  async function onSubmit(req, res) {
    const key = clientKey(req, config.trustProxy);
    const rl = limit(key);
    if (!rl.allowed) {
      log('rate_limited', { key: key.slice(0, 40) });
      return html(res, 429, await simplePage({ config, title: 'Too many attempts', note: `This form accepts a few enquiries every 10 minutes. Try again in ${Math.ceil((rl.retryAfterMs ?? 60_000) / 60_000)} minute(s).` }));
    }
    let parsed;
    try {
      parsed = await readBody(req, config);
    } catch (err) {
      const status = err.status ?? 400;
      return html(res, status, await simplePage({ config, title: status === 413 ? 'Too large' : 'Could not read that submission', note: status === 413 ? 'The request is bigger than this form accepts. Nothing was saved.' : 'The request body could not be parsed. Nothing was saved.' }));
    }
    const { fields, files, errors } = parsed;
    if (errors.length) {
      return html(res, 400, await page({ errors: { _request: errors.join(' ') }, notice: { tone: 'error', title: 'Nothing was saved.', body: 'That request could not be read as this form. Nothing was saved.' } }));
    }
    if (fields._form !== config.purpose) {
      return html(res, 400, await simplePage({ config, title: 'Unknown form', note: 'This page only accepts the form it declares. Nothing was saved.' }));
    }

    const result = await intake({ fields, files });
    const notice = noticeFor(result);
    const ctx = { values: result.values ?? {}, errors: result.errors ?? {}, fileErrors: result.fileErrors ?? [], notice };

    if (result.outcome === OUTCOME.SAVED) return html(res, 200, await page(ctx));
    if (result.outcome === OUTCOME.DEMO) return html(res, 200, await page(ctx));
    if (result.outcome === OUTCOME.REJECTED) return html(res, 422, await page(ctx));
    return html(res, 503, await page(ctx));   // FAILED: never presented as success
  }

  async function ownerList(req, res) {
    const auth = checkOwnerAuth(req, config);
    if (!auth.ok) {
      if (auth.reason === 'prototype_mode' || auth.reason === 'not_configured') {
        return html(res, 409, await simplePage({ config, title: 'Owner view unavailable', note: auth.reason === 'prototype_mode' ? 'Prototype mode stores nothing, so there is nothing to list. This view is not a way to reach other environments’ data.' : 'Set OWNER_USER and OWNER_PASS before switching MODE to live.' }), { 'www-authenticate': authChallenge() });
      }
      log('owner_auth_failed', { reason: auth.reason, key: clientKey(req, config.trustProxy).slice(0, 40) });
      return html(res, 401, await simplePage({ config, title: 'Sign in required', note: 'Saved enquiries are readable only by the studio.' }), { 'www-authenticate': authChallenge() });
    }
    const rows = await submissions.list();
    return html(res, 200, ownerListPage({ config, rows, assetNote: config.mode === 'live' ? undefined : 'prototype' }), { 'www-authenticate': authChallenge() });
  }

  async function ownerAsset(res, key) {
    const found = await assets.get(decodeURIComponent(key));
    if (!found) return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    // attachment + sandbox: a stored file can never execute against this origin
    return send(res, 200, found.bytes, {
      'content-type': found.mediaType,
      'content-disposition': `attachment; filename="${found.storedName}"`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP_FILE,
      'cache-control': 'private, no-store',
      'cross-origin-resource-policy': 'same-origin',
    });
  }

  // HEAD is a read of the same document, so it may take the GET routes. Node suppresses the body
  // for HEAD on its own; nothing here is allowed to *change* state on a HEAD, because every
  // write route below still gates strictly on POST.
  const READ = (m) => m === 'GET' || m === 'HEAD';

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    try {
      if (READ(req.method) && (path === '/' || path === '/index.html')) return html(res, 200, await page());   // /index.html: the same page, so hosts that probe the filename work too
      if (path === '/studio' || path.startsWith('/studio/')) {
        if (!studioRoutes) {
          return html(res, 404, await simplePage({ config, title: 'No studio workspace', note: 'STUDIO_PERSIST is off, so there is nowhere to keep film records and the workspace is not started.' }));
        }
        const handled = await studioRoutes({
          req, res, url,
          json: (status, obj) => send(res, status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }),
        });
        if (handled) return;
        return html(res, 404, await simplePage({ config, title: 'Not found', note: 'That studio address does not exist.' }));
      }
      if (READ(req.method) && path === '/studio.js') {
        const body = await readFile(join(PUB, 'studio.js'));
        return send(res, 200, body, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      }
      if (READ(req.method) && STATIC[path]) {
        const body = await readFile(join(PUB, path.slice(1)));
        return send(res, 200, body, { 'content-type': STATIC[path], 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
      }
      if (READ(req.method) && path === '/healthz') {
        return send(res, 200, JSON.stringify({ ok: true, mode: config.mode, storage: config.mode === 'live' ? 'configured' : 'disabled', form: config.purpose }), { 'content-type': 'application/json', 'cache-control': 'no-store' });
      }
      if (req.method === 'POST' && path === '/enquiry') return await onSubmit(req, res);
      if (path === '/owner' || path === '/owner/') return await ownerList(req, res);
      if (path.startsWith('/owner/')) {
        const auth = checkOwnerAuth(req, config);
        if (!auth.ok) return html(res, 401, await simplePage({ config, title: 'Sign in required', note: 'Assets are readable only by the studio.' }), { 'www-authenticate': authChallenge() });
        if (READ(req.method) && /^\/owner\/asset\/[\w.-]+$/.test(path)) return await ownerAsset(res, path.slice('/owner/asset/'.length));
        return send(res, 404, 'not found', { 'content-type': 'text/plain; charset=utf-8' });
      }
      if (path.startsWith('/assets/') || path.startsWith('/data/')) {
        return html(res, 404, await simplePage({ config, title: 'Not found', note: 'Uploaded assets are never published at a guessable address.' }));
      }
      return html(res, 404, await simplePage({ config, title: 'Not found', note: 'That page does not exist.' }));
    } catch (err) {
      log('unhandled', { type: err?.name, message: String(err?.message).slice(0, 160) });
      return html(res, 500, await simplePage({ config, title: 'Something went wrong', note: 'Nothing was saved.' }).catch(() => 'error'));
    }
  };
}
