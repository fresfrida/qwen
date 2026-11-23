// Optional capability, not part of the chat port: reading the content of an uploaded asset.
// Deliberately a different port (interface segregation) so a provider that only generates text can
// never be asked to ship a file somewhere, and vice versa.
//
// It shells out to the sandbox's document-reading script with an argument ARRAY and no shell, so a
// file name can never become a command. Three switches must all be true before anything leaves:
// ASSET_READING, approved, and not a dry run.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { redact } from './redact.js';

export function createAssetReader(cfg) {
  const { script, python = 'python3', timeoutMs = 120000, maxImageBytes = 8 * 1024 * 1024,
    approved = false, dryRun = false, egressHost = 'the configured reading endpoint',
    credentialNamesPresent = [], credentialEnv = {}, childEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp' } } = cfg;

  const argvFor = (imagePath, prompt) => [script, '--image', imagePath, '--prompt', prompt, '--json'];

  return {
    name: 'ocr-image',
    configured: () => Boolean(script),
    /** Says exactly what would leave the machine. Produces no output and costs nothing. */
    preview: async (imagePath, prompt) => {
      const info = await stat(imagePath).catch(() => null);
      const host = egressHost;
      return {
        wouldSend: true, sent: false, provider: 'ocr-image', destination: host,
        image: imagePath, bytes: info?.size ?? null, promptChars: prompt.length,
        credentialsAvailable: credentialNamesPresent,
        argv: [python, ...argvFor(imagePath, prompt)],
      };
    },
    async read({ imagePath, prompt }) {
      const info = await stat(imagePath).catch(() => null);
      if (!info?.isFile()) return { ran: false, provider: 'ocr-image', ok: false, reason: 'image_missing', detail: 'the stored asset could not be opened' };
      if (info.size > maxImageBytes) return { ran: false, provider: 'ocr-image', ok: false, reason: 'asset_too_large', detail: `${info.size} bytes over the ${maxImageBytes} reading limit` };
      if (approved !== true) {
        return { ran: false, provider: 'ocr-image', ok: false, reason: 'approval_required',
          detail: `reading this asset means sending ${info.size} bytes of file and ${prompt.length} characters of brief text to ${egressHost}. Nothing was sent.` };
      }
      if (dryRun) {
        const p = await this.preview(imagePath, prompt);
        return { ran: false, provider: 'ocr-image', ok: false, reason: 'dry_run', detail: `would send ${p.bytes} bytes to ${p.destination}`, preview: p };
      }

      return await new Promise((resolve) => {
        const child = spawn(python, argvFor(imagePath, prompt), {
          // the minimal environment config allowed, plus the one credential pair the script needs
          env: { ...childEnv, ...credentialEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; if (out.length > 400_000) { child.kill('SIGKILL'); } });
        child.stderr.on('data', (c) => { err += c; });
        child.on('error', (e) => { clearTimeout(timer); resolve({ ran: false, provider: 'ocr-image', ok: false, reason: 'spawn_failed', detail: redact(e.message) }); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) return resolve({ ran: false, provider: 'ocr-image', ok: false, reason: 'reader_failed', detail: `exit ${code}: ${redact(err || out)}` });
          let text = out;
          try { const j = JSON.parse(out); text = j.answer ?? j.text ?? j.detail ?? out; } catch { /* older script versions print text */ }
          resolve({ ran: true, provider: 'ocr-image', ok: true, text: String(text).slice(0, 20000), finishReason: 'completed', usage: null });
        });
      });
    },
  };
}
