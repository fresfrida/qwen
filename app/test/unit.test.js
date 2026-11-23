import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { checkText, checkEmail, escapeHtml } from '../src/validate.js';
import { sniff, checkUpload, safeDisplayName, ACCEPTED } from '../src/uploads.js';
import { validateSubmission, PLACEMENT_OPTIONS } from '../src/form.js';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 7)]);
const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 9)]);
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 3)]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(60, 1)]);

test('config: unknown purpose fails instead of defaulting to something plausible', () => {
  assert.throws(() => loadConfig({ MODE: 'prototype', FORM_PURPOSE: 'owner_briefs' }), /not implemented/);
  assert.equal(loadConfig({}).mode, 'prototype', 'default must be the harmless mode');
  assert.throws(() => loadConfig({ MODE: 'production' }), /MODE must be/);
  assert.throws(() => loadConfig({ MODE: 'live', PORT: '3000' }), /OWNER_USER/, 'live without owner credentials must not start');
  assert.throws(() => loadConfig({ MODE: 'live', OWNER_USER: 'me', OWNER_PASS: 'short', PORT: '3000' }), /12 characters/);
});

test('config: limits are numbers or a loud failure', () => {
  assert.throws(() => loadConfig({ MAX_FILES: 'lots' }), /MAX_FILES/);
  assert.throws(() => loadConfig({ PORT: '99999' }), /PORT/);
  assert.equal(loadConfig({ MAX_FILE_BYTES: '1024' }).maxFileBytes, 1024);
});

test('text caps: 200k of prose, control characters and spoofing marks are refused or truncated', () => {
  assert.equal(checkText('x'.repeat(300_000), { max: 2000, label: 'Company name' }).ok, false);
  assert.equal(checkText('  hello \n world  ', { max: 200 }).value, 'hello world');
  assert.equal(checkText('nul\u0000byte', { max: 20 }).ok, false);
  assert.equal(checkText('\u202eevil order', { max: 20 }).ok, false, 'bidi override must not be stored');
  assert.equal(checkText('line1\nline2', { max: 50, multiline: true }).ok, true);
});

test('email: work address shape, length cap, no header injection', () => {
  assert.equal(checkEmail('name@company.com').ok, true);
  assert.equal(checkEmail('nope').ok, false);
  assert.equal(checkEmail('a@b.c').ok, false, 'one-letter TLD is not a work address');
  assert.equal(checkEmail('x'.repeat(300) + '@a.com').ok, false);
  assert.equal(checkEmail('a@b.com\r\nX-Fake: 1').ok, false);
  assert.equal(checkEmail('a b@c.com').ok, false);
});

test('escapeHtml covers every character that can open a tag or an attribute', () => {
  const evil = `<img src=x onerror="alert('&')"> \\\``;
  const out = escapeHtml(evil);
  for (const c of ['<', '>', '"', "'", '`', '=']) assert.ok(!out.includes(c), `${c} survived escaping`);
  assert.match(out, /&lt;img/);
});

test('uploads: type comes from bytes; SVG and lying browsers are refused', () => {
  assert.equal(sniff(png).mediaType, 'image/png');
  assert.equal(sniff(jpg).mediaType, 'image/jpeg');
  assert.equal(sniff(pdf).mediaType, 'application/pdf');
  assert.equal(sniff(mp4).mediaType, 'video/mp4');
  assert.equal(sniff(Buffer.from('<svg onload=alert(1)>')), null, 'SVG must not be accepted');
  assert.equal(sniff(Buffer.from('#!/bin/sh\nrm -rf /')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
  assert.ok(!ACCEPTED.includes('image/svg+xml'));
  assert.equal(checkUpload({ bytes: png, declaredType: 'application/x-msdownload', declaredName: 'a.png', fieldMaxBytes: 1e6 }).ok, false, 'declared type must match bytes');
  assert.equal(checkUpload({ bytes: png, declaredType: 'image/png', declaredName: 'logo.png', fieldMaxBytes: 4 }).ok, false, 'cap is enforced');
  assert.equal(checkUpload({ bytes: png, declaredType: 'image/png', declaredName: 'x'.repeat(400), fieldMaxBytes: 1e6 }).ok, false);
});

test('display names cannot smuggle a path, markup or an ANSI control sequence', () => {
  for (const n of ['../../etc/passwd', 'C:\\Windows\\system32\\cmd.exe', '<img src=x onerror=alert(1)>.png', 'a\u0000b.png', '\x1b[31mred.png', '.'.repeat(300)]) {
    const s = safeDisplayName(n);
    assert.ok(!/[\\/<>"'&]/.test(s), `unsafe char survived in ${JSON.stringify(s)}`);
    assert.ok(!s.includes('..'), 'path traversal survived');
    assert.ok(s.length <= 120);
    assert.ok(!/[\u0000-\u001f\x1b]/.test(s), 'control char survived');
  }
  assert.equal(safeDisplayName(undefined), 'asset');
});

test('escapeHtml never yields the literal string undefined', () => {
  for (const v of ['a/b', 'C:\\x', 'image/png,image/jpeg', 'me@x.example', '100%', 'a=b', 'x`y', '<b>', '&', '\"']) {
    const out = escapeHtml(v);
    assert.ok(!out.includes('undefined'), `escaping invented text for ${JSON.stringify(v)}`);
    assert.ok(!/[<>]/.test(out.replace(/&lt;|&gt;/g, '')), `angle bracket survived for ${JSON.stringify(v)}`);
  }
});

test('escaping must not corrupt values the browser has to understand', () => {
  assert.equal(escapeHtml('image/png'), 'image/png', 'MIME types appear in accept= and must stay parseable');
  assert.equal(escapeHtml('a@b.co'), 'a@b.co');
  assert.equal(escapeHtml('two words & "quoted"'), 'two words &amp; &quot;quoted&quot;');
});

test('form contract: exactly three placement options, required fields enforced, extras dropped', () => {
  assert.equal(PLACEMENT_OPTIONS.length, 3, PLACEMENT_OPTIONS.map((o) => o.value).join(','));
  const r = validateSubmission({ company: 'Acme', offering: 'A drink', placement: 'tiktok_short', email: 'me@acme.com', evilExtra: '<script>' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.unknown, ['evilExtra'], 'undeclared field must be reported and dropped');
  assert.equal('evilExtra' in r.values, false);
  assert.equal(validateSubmission({}).ok, false);
  assert.match(validateSubmission({ company: 'A', offering: 'B', placement: 'a-podcast', email: 'a@b.co' }).errors.placement, /listed options/, 'a near-match placement must be refused, not guessed');
});

test('page renderer leaves no raw template token anywhere, in either mode', async () => {
  const { renderPage } = await import('../src/page.js');
  for (const mode of ['prototype', 'live']) {
    const html = renderPage({ config: { mode }, formHtml: '<section id="form"></section>' });
    const leaked = html.match(/\{\{[A-Z_]+\}\}/g) ?? [];
    assert.deepEqual(leaked, [], `${mode}: unresolved template tokens ${leaked.join(', ')}`);
    const badges = html.match(/MyAIStudio <span>([^<]*)<\/span>|MyAIStudio<\/strong> · ([^<]*)</g) ?? [];
    assert.ok(badges.length >= 2, `${mode}: expected the badge in both nav and footer, saw ${badges.length}`);
    for (const b of badges) assert.ok(!/\{\{/.test(b), `${mode}: badge still raw: ${b}`);
  }
});
