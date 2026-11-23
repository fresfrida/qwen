# MyAIStudio — landing page + brand placement enquiries

One page, one form, and storage that is switched **off** in prototype mode. Node 22, one runtime
dependency (`busboy`), no framework, no build step, no client-side JavaScript.

## Modes

| | `MODE=prototype` (default) | `MODE=live` |
|---|---|---|
| The form | enabled, posts to `/enquiry` | identical |
| Storage | the live adapters are **never constructed** — there is no code path from a request to a disk write | file adapters under `DATA_DIR` |
| After you submit | "Demo only — nothing was sent." | "Thank you — your submission is saved." — only after the write is read back |
| Write fails | n/a | "Nothing was saved." (never a thank-you), and any asset already written is removed |
| Owner view | `409`, because there is nothing to list | HTTP basic, credentials required at boot |

Switching purpose or mode is configuration, not a rewrite: `MODE`, `FORM_PURPOSE`, `DATA_DIR`,
`OWNER_USER`, `OWNER_PASS`. The app **refuses to start** as live without owner credentials, and
refuses any `FORM_PURPOSE` it hasn't implemented rather than substituting a plausible one.

## Run

Needs Node 22 or newer (`node -v`). First run installs one dependency; afterwards it is cached.

```bash
npm ci
npm start                 # http://localhost:3000  (prototype: saves nothing)
npm test                  # unit + use-case + HTTP suites
npm run e2e               # drives the real server and asserts every claim on this README
npm run audit             # dependency vulnerabilities
npm run verify            # all four
npm run build             # exports site/index.html, the inert static design preview
npm run model:info        # every model switch, and what still blocks a send
npm run model:stages      # the prompt files, their limits, their variables
npm run model:preview -- research --brief=examples/brief.json   # exact bytes, never sent
```

### First run, step by step

1. `npm ci` then `npm start`. Open <http://localhost:3000>. The page says *prototype preview* and
   the form carries the notice "Demo — submissions are not sent or saved".
2. Fill it in and attach a file. You land back on the page with **"Demo only — nothing was sent."**
   Nothing was written: `ls ./data` shows no directory at all.
3. Try to break it: attach an `.svg`, or a text file renamed `.png`. The server refuses it by type
   and names which file, because the bytes decide, not the extension.
4. Now see the real thing, on a port that does not clash with anything:

   ```bash
   MODE=live PORT=4000 OWNER_USER=you OWNER_PASS='at least 12 characters' npm start
   ```

   On your own machine port 3000 is yours to use; `PORT=4000` here only avoids a clash with this
   workspace's preview server, which already holds 3000 and cannot run the app.
   <http://localhost:4000> behaves identically except what you get back. Submit with a valid file:
   **"Thank you — your submission is saved."** and `./data/submissions/*.json` plus
   `./data/assets/<uuid>.png` appear. `./data` is git-ignored.
5. Read your enquiries at <http://localhost:4000/owner> — the browser asks for the same
   `OWNER_USER` / `OWNER_PASS`. Assets download from there; they are not readable by anyone who
   isn't you, and there is no public list.
6. Prove the honesty: `chmod 500 ./data/submissions`, submit again, and you get
   **"Nothing was saved."** — no thank-you, no half-written record. `chmod 700` it back.

Two things a cloud platform must add, because the code can't: TLS in front (owner auth is HTTP
basic), and a persistent disk for `DATA_DIR` or an object-storage adapter. See *Deploying*.


## The model seam (research and script stages)

The landing page and the enquiry form **never call a model**. There is no route to it, no script on
the page, and no key in the browser. The pipeline is reached only by the operator CLI, and it starts
inert:

| switch | default | what it unlocks |
|---|---|---|
| `MODE` | `prototype` | hard refusal before anything else, not overridable by any model flag |
| `MODEL_ENABLED` | `false` | the pipeline may attempt a call |
| `MODEL_PROVIDER` | empty | which adapter exists at all: `echo`, `openai`, `openai-compatible`, `ollama` |
| `MODEL_ID` | empty | the model name, so vendor swap is not a code edit |
| `MODEL_SEND_BRIEF_DATA` | `false` | permission for enquiry text to leave the machine |
| `OCR_IMAGE_APPROVED` | `false` | permission for an **uploaded asset** to leave the machine |
| `MODEL_DRY_RUN` | `true` | render and report the prompt, never send |
| `MODEL_MAX_CALLS_PER_BRIEF` | 3 | a loop cannot spend your balance |

`model-run` refuses if any of those is missing and prints the whole switchboard plus the blockers. The
two approvals are separate on purpose: text and files are different disclosures.

### Look at it before you use it

```bash
npm run model:info                          # switches, and exactly what still blocks a send
npm run model:stages                        # prompt files, their limits, their variables
npm run model:preview -- research --brief examples/brief.json   # the exact bytes, never sent
npm run model:run -- research --brief examples/brief.json        # needs all switches set
```

### Prompts are files, and their numbers are load-bearing

`prompts/research.prompt.md` and `prompts/script.prompt.md` are plain text with a small header:

```
---
stage: research
limits: maxClaims=6, maxClaimChars=500, maxSourcesPerClaim=3, maxQuoteWords=60
---
```

Each limit is quoted to the model as `{{maxClaims}}` **and** read back by the validator, so editing
one number changes what the model is told and what the code will accept together. A limit that is
declared but not used fails at load, because an unenforced number is how a limit quietly disappears.
Edit, restart, done - no rebuild. `prompts/README.md` explains the header, and why the data marker
must not be written into a prompt file.

### What is contained, and how that is proved

Visitor text never enters the instruction channel. It is wrapped in a per-block random boundary
(`#MZ_DATA_<32 hex>.begin`), text inside the brief that *looks* like such a boundary is rewritten to
`[escaped fence marker: …]` and stays visible, and the assembled document is verified before any
provider is contacted - in every mode, including prototype, where the prompt is still built so the
refusal can honestly state its byte size. `instructions` and `data` also go to chat providers as
separate turns.

Tests cover: forged boundary mid-sentence, nested forgeries, a 600-boundary flood (settles in ~1 ms),
`<MZ_DATA` and marker-string inputs, unsourced claims, invented source URLs, a `BLOCKED:` refusal
returned as a refusal, quotes over the prompt limit, and that no HTTP request and no provider call
happen while approvals are unset (`test/model.test.js`, 21 tests; CLI behaviours in `npm run e2e`).

### One thing this pipeline cannot honestly do yet

There is **no retrieval tool wired in**. So `research` may cite only links the owner supplied inside
the brief, and any other URL is rejected as invented. Until you add a search or fetch step, treat
the research stage as "organise the evidence I gave you", not "find out". Adding retrieval means
feeding its output into the allowed-source set, not loosening that rule.


## Where things live

```
src/config.js      env -> typed config; the only file that reads process.env
src/form.js        the form as data: fields, limits, the 3 placement options. Renderer, validator
                   and stored record are all derived from here.
src/validate.js    text/email caps, escapeHtml
src/uploads.js     file type decided by magic bytes; SVG is refused on purpose
src/intake.js      the use case: validate -> store -> confirm, and rollback on failure
src/ports.js       the two contracts (submission store, asset store)
src/adapters/      prototype (refuses) and file implementations of those ports
src/container.js   the only place that knows which adapter is plugged in
src/model/         the model seam: port, provider registry, prompt loader, pipeline (owner CLI only)
src/cli.js         operator commands to look at a prompt without sending it
prompts/           the instruction text, as editable files with enforceable limits
src/routes.js      HTTP translation: parse, call intake, render
src/page.js        rendering; every value from a person passes through escapeHtml
src/server.js      bootstrap, timeouts, graceful shutdown
```

Adding Postgres or S3 means one adapter file plus one line in `container.js`; routes, intake and
rendering don't change. A second form purpose means a new definition module and adding its name to
`PURPOSES` in `config.js`.

## Deploying

```bash
docker build -t myaistudio ./app
docker run -p 8080:3000 -e MODE=live -e OWNER_USER=... -e OWNER_PASS=... \
  -v myaistudio-data:/data myaistudio
```

Four things that must be true before this is public, none of which the code can do for you:

1. **TLS in front.** Owner auth is HTTP basic; without HTTPS the password crosses the wire in
   clear text. Terminate TLS at your platform or a reverse proxy.
2. **Persistent `DATA_DIR`.** On ephemeral container filesystems, enquiries vanish on redeploy.
   Mount a volume, or swap in the object-storage/Postgres adapter.
3. **One process only** unless you move rate limiting out of memory. The limiter is per-process, so
   two replicas double the allowance.
4. **Secrets in your platform's store**, never in the image, never in `site/`.

`TRUST_PROXY=true` only behind a proxy that sets `X-Forwarded-For`; otherwise the limiter keys on
the direct peer address.

## What the form accepts

Company name, product or service, one of three placements (TikTok short, YouTube Shorts film,
Instagram Reel), a work email, and up to five optional assets. Files are re-identified from their
bytes at write time; accepted: PNG, JPEG, WebP, MP4, MOV, PDF. **SVG is refused** — it can carry a
script, which is how an "image" upload becomes code on the owner's screen. Stored files get an
opaque random name; the visitor's filename is kept only as display text, and is never a path. Assets
are served only through the authenticated owner route, as `Content-Disposition: attachment`, under
`sandbox` CSP. There is no listing route and no static mapping of the asset directory.

## Where egress actually is

Two statements belong apart, because they have different risk:

- **The site you publish has no way to reach anything.** No JavaScript (`script-src 'none'`), no
  analytics, no third-party requests, no email, no CRM, no messaging, no automatic reply. Form data
  goes to this origin and stops there.
- **The model seam can make one request**, and nothing else in the codebase calls `fetch`. It is a
  separate concern: not wired to any route, driven by `src/cli.js`, off by default, and gated by two
  approvals (see `prompts/README.md`). A visitor cannot reach it, a submission cannot trigger it, and
  `verify.sh` asserts that exactly one file in `src/` contains a request.

If you would rather this build had no network path at all, delete the `model` wiring from
`container.js` and remove `src/model/`: the form, storage, and owner view do not reference it.

## Deliberately absent

No email, CRM, messaging, or analytics integration; no automatic reply; no admin token in the page;
no client-side JavaScript. The page copy is the approved text verbatim and claims no reach, no track
record, no launched films, and no running pipeline.

## Verifying before you publish

```bash
npm run verify                       # from ./app
bash ../output/verify.sh             # artifact and reachability checks
python3 ../output/check_runtime.py   # browser: real submit, real upload, login, forced failure
```
