# HANDOFF

Project: MyAIStudio — one-page studio site plus an owner-only film pipeline.
Workspace path in the assistant environment: `/workspace/2f7d31da-4656-4041-ae77-dc35c1b9bf39/work`
Deliverable directory (the only one you can download): `…/work/output`
Source snapshot taken before any code change this session: `…/work/myaistudio-snapshot.zip` (82 files).

## Run it

```bash
cd output/app
npm ci                      # deps live in package-lock.json; nothing else needed
npm start                   # http://localhost:3000  (prototype: stores nothing)
npm test                    # 88 assertions across 7 files
node test/e2e-proof.mjs     # 36 claims against a running server
npm run export:site         # rebuilds output/site/index.html for the static preview
```

Live mode (writes to disk, still no outbound anything):

```bash
MODE=live OWNER_USER=you OWNER_PASS='at least 12 characters' npm start
```

## What works today, with the command that proves it

| Behaviour | Proof |
|---|---|
| All suites pass, together, and exit by themselves | `node --test "test/*.test.js"` → `# tests 88 / # pass 88 / # fail 0`, `COMBINED EXIT=0` |
| Per suite | unit 11, intake 7, model 23, integration 9, studio 12, pipeline 15, studio-http 11 — each `exit=0` |
| Mode badge renders in nav **and** footer, no raw template tokens | `python3 step1-footer-evidence.py` (also re-run by `npm run verify` path) |
| Brand enquiry form unchanged, prototype stores nothing | `intake.test.js` + `integration.test.js`; live-mode save test uses a realistic work email |
| Pipeline: 10 stages, two gates, one shared brief, dedupe, crash recovery, poll | `studio.test.js`, `pipeline.test.js`, `studio-http.test.js` |
| Model seam stays off | `node src/cli.js model-info` → `can send anything? NO` + blocker list |

## What is NOT built (do not assume it exists)

- **The layer modules are dead code.** `src/studio/lexicon.js` (look / genre / format / sound vocabulary
  and help text) and `src/studio/layers.js` (parsing, summary line, face-direction reading,
  dependency-aware reset rule) load correctly and have no importers except `layers.js → lexicon.js`.
  Nothing renders them, validates them on the wire, or stores them on a film record.
- No look/genre/format/sound fields in the Create form or in the stored brief.
- No `(i)/(?)` help buttons anywhere (`aria-expanded` count 0 in `src/`).
- No live combined summary line, no dependency-aware reset in the UI.
- No DESTINATION & OUTPUT group, no LANGUAGE group, no sound designer stage, no payment checkpoint.
- The public page structure is still the older one: hero CTA is `Jump to the form`, nav is `The form`,
  Stories still shows six `Title pending` slots. Deliberately left for the Create/Films step, because
  pointing "Start a film" at a section that does not exist would be worse than the current state.

## Fixes made in this session's Step 1 (files touched)

- `src/page.js` — `renderPage` now substitutes **all** occurrences and then throws if any
  `{{TOKEN}}` survived. The badge leak existed because `String.replace` with a plain string only
  replaced the first of two occurrences (nav); the footer kept the raw token.
- `src/server.js` — boot now calls `films.recoverInterrupted()` **before serving any request**.
  A stage left `in_progress` by a kill is now resolved to `failed` with its error kept; it is never
  retried automatically. Previously that function existed and was never called.
- `src/server.js` — `close()` no longer waits forever: it stops in-flight stage work, closes idle
  sockets, and force-closes the rest. A server that cannot close cannot be restarted or deployed.
- `src/studio/api.js` — the `run` action claims the stage, answers `303` immediately, and lets the
  stored record carry the work. Before this, the HTTP request awaited the backend, so "in progress"
  was never observable and a crash was untestable.
- `test/studio-http.test.js` — repaired, not weakened: real record versions instead of a hardcoded
  `2`; the live-mode test stopped asserting a prototype-only notice; the email fixture now satisfies
  the *existing* (protected) work-email rule; `assert.notMatch` (which is not Node's API) became
  `doesNotMatch`; the crash test now simulates a death that cannot write; every request sends
  `Connection: close` so the process exits.
- `public/studio.js`, `src/studio/view.js` — poll/notice plumbing aligned with the `303`-first run verb.

## Reproducing the state honestly

`npm test` runs seven files; a green run must also **exit on its own** — check the exit code, not
just the pass count, because a hung close used to mask itself as "still running".
