# qwen — MyAIStudio: what is in here and how to run it

Two decisions I was never given, so I built the case that satisfies both and left the other switch-ready:
- `MODE` = **prototype** (what's running): the form is real and posts to a real server, and that server
  saves nothing. Flip to `live` and the identical code writes enquiries + assets.
- `FORM_PURPOSE` = **brand_enquiries** (placements + asset uploads). `viewer_ideas` / `owner_briefs`
  refuse to boot rather than being silently substituted — they need one definition module each, then
  add its name in `app/src/config.js:9`.

## Run it

| You want | Command |
|---|---|
| The page, locally, not saving anything | `cd app && npm ci && npm start` → http://localhost:3000 |
| The page actually saving enquiries + uploads | `cd app && MODE=live PORT=4000 OWNER_USER=you OWNER_PASS='at-least-12-chars' npm start` → http://localhost:4000, owner view at `/owner` |
| See or send a prompt to a model | `cd app && npm run model:info` then `npm run model:preview -- research --brief=examples/brief.json`. Off by default, unreachable from the site; `prompt-sample.txt` is real output |
| Proof it does what this file claims | `cd app && npm run verify` (97 named tests, `npm audit`, 46 e2e claims against a running server, export self-checks) |
| Browser-level proof | `python3 check_runtime.py` (34 checks: real form submit, real upload, lying SVG refused, owner login, traversal attempts, forced disk failure) |
| Artifact + reachability checks | `bash verify.sh` (90 checks) |
| Run it as a container | `cd app && docker build -t myaistudio .` then the `docker run` line in `app/README.md`. Four things still belong to you: TLS in front, a persistent `DATA_DIR`, one process per in-memory limiter, an image scan for known vulnerabilities |
| See or change the prompt text | `cd app && npm run model:stages`, then edit `app/prompts/*.prompt.md`. Limits in the file are enforced by the validator; `npm run model:preview` shows the exact bytes with no network call |
| Try a different model | `MODEL_PROVIDER=openai\|ollama\|openai-compatible MODEL_BASE_URL=… MODEL_ID=…` — one variable, plus `MODEL_SEND_BRIEF_DATA=true` and `MODEL_DRY_RUN=false` before anything can leave |

`npm start` binds **3000**. In this workspace 3000 is held by the preview server itself (`ss -ltnp`
showed `mule-mcp-ui` on it), so the app cannot bind it here and my attempt died with `EADDRINUSE`;
that server only serves files, so it can show the exported page but cannot answer `/enquiry`,
`/healthz` or `/owner`. Nothing is faked around that: `check_runtime.py` serves the export from
`site/` on a port of its own for the artefact phase, boots the real application on ephemeral ports
for the rest, and `shot-app-form.png` / `shot-app-owner.png` / `shot-app-storage-failure.png` are
captures of that running application. On your machine `npm start` is clickable straight away.

## Files

```
site/              the published root: index.html + app.css + grain.svg + favicon.svg. Nothing else is reachable.
app/               the application: src/, public/, build/, test/, Dockerfile, README.md
builder.config.json  private notes; not served, not read by the browser, no secrets in it
verify.sh, check_runtime.py, shot-*.png   the checks and their evidence
```

Two approvals are separate on purpose: `MODEL_SEND_BRIEF_DATA` lets enquiry text leave the machine,
`OCR_IMAGE_APPROVED` lets an **uploaded brand asset** leave it. Both are false, and while MODE is
`prototype` the app refuses to start with either set true."
`app/node_modules` exists because I installed `busboy` to run the tests here. It is git-ignored;
`npm ci` recreates it from `app/package-lock.json` (2 packages, `npm audit` reports 0).

## What I did not do, waiting on you

Nothing was published, no account connected, no credits spent, no git repository created, no email
or CRM path built, `MODE` still `prototype`. Owner credentials above are examples, not secrets —
generate real ones with `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.
