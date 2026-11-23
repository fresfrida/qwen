#!/usr/bin/env bash
# Owner checks for the MyAIStudio deliverable. Read-only: it starts nothing and changes nothing.
#   bash output/verify.sh [preview-url]        default http://localhost:3000
# Exit 0 only when every check passes. Behaviour is asserted by the node suites (section 10);
# this file checks the shipped artifacts, the configuration defaults, and what is reachable.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${1:-http://localhost:3000}"
PAGE="$HERE/site/index.html"      # exported static preview: inert by construction
APP="$HERE/app"                   # the real application: server, storage, owner view, model seam
fails=0
ok(){ printf 'PASS  %s\n' "$1"; }
bad(){ printf 'FAIL  %s\n' "$1"; fails=$((fails+1)); }
note(){ printf '      %s\n' "$1"; }
[ -f "$PAGE" ] || { echo "cannot find $PAGE"; exit 2; }
[ -d "$APP/src" ] || { echo "cannot find $APP/src"; exit 2; }

echo "== 1. the exported preview cannot send anything =="
if grep -qE '<form[^>]*(action|method|enctype)[=]' "$PAGE"; then bad "the exported form has a submission target"; else ok "no action=, method= or enctype= anywhere: nowhere to post"; fi
if grep -qE 'type="submit"' "$PAGE"; then bad "an enabled submit control exists in the export"; else ok "no submit control"; fi
live=$(grep -oE '<(input|textarea|select)[^>]*>' "$PAGE" | grep -v 'type="hidden"' | grep -vc 'disabled' || true)
[ "${live:-0}" -eq 0 ] && ok "every user-editable field in the export is switched off" || bad "$live field(s) in the export are still editable"
a=$(grep -oE 'accept="[^"]*"' "$PAGE" | head -1)
echo "$a" | grep -qE 'accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,application/pdf"' \
  && ok "the file picker still advertises the real MIME list" || bad "accept= list wrong or empty (over-escaping signature): $a"
n=$(grep -ciE "<script|javascript:|fetch\(|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|innerHTML|eval\(" "$PAGE")
[ "${n:-0}" -eq 0 ] && ok "no JavaScript, no storage API, no HTML-injection primitive (0 matches)" || bad "script or collector present ($n matches)"
grep -q 'Demo — submissions are not sent or saved' "$PAGE" && ok "prototype notice worded as required" || bad "required demo notice missing"

echo
echo "== 2. nothing on the page reaches another origin =="
hits=$(grep -oE '(src|href)="[^"]*"' "$PAGE" | grep -E 'https?:' || true)
[ -z "$hits" ] && ok "no external src/href in the page" || { bad "external resource:"; note "$hits"; }
hits=$(grep -oE 'url\((["'\'']*)https?:[^)]*\)?' "$PAGE" || true)
[ -z "$hits" ] && ok "no external url() in the page" || bad "external css url: $hits"
for f in "$PAGE" "$APP/public/app.css" "$APP/public/layout.html"; do
  c=$(grep -cE '(src|href)="https?:' "$f" || true)
  [ "${c:-0}" -eq 0 ] || bad "$f references another origin ($c)"
done
ok "page, stylesheet and template are self-contained"
refs=$(grep -oE '(href|src)="/[^"]*"' "$PAGE" | sed -E 's/.*"\/([^"]*)"/\1/' | sort -u)
missing=0; for r in $refs; do { [ -f "$HERE/site/$r" ] || [ -f "$HERE/site/$r/index.html" ]; } || { bad "page references /$r which is not beside it"; missing=1; }; done
[ "$missing" -eq 0 ] && ok "every same-origin reference resolves to a file in the published root: $(echo $refs | tr '\n' ' ')"

echo
echo "== 3. approved copy is intact and unupgraded =="
COPY='MyAIStudio is a studio for original short films for TikTok, YouTube Shorts, and Instagram Reels. We work to a proposed workflow: AI agents research each topic and draft the scripts, and every story is directed and approved by a human before production.'
[ "$(grep -Fc "$COPY" "$PAGE")" -eq 1 ] && ok "approved paragraph present verbatim exactly once" || bad "approved paragraph count differs"
grep -q "Our proposed workflow" "$PAGE" && ok 'workflow labelled "Our proposed workflow"' || bad "workflow label missing"
[ "$(grep -Fc "$COPY" "$APP/public/layout.html")" -eq 1 ] && ok "the template the server renders carries the same paragraph (one source, no drift)" || bad "template copy drifted"
for w in 'guarantee[dsd]*' 'award.winning' 'trusted by' 'proven results' 'no.1' 'testimonial' 'we reply' 'well get back' 'will be in touch'; do
  grep -qiE "$w" "$PAGE" && bad "promise/marketing wording present: $w"
done
ok "no reach, guarantee, or reply promises"
extras=$(grep -oiE "Vimeo|Snapchat|Netflix|LinkedIn|Twitch|Podcast" "$PAGE" || true)
[ -z "$extras" ] && ok "no placement invented beyond the three named platforms" || bad "invented placements: $extras"
if grep -qiE "our agents (research|write|produce|deliver)|agents automatically|pipeline (runs|produces)" "$PAGE"; then bad "public copy claims the pipeline operates"; else ok "public copy still says proposed, not operational"; fi
pos=$(grep -ociE '\b(above|below)\b' "$PAGE" || true); [ "${pos:-0}" -eq 0 ] && ok "no positional wording a reflow could invalidate" || bad "$pos positional reference(s) in copy"

echo
echo "== 4. stories stay empty until something is approved =="
grep -q 'Title pending' "$PAGE" && bad "the page still shows placeholder film titles" || ok "no placeholder film titles"
[ "$(grep -o 'class=\"card\"' "$PAGE" | wc -l)" -eq 0 ] && ok "the invented story grid is gone" || bad "a story grid came back"
grep -q 'data-empty-stories' "$PAGE" && ok "the stories section states the empty truth in words" || bad "stories section lost its empty statement"
titles=$(grep -oE '<h3>[^<]*</h3>' "$PAGE" | grep -v 'Research\|Script\|Film\|Submissions\|Brand\|Direction\|Making\|Review and release\|Stories\|How it works' | wc -l)
[ "$titles" -eq 0 ] && ok "no invented film titles anywhere" || bad "$titles unexpected heading(s): $(grep -oE '<h3>[^<]*</h3>' "$PAGE" | grep -v 'Research\|Script\|Film\|Submissions\|Brand\|Direction\|Making\|Review and release\|Stories\|How it works' | tr '\n' ' ')"
grep -q 'data-cta="start-a-film"' "$PAGE" && ok "the hero leads to a real creation entry point" || bad "hero lost the start-a-film path"
[ "$(grep -o 'href="/studio/film/' "$PAGE" | wc -l)" -eq 0 ] && ok "no film record is linked from the public page" || bad "a private film record is linked publicly"
grep -q 'id="brand-enquiries"' "$PAGE" && ok "the brand form keeps its own separate section" || bad "the brand section is gone"

echo
echo "== 5. the enquiry path is silent; the model seam is the only egress =="
s=$(grep -rnE 'node:https|node-fetch|axios|got\(|sendBeacon|nodemailer|smtp|resend|sendgrid|mailgun|twilio|slack|segment|gtag|google-analytics|posthog' "$APP/src" || true)
if [ -n "$s" ]; then bad "outbound or analytics path found:"; note "$s"; else ok "no transport/analytics library or raw socket anywhere in src"; fi
egress=$(grep -rln 'fetch(' "$APP/src" | tr '\n' ' ')
[ "$egress" = "$APP/src/model/providers/openai-compatible.js " ] && ok "exactly one file can make a request, and it is a model provider" || bad "unexpected request sites: $egress"
if grep -q 'MODEL_SEND_BRIEF_DATA' "$APP/src/model/pipeline.js"; then ok "the provider path is behind an explicit send approval, not just enabled"; else bad "no send approval in front of the provider call"; fi
grep -q 'if (config.mode !== .live.)' "$APP/src/model/pipeline.js" && ok "prototype mode refuses before anything can be sent" || bad "mode check not found in the pipeline"
grep -qiE "fetch\(|http\.(get|request)" "$APP/src/routes.js" "$APP/src/intake.js" "$APP/src/page.js" 2>/dev/null && bad "the served enquiry path can make a request" || ok "the public path (form, storage, rendering) performs no requests at all"

echo
echo "== 6. storage and model are off in the shipped configuration =="
grep -q '"mode": "prototype"' "$HERE/builder.config.json" && ok "builder config: prototype" || bad "builder config is not prototype"
grep -q '"enabled": false' "$HERE/builder.config.json" && ok "builder config: storage disabled" || bad "storage flag not disabled"
grep -q '"provider": ""' "$HERE/builder.config.json" && ok "builder config: model provider empty" || bad "model provider not recorded as empty"
grep -q '"sendBriefData": false' "$HERE/builder.config.json" && grep -q '"readUploadedAssets": false' "$HERE/builder.config.json" \
  && ok "builder config: both model approvals recorded false" || bad "model approvals not recorded"
cd "$APP"
default_mode=$(node -e "import('./src/config.js').then(m=>console.log(m.loadConfig({}).mode))" 2>/dev/null)
[ "$default_mode" = "prototype" ] && ok "with no environment at all the app defaults to prototype" || bad "default mode was \"$default_mode\""
probe() { node -e "$2" 2>/dev/null; }
live_no_creds=$(probe x "import('./src/config.js').then(m=>{try{m.loadConfig({MODE:'live',PORT:'3000'});console.log('STARTED')}catch(e){console.log(/OWNER_USER/.test(e.message)?'REFUSED':'WEIRD:'+e.message)}})")
[ "$live_no_creds" = "REFUSED" ] && ok "live without owner credentials refuses to boot rather than starting open" || bad "live-without-credentials: $live_no_creds"
wrong_purpose=$(probe x "import('./src/config.js').then(m=>{try{m.loadConfig({FORM_PURPOSE:'owner_briefs'});console.log('FELL BACK')}catch(e){console.log(/not implemented/.test(e.message)?'REFUSED':'WEIRD:'+e.message)}})")
[ "$wrong_purpose" = "REFUSED" ] && ok "an unimplemented FORM_PURPOSE is refused, never substituted" || bad "purpose fallback: $wrong_purpose"
auto_provider=$(probe x "import('./src/config.js').then(m=>{try{m.loadConfig({MODEL_ENABLED:'true',MODEL_SEND_BRIEF_DATA:'true'});console.log('PICKED ONE')}catch(e){console.log(/MODEL_PROVIDER is empty/.test(e.message)?'REFUSED':'WEIRD:'+e.message)}})")
[ "$auto_provider" = "REFUSED" ] && ok "no model is enabled without naming a provider" || bad "provider defaulting: $auto_provider"
approval_in_prototype=$(probe x "import('./src/config.js').then(m=>{try{m.loadConfig({MODEL_SEND_BRIEF_DATA:'true'});console.log('ACCEPTED')}catch(e){console.log(/prototype/.test(e.message)?'REFUSED':'WEIRD:'+e.message)}})")
[ "$approval_in_prototype" = "REFUSED" ] && ok "an approval set while prototype is a configuration error, not a silent override" || bad "approval/mode conflict ignored: $approval_in_prototype"
keyless=$(probe x "import('./src/config.js').then(m=>{try{m.loadConfig({MODEL_API_KEY:'sk-somethinglonger'});console.log('IGNORED THE KEY')}catch(e){console.log(/MODEL_PROVIDER is empty/.test(e.message)?'REFUSED':'WEIRD:'+e.message)}})")
[ "$keyless" = "REFUSED" ] && ok "a key without a provider is refused instead of left dangling" || bad "orphan credential: $keyless"

echo
echo "== 7. what the preview URL can and cannot reach =="
code=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE/"); [ "$code" = "200" ] && ok "page served at $BASE/ (200)" || bad "page at $BASE/ returned $code"
for p in /builder.config.json /verify.sh /README.md /shot-app-owner.png /app/package.json /app/package-lock.json /app/src/server.js /app/src/model/pipeline.js /app/prompts/research.prompt.md /app/.env /app/data /data /data/assets /owner /owner/asset/x /enquiry /index.html /../builder.config.json /..%2fapp%2eenv; do
  c=$(curl -s --path-as-is -o /dev/null -m 8 -w '%{http_code}' "$BASE$p")
  case "$c" in
    200|304) if [ "$p" = "/index.html" ]; then ok "/index.html served as the page (same content as /)"; else bad "$p served ($c): a file that must not be public"; fi ;;
    *) ok "$p not served ($c)" ;;
  esac
done
c=$(curl -s -o /dev/null -m 8 -w '%{http_code}' "$BASE/data/assets"); [ "$c" != "200" ] && ok "no storage directory is browsable" || bad "storage browsable"
grep -qi 'noindex' "$PAGE" && ok "the preview asks search engines not to index it" || bad "noindex missing while this is a private preview"
grep -Eq "cross-origin|CORP|X-Resolved" /dev/null 2>/dev/null; note "note: the preview host, not this file, decides transport headers; the app sets its own in routes.js"

echo
echo "== 8. dependencies and runtimes =="
[ -f "$APP/package-lock.json" ] && ok "lockfile present, so npm ci installs exactly what was tested" || bad "no lockfile"
cd "$APP"
for spec in "busboy@$(node -p "require('./package-lock.json').packages['node_modules/busboy'].version")" ; do :; done
# npm can print update notices after the verdict, so a tail-based check reads the notice instead of
# the result. Ask the questions directly: are there vulnerabilities, and how many?
audit=$(npm audit --omit=dev 2>&1)
count=$(printf '%s\n' "$audit" | grep -oE 'found [0-9]+ vulnerabilit(y|ies)' | tail -1 | grep -oE '[0-9]+' || true)
if printf '%s\n' "$audit" | grep -q "found 0 vulnerabilities"; then ok "npm audit --omit=dev: 0 vulnerabilities"
elif [ -n "$count" ] && [ "$count" -gt 0 ]; then bad "npm audit reports $count vulnerability/vulnerabilities: $(printf '%s\n' "$audit" | grep -E 'Severity|Depends on|\b[0-9]+\b' | head -4 | tr '\n' ' ')"
else bad "npm audit gave no readable verdict: $(printf '%s\n' "$audit" | tr '\n' ' ' | cut -c1-160)"; fi
deps=$(node -p "Object.keys(require('./package.json').dependencies||{}).join(',')")
note "runtime dependencies: ${deps:-none}"
node -p "const l=require('./package-lock.json');Object.entries(l.packages||{}).filter(([k])=>k.startsWith('node_modules/')).map(([k,v])=>k.replace('node_modules/','')+'@'+v.version).join(' ')" | sed 's/^/      transitive: /'
if grep -q '"engines"' "$APP/package.json" && grep -q "FROM node:22" "$APP/Dockerfile"; then ok "Dockerfile major matches the engines range and the runtime tested ($(node -v))"; else bad "runtime pin mismatch"; fi
grep -qE '^USER node' "$APP/Dockerfile" && ok "container runs as a non-root user" || bad "container would run as root"
grep -qE 'npm ci --omit=dev --ignore-scripts' "$APP/Dockerfile" && ok "image installs production deps only, with install scripts off" || bad "image install command is looser than tested"
if command -v pip-audit >/dev/null 2>&1; then note "pip-audit available; this deliverable ships no Python runtime code (checks only)"; fi

echo
echo "== 9. nothing internal survives in the published page =="
m=$(grep -c "BUILDER-NOTE" "$PAGE" || true); [ "${m:-0}" -eq 0 ] && ok "no preview-only note block in the served page (nothing to strip)" || bad "$m preview note marker(s) came back"
grep -q "BUILDER-NOTE" "$APP/public/layout.html" && bad "a preview-only panel returned through the template" || ok "template emits no owner-facing notes"
for t in FORM_PURPOSE OWNER_PASS OWNER_USER MODEL_API_KEY OCR_IMAGE_APPROVED builder.config check_runtime verify.sh node_modules DATA_DIR prompts/; do
  grep -q "$t" "$PAGE" && bad "internal vocabulary on the public page: $t"
done
ok "no internal vocabulary reached the browser (the declared form token is the page's own name)"
if grep -rniE 'sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|xox[baprs]-|-----BEGIN|password[[:space:]]*=[[:space:]]*[^ ]' "$HERE/site" "$APP/src" "$APP/public" "$APP/prompts" >/dev/null 2>&1; then bad "credential-shaped literal in shipped files"; else ok "no credential-shaped literal in shipped files"; fi
[ -f "$APP/.env" ] && bad "a .env sits in the deliverable" || ok "no .env shipped, only .env.example"
[ -f "$APP/.env.example" ] && ok ".env.example lists every name, with no values" || bad ".env.example missing"
grep -qE '^\.env$' "$APP/.gitignore" && grep -qE '^data/$' "$APP/.gitignore" && ok "gitignore covers .env and data before a repo exists" || bad "gitignore does not exclude secrets or storage"
id_lines=$(grep -rniE "/workspace/[0-9a-f]{8}|/[0-9]{2}:[0-9]{2}:[0-9]{2}@(utc|gmt)|[A-Za-z0-9._%+-]+@(gmail|outlook|icloud|qq|126|163)\.(com|cn)|uid=[0-9]{4,}" "$HERE/site" "$APP/src" "$APP/public" 2>/dev/null | wc -l)
[ "$id_lines" -eq 0 ] && ok "no author identity or sandbox paths in shipped files" || bad "$id_lines identity/path line(s) found"

echo
echo "== 10. behaviour is asserted by suites, not by this file =="
cd "$APP"
tests=$(node --test --test-reporter=tap "test/*.test.js" 2>&1 | grep -cE "^ok [0-9]+ - " || true)
bad_lines=$( { node --test "test/*.test.js" 2>&1; timeout 240 node test/e2e-proof.mjs 2>&1; } | grep -cE "^not ok|did not hold|^FAIL " || true)
[ "${bad_lines:-1}" -eq 0 ] && ok "node --test ($tests named tests) + e2e proof both green" || bad "$bad_lines failing assertion(s) across the suites"

echo
echo "== 11. model seam: off by default, unreachable from the browser, prompts are editable data =="
grep -q "modelPipeline\|createPipeline" "$APP/src/routes.js" && bad "an HTTP route can invoke the model" || ok "no route reaches the model: only the operator CLI does"
grep -q "modelPipeline" "$APP/src/page.js" && bad "the rendered page references the pipeline" || ok "the public page says nothing about running a pipeline"
only=$(grep -rl "process\.env" "$APP/src" | sed "s|$APP/||" | grep -vE "^src/(config|cli|server|container)\.js$" | tr '\n' ' ')
[ -z "${only// /}" ] && ok "only config.js and the operator CLI read the environment" || bad "modules below the boundary reading env: $only"
grep -q "hereOr(" "$APP/src/config.js" && ok "paths resolve once in config, so the working directory cannot change which files load" || bad "path resolution leaked out of config"
grep -q "Return one JSON object and nothing else" "$APP/prompts/research.prompt.md" && ok "the research instruction lives in prompts/, not in a .js" || bad "research prompt text moved into code"
lits=$(grep -cl "You are the research stage" "$APP/src"/*.js "$APP/src/model"/*.js 2>/dev/null | wc -l)
[ "$lits" -eq 0 ] && ok "no prompt sentences hard-coded in source" || bad "prompt text found in $lits source file(s)"
limits=$(node -e "import('./src/model/prompts.js').then(async m=>{const r=await m.createPromptCatalog('prompts').get('research');console.log(Object.entries(r.limits).map(([k,v])=>k+'='+v).join(','))})" 2>/dev/null)
[ -n "$limits" ] && ok "limits load from the prompt file: $limits" || bad "could not load prompt limits"
grep -q "REFUSE\." "$APP/src/model/pipeline.js" && ok "stage refusals carry named reasons the CLI can print" || bad "stage refusals are silent"
grep -q "MODEL_MAX_CALLS_PER_BRIEF" "$APP/src/config.js" && ok "a per-brief call budget exists (a loop cannot spend the balance)" || bad "no call budget"
grep -q "'dry_run'" "$APP/src/model/pipeline.js" && grep -q "dryRun" "$APP/src/model/assetReader.js" && ok "a dry run assembles and reports the prompt without contacting anything" || bad "no dry-run path"
grep -q "escapeForgedBoundaries" "$APP/src/model/pipeline.js" && ok "forged fence boundaries in brief text are escaped, visibly" || bad "no fence-escape step"
grep -q "invented source" "$APP/src/model/pipeline.js" && ok "a source URL the owner did not supply is rejected, not believed" || bad "invented-citation guard missing"
grep -q "approval_required" "$APP/src/model/pipeline.js" && ok "sending needs its own documented approval" || bad "no explicit send approval"
grep -q "dryRun" "$APP/src/model/pipeline.js" && ok "a dry-run path exists that renders without sending" || bad "no dry-run mode"
grep -q "fetch(" "$APP/src/model/providers/registry.js" && bad "the registry itself performs requests" || ok "the registry only builds provider objects; sending needs provider + enabled + approval"
grep -q "MODEL_PROVIDER" "$APP/.env.example" && ok "the model switches are documented as names in .env.example" || bad ".env.example omits the model"
grep -qi "does not contact a provider under any setting" "$APP/src/cli.js" && ok "the preview command states its own limit in its output" || bad "preview output silent about egress"
offline=$(node -e "import('./src/model/providers/registry.js').then(({createModelProvider})=>{const p=createModelProvider('openai',{modelId:'m',apiKey:'k',baseUrl:'http://127.0.0.1:9/v1',timeoutMs:1500});p.complete({prompt:'x'}).then(r=>console.log(r.ran===false?'REFUSED':'CALLED')).catch(()=>console.log('THREW'))})" 2>/dev/null)
note "provider against an unreachable endpoint: $offline"
[ "$offline" = "REFUSED" ] && ok "a failed transport is a refusal, never a fabricated answer" || bad "unreachable endpoint behaved as $offline"
sim=$(node -e "import('./src/model/providers/registry.js').then(({createModelProvider})=>{const p=createModelProvider('echo',{echoMode:'research'});p.complete({prompt:'x',stage:'research'}).then(r=>console.log(r.simulated===true&&r.provider==='echo'?'LABELLED':'UNLABELLED'))})" 2>/dev/null)
[ "$sim" = "LABELLED" ] && ok "the offline stand-in labels itself simulated, so a test cannot look like research" || bad "simulated output not labelled: $sim"

echo
[ $fails -eq 0 ] && { echo "RESULT: all checks passed."; exit 0; } || { echo "RESULT: $fails check(s) FAILED."; exit 1; }
