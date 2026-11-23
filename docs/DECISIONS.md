# DECISIONS

## Forks in this prompt, and which one I took

1. **"If this environment cannot produce a downloadable file, say so."** It can: the zip is
   attached in-session as a deliverable (`myaistudio-snapshot.zip`, 82 files). So I took the
   attach-the-zip branch, not the explanation branch. I did **not** upload anything to cloud storage
   or create a share link — that is a separate outbound action you have not approved.
2. **"Leave the hero CTA pointing at the form until a Create section actually exists."** Taken
   literally: `public/layout.html` hero still says "Jump to the form". Making it say "Start a film"
   pointing at `#create` today would ship a dead anchor, which is the failure mode you are fixing.
   It changes in Step 2, in the same edit as the section itself.
3. **"Do not build the unwired layer modules or touch the brand enquiry form yet."** Respected:
   `lexicon.js` / `layers.js` were left with no importers; no form field, audience or prototype
   behaviour changed. Step 1 therefore contains no layer work at all.
4. **"Do not delete, skip or weaken a test to force green."** No test was deleted, skipped, or
   loosened. Where a test was itself wrong I changed the *test* and say so here, and where the
   product was wrong I changed the product.

## Product-side root causes and fixes

- **Badge leak.** Cause: two `{{MODE_BADGE}}` occurrences (nav, footer); `String.replace` with a
  string argument replaces only the first. Fix: substitute every token with `replaceAll`, then throw
  if any `{{TOKEN}}` survives, so a future duplicated token fails at build instead of shipping.
- **Crash recovery never ran.** `recoverInterrupted()` existed in `store.js` and had no caller, so a
  killed stage stayed `in_progress` forever and a refresh promised work nobody was doing. Fix: the
  server resolves orphaned claims before it serves a request. Recovery marks `failed`, keeps the
  error, and does not retry.
- **`close()` could hang.** Cause: keep-alive client sockets; `server.close()` waits for them.
  Consequence beyond tests: a restarting container can sit until the platform kills it. Fix: stop
  in-flight stage work, close idle connections, then force-close, bounded by timeouts.
- **"In progress" was unobservable.** Cause: the `run` action awaited the stage, so the browser
  either saw nothing or saw the finished result. Fix: claim + `303` answer, work continues against
  the record; the poll reads truth. This is what makes mid-run refresh and mid-run crash testable.
- **Dependency note:** no new packages. No `undici` import, no payment SDK, no tooltip library —
  the client script uses `connection: close` instead of a pooled dispatcher.

## Test-side corrections (the tests were wrong, the product was not)

- Hardcoded `version: '2'` after create. Nothing in the product promises a version number; the CAS
  contract is "the version you read". Tests now read `/studio/film/:id/status` and send that.
  The version-conflict and late-answer paths are now actually covered.
- A live-mode test asserted the *prototype* notice ("Demo — submissions are not sent or saved").
  In live mode the enquiry really is saved, so that assertion would have codified a lie. It now
  asserts the live honesty line and asserts the demo notice is absent.
- `assert.notMatch` is not Node's API; it crashed the test. Now `doesNotMatch`, so the assertion
  runs and proves something.
- The crash test called a graceful stop first, which let the process record its own shutdown —
  i.e. it tested a clean stop while claiming to test a crash. It now reads the record while the
  stage is genuinely still `in_progress`, then boots over the same directory.
- One fixture email (`a@b.example`) was refused by the existing work-email rule. The rule is
  protected behaviour, so I fixed the fixture (`buyer@acme-drinks.example`) rather than loosen
  validation, and said so in the test.

## Deliberately not done

- No payment provider, endpoint, key or checkout — Step 3 item 5 is a placeholder only.
- No generation calls, no credits spent, no publishing, no outbound messages.
- No git repo created; the environment had none. Rollback point is the snapshot zip.

## Open — needs you

1. **Deadline cut list.** Step 2 is one usable creation path (page restructure + CREATE + FILMS +
   wiring the existing layer modules). Step 3 has five sequenced items. If tonight cannot hold all
   six, which do you cut? My recommendation: land Step 2 plus Step 3 items 1 and 4, and treat 2, 3
   and 5 (destination, language, payment placeholder) as the cut — item 4 is the one that changes
   pipeline semantics, and item 1 is what makes the other fields comprehensible.
2. **Brand enquiry audience** — still unconfirmed by you; untouched by me.
3. **Payment model** — per film, credits, subscription, and who pays. Nothing may imply an answer.

## Step 2 — Start a film, the four brief layers, and the workspace door

**Fork taken: creation lives behind `/studio`, not on the public page.**
The public hero and nav now say "Start a film" and point at `/studio`, where the two entry choices
(Bring me ideas / Develop my idea) and the four layer fields live. The brand enquiry form stayed
where it was, as its own section, with its fields, its audience and its "stores nothing" behaviour
in prototype mode untouched. In live mode `/studio` still answers an anonymous request with 401 plus
`www-authenticate`, so the owner-only protection is unchanged; in prototype mode the workspace opens
with a visible banner saying it is not access-controlled. A public page cannot host the create form
without either exposing private briefs or faking them, so the honest split was kept and the CTA was
redirected rather than duplicated.

**Refused values are echoed, never selected.**
`parseLayerFields` returns the raw value you sent, marked `rejected`, when it is not in the
vocabulary. The form prints it in a `data-rejected` attribute so you can see what you typed, the
control stays on the documented default, the summary line says `not accepted`, and
`assertFilmShape` refuses to store a rejected value. Nothing is quietly defaulted: an unknown look
is a visible refusal, and nothing was written.

**`/studio` in a static export answers with its own limitation.**
Once the public page linked to `/studio`, the published root had to reply at that address. The
static export has no storage, no sign-in and no pipeline, so it writes an honest
`site/studio/index.html` that says so and links back, instead of a dead link or a mock workspace.

**HEAD became a read.** `HEAD /` and `HEAD /studio` used to fall through to 404, because every
route gated on the literal string `GET`. The preview probe caught this. Reads now accept GET or HEAD
through a `READ` predicate; every write path still gates strictly on `POST`, and Node drops the HEAD
body by itself. No HEAD request can start, advance or save anything.

**One exporter owns the preview root.** `npm run build` (`build/render-static.js`) is the only
writer of `output/site`, because it is the only place the enquiry form is made inert.
`build/export-site.js` emits the application page with live controls, and had overwritten the
preview with a submittable form — five `verify.sh` failures that were the check working, not
breaking. It now refuses to run unless `EXPORT_SITE_ALLOW=1` points it somewhere else.

**Tests that were corrected rather than weakened.**
`studio-http.test.js` asserted the public page must not contain the string `/studio`. The intent was
"no workspace data on a public page", so it now asserts the positive design (the hero reaches the
creation door) and the real danger (no `/studio/film/<id>` links, no saved-brief direction markup).
The live-mode sentence "Submissions are saved on this server and visible only to the studio" was
restored verbatim after my rewrite of the hero note nearly made live mode understate what saving
means. A failing HTTP test also left its server listening, which looked like a hung suite; the
helper now registers every boot and closes them in an `after` hook, so red is reported as red.
`verify.sh` stopped treating `npm`'s update notice as an audit verdict (it asks for the count now)
and accepts a directory with an index when checking that references resolve beside the page.

## Step 3 — Editing the four layers on a saved film

**Editing lives on the film page, and states its consequence before it is applied.**
`POST /studio/film/:id/layers` is the only write. The controls are the same `layerFields()` the entry
cards use, so a value that can be picked at creation can be picked afterwards and a value that would
be refused there is refused here. Above the form sits the rule itself, generated from `RESET_START`
rather than retyped: look → from the storyboard artist, genre/format/sound → from the scriptwriter,
and both approval gates withdrawn. If the rule changes, the sentence changes with it.

**Refusal happens before the record is opened for writing.**
`changeLayers` parses first. An unknown look returns 422 with `parseLayerFields`'s errors and never
reaches `store.update` — the tests compare the stored file byte-for-byte, not just the version number,
because "nothing was written" is a claim about the disk, not about a counter. A submission that changes
nothing writes nothing: it says "already the values on this brief, so no stage was reset" instead of
resetting stages for the sake of appearing to do something.

**The refused value is echoed but not applied.**
After a refusal the select still shows the look that is actually stored (`data-selected`), with what
you sent in `data-rejected` and the reason beside it. Snapping the control back to "let the studio
suggest" would have implied the brief now says that — the opposite of what happened.

**A stale page loses; it is not applied on top.**
The form carries the version it was reading. If another tab saved first, the compare-and-set drops
this write and says so. An edit while a stage is running is refused outright: leaving the run alone
and asking again after it settles is the only ordering that cannot produce a stage that finished
against a brief it was never given.

**Approvals are withdrawn, not inherited.** Changing direction sends the affected stages back and
clears both gates, including a gate that was mid-question about work that just went stale. The
question gets asked again after the rework; a release approval given to the older version cannot be
read as approval of this one.

**Bug found while wiring this: "no visible faces" was being read as no instruction at all.**
The face rules matched permission and prohibition in the same sentence. `ALLOW` contained
`visible faces`, which is a substring of "no visible faces", so the studio's most common faceless
instruction came out as *both* and got reported as ambiguous, dropping the clause from the saved
brief. A second defect sat in `AVOID`, whose optional `not` let "faces appear" look like a
prohibition. Both patterns now require an actual negation, and permission is tested against text with
the prohibitions masked out (`AVOID_G`, derived from `AVOID` itself so the two lists cannot drift).
`test/studio-layers.test.js` and the face table in `test/studio.test.js` pin phrasings in both
directions: `no visible faces`/`faces never appear`/`faces cannot be seen` refuse, `faces appear in
the second half`/`with faces`/`characters may be seen` allow, `no faces, but with faces` is unclear,
and `faceless` alone still means "no presenter", which is not the same claim.

**Face direction is never re-derived in the browser.**
`faceDirection` reads prose, and prose the browser has not read cannot be judged by it. So the saved
clause is carried through `data-face`, and an unsent form prints "face direction not set yet" instead
of pretending the notes had been interpreted. `public/studio.js` may rewrite the four choices; it may
not invent a fifth fact.

**Near-miss worth recording: a rebase deleted the working tree.**
`git rebase --onto origin/main $(git rev-list --max-parents=0 HEAD) main` had nothing to replay, so
it hard-reset to their stub commit and removed every file my commit tracked — the whole `app/src` tree
and `docs/`, which survived only as a dangling commit. It also deleted `.gitignore` on the way, and the
next `git add -A` quietly staged `node_modules`, screenshots, the generated `site/`, and
`preview-data/studio/film-*.json` — a real film record. Nothing was pushed; the good tree was recovered
with `git read-tree` + `git checkout-index`, the junk commit was pruned with
`reflog expire --expire-unreachable=now --all && git gc --prune=now`, and the rebuilt commit is 79
tracked files with those patterns ignored. Lesson kept as a rule: never rebase a root commit onto
someone else's history, and check `git status` *after* staging, not before.
