# KANBAN

Status as of this session. "Green" means a test or command proves it, not that a file exists.

## Done and green

- Step 0 — source snapshot zip, secrets/node_modules/data excluded (`myaistudio-snapshot.zip`, 82 files).
- Step 1 — `{{MODE_BADGE}}` leak fixed in nav **and** footer; proof: `step1-footer-evidence.py`,
  0 raw tokens in the export, in a booted prototype server and in a booted live server.
- Step 1 — crash recovery wired at boot (`recoverInterrupted` was defined and never called).
- Step 1 — server `close()` can no longer hang on keep-alive sockets.
- Step 1 — `run` verb claims then answers `303`; the work continues against the record, so
  "in progress" is observable and a refresh shows it.
- Step 1 — whole suite green and self-terminating: **88 assertions, 0 failures, exit 0**.
- Protected behaviour confirmed unchanged: brand enquiry fields/audience/prototype behaviour,
  the ten pipeline stages, both gates, statuses, dedupe, model-seam limits and the prototype block.

## In progress

- Nothing in flight. The next card is blocked on a scope decision (see DECISIONS.md, open questions).

## Ready — Step 2 (one usable creation path)

- Public page restructure: hero → "Start a film" + "See how it works"; nav → Start a film / Films /
  How it works; section order CREATE, FILMS, HOW IT WORKS, STORIES, BRAND ENQUIRIES, footer.
- CREATE: the two entry cards + the brief form, wired to the *existing* engine via
  `lexicon.js` / `layers.js` (look, genre/mood, format, sound). Those modules exist but have no
  importers, so this card includes the wiring, not a second implementation.
- FILMS: list from the store, per-film pipeline view, honest empty line.
- STORIES: drop the six `Title pending` slots for one honest line until a film is approved for release.
- Labeled journey screenshots at phone + desktop, plus the `GET /studio/film/:id/status` evidence and
  the adversarial set (unknown values rejected, empty required rejected, refresh mid-run, double submit).

## Ready — Step 3 (sequenced, not dropped)

1. `(i)/(?)` help buttons with keyboard + tap behaviour, live combined summary line, dependency-aware reset.
2. DESTINATION & OUTPUT: destination, aspect ratio, target length, resolution map, safe zones.
3. LANGUAGE: spoken, subtitle, deterministic "Same as spoken", caption delivery, translation review gate.
4. Sound designer / music producer stage between storyboard and producer, sound-first at concept for ASMR.
5. Payment checkpoint placeholder after gate 1: disabled, labelled "Payment — not connected yet".

## Blocked / waiting on you

- Payment business model (per film, credits, subscription, who pays) — no UI may imply an answer.
- The brand enquiry form's audience — still my choice, never your decision; untouched this session.
- Whether tonight's deadline cuts any Step 3 item (the cut list is yours to pick, see DECISIONS.md).

## Known defects still open

- None failing in the suites. The public page structure card above is *not built*, not broken.
- No git history exists in this environment; the snapshot zip is the only rollback point.

## Now
- Step 3 delivered: the four layers are editable on a saved film, with the reset rule stated first.
- Step 2 delivered: Start a film → two entry choices → four brief layers saved → real pipeline status.
- Suites: unit 11, intake 7, model 23, studio 12, pipeline 15, integration 9, studio-http 11,
  studio-layers 9 = 97 pass / 0 fail. e2e proof 46 claims. `verify.sh` all checks passed.
- `npm run build` green, `verify.sh` all checks passed, `test/e2e-proof.mjs` 36 PASS.
- Preview: the running app on port 3000 in prototype mode (GET and HEAD both served).

## Next
- Per-stage use of the layers: the storyboard/prompt side still reads the direction line as text.
- Sound-direction handling for `asmr_sound_first` + `silent_captions` in formats that assume a VO.
- Per-stage format plans: the brief says ASMR or ambient loop, the storyboard prompt does not yet act
  on it.

## Step 3 — direction editing on a saved film (done)
- `POST /studio/film/:id/layers` → `pipeline.changeLayers`: parse → refuse → settle → CAS write.
- Film page carries the editor with `data-reset-rule` / `data-reset-map`, both generated from
  `RESET_START`; refused values echo in `data-rejected` while the control keeps the stored look.
- RESET_START clears the stages it feeds, withdraws both gates, and closes a gate that was asking
  about work that just went stale. Refused while a stage is running; nothing written in either case.
- Fixed the face rules: "no visible faces" no longer reads as ambiguous, "faces appear" no longer
  reads as a prohibition. Verified in both directions.
- `public/studio.js` now reveals the hidden `Other` boxes and restates the four choices live — it
  may not re-derive the face direction, so the saved clause is carried in `data-face`.
