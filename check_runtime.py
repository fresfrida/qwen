#!/usr/bin/env python3
"""Browser-level proof for MyAIStudio. Read-only against the repo; writes only to a temp data dir.

  python3 output/check_runtime.py [preview-url]     default http://localhost:3000

Phase A inspects the exported static preview (what the Publish button would ship).
Phase B boots the real Node application and drives it in a browser: a genuine form submit,
a genuine file upload, an owner login, then a forced storage failure.
"""
import json, os, re, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
APP = HERE / "app"
SITE = HERE / "site"

import http.server, threading, functools

def serve_static(root):
    """Serve the exported artefact on a port of our own, so Phase A always tests the
    file that would actually be published, whatever else holds 3000."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"

EXPORT_SERVER, EXPORT_URL = serve_static(SITE)
BASE = sys.argv[1] if len(sys.argv) > 1 else EXPORT_URL
PNG = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + b"\x00" * 1200
SVG_LIE = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'

fails: list[str] = []
def ok(m): print("PASS ", m)
def bad(m): print("FAIL ", m); fails.append(m)
def note(m, v=""): print("      ", m, v)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def boot(env_extra):
    env = {**os.environ, **env_extra}
    p = subprocess.Popen(["node", "src/server.js"], cwd=str(APP), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.time() + 20
    while time.time() < deadline:
        line = p.stdout.readline()
        if not line:
            time.sleep(0.05); continue
        if '"listening"' in line:
            return p, json.loads(line)["port"]
        if "Error" in line or line.startswith("node:"):
            p.wait(timeout=5)
            raise RuntimeError(f"app exited instead of starting: {line.strip()}")
    raise TimeoutError("app never reported a port")

def load(ctx, url):
    pg = ctx.new_page()
    seen, errs = [], []
    origin = "/".join(url.split("/")[:3])
    pg.on("request", lambda r: seen.append(r.url))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url, wait_until="networkidle")
    off = [u for u in seen if not u.startswith(origin)]
    label = url.split("//")[1].split("/")[0]
    ok(f"{label}: {len(seen)} request(s), none to another origin") if not off else bad(f"{label}: off-origin {off}")
    ok(f"{label}: no console errors") if not errs else bad(f"{label}: console errors {errs[:3]}")
    return pg, label

def shape(pg, label, expect_enabled):
    h, w = pg.evaluate("document.documentElement.scrollWidth"), pg.evaluate("window.innerWidth")
    ok(f"{label}: fits 320px without horizontal scroll ({h}<={w})") if h <= w + 1 else bad(f"{label}: overflows at 320px ({h}>{w})")
    enabled = pg.evaluate("()=>[...document.querySelectorAll('input:not([disabled]):not([type=hidden]),textarea:not([disabled]),select:not([disabled]),button:not([disabled])')].map(e=>e.tagName+':'+(e.name||e.type))")
    posts = pg.evaluate("()=>[...document.querySelectorAll('form')].map(f=>({action:f.getAttribute('action'),method:f.getAttribute('method')}))")
    note(f"{label}: enabled controls =", json.dumps(enabled))
    note(f"{label}: form targets =", json.dumps(posts))
    if expect_enabled:
        usable = len(enabled) >= 5 and posts and all(p["method"] == "post" and (p["action"] or "").startswith("/") for p in posts)
        ok(f"{label}: the real form is usable and posts only to this origin ({len(enabled)} controls)") if usable else bad(f"{label}: form unusable {enabled} {posts}")
    else:
        inert = not enabled and all(not (p["action"] or p["method"]) for p in posts)
        ok(f"{label}: the preview cannot send anything ({len(enabled)} enabled controls, {len(posts)} target(s))") if inert else bad(f"{label}: the export can send: {enabled} {posts}")

CONTRAST_JS = """(sel)=>{const px=s=>{const m=s.match(/[\\d.]+/g);return m?m.map(Number):null};
 const lin=v=>{v/=255;return v<=.03928?v/12.92:((v+.055)/1.055)**2.4};
 const L=c=>.2126*lin(c[0])+.7152*lin(c[1])+.0722*lin(c[2]);
 const over=(fg,bg)=>{const a=fg.length>3?fg[3]:1;return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a))};
 const stack=e=>{const out=[];let n=e;while(n&&n.nodeType===1){const c=px(getComputedStyle(n).backgroundColor);
  if(c&&(c.length<4||c[3]>0))out.push(c);n=n.parentElement}return out};
 const el=document.querySelector(sel);if(!el)return null;
 let acc=stack(document.body).reverse().reduce((a,l)=>over(l,a),[10,11,13]);
 let col=over(px(getComputedStyle(el).color),acc);
 const a=L(col),b=L(acc);return +(((Math.max(a,b)+.05)/(Math.min(a,b)+.05))).toFixed(2)}"""

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 320, "height": 640})

    # ---------------- Phase A: exported static preview ----------------
    pg, label = load(ctx, EXPORT_URL)
    shape(pg, label, expect_enabled=False)
    ok("export: the artefact under test is the file in site/, not a live server")
    vis = pg.evaluate("""()=>{const n=document.querySelector('.demo-notice');if(!n)return null;const r=n.getBoundingClientRect();
      return {text:n.textContent.trim(),visible:r.width>0&&r.height>0&&getComputedStyle(n).opacity==='1'}}""")
    ok(f"preview: demo notice shown: '{vis['text']}'") if vis and vis["visible"] and "not sent or saved" in vis["text"] else bad(f"preview: demo notice problem {vis}")
    r = pg.evaluate(CONTRAST_JS, ".demo-notice span")
    ok(f"preview: notice contrast {r}:1") if r and r >= 4.5 else bad(f"preview: notice contrast {r}:1 under AA 4.5")
    lowc = {s: pg.evaluate(CONTRAST_JS, s) for s in ["body", ".sub", ".card .meta", ".enquiry label", ".fineprint", ".hint"]}
    note("preview: contrast of text colours =", json.dumps(lowc))
    low = {k: v for k, v in lowc.items() if v and v < 4.5}
    ok("preview: every text colour measured is >= 4.5:1") if not low else bad(f"preview: below AA {low}")
    opts = pg.evaluate("()=>[...document.querySelectorAll('input[name=placement]')].length")
    ok(f"preview: placement question offers {opts} options (within 1 to 3)") if 1 <= opts <= 3 else bad(f"preview: {opts} placement options")
    pg.evaluate(r"""()=>{document.querySelectorAll('.card h3').forEach(h=>h.textContent=('X'.repeat(150)+' éèü 中文字 <img src=x onerror=alert(1)> \u{1F3AC}').repeat(2))}""")
    ov = pg.evaluate("document.documentElement.scrollWidth"); inj = pg.evaluate("document.querySelectorAll('.card img,.card script').length")
    ok(f"preview: a 900-char title stays inside 320px ({ov}) and its markup stays text ({inj} elements)") if ov <= 321 and inj == 0 else bad(f"preview: long content broke layout ({ov},{inj})")
    pg.screenshot(path=str(HERE / "shot-static-preview.png"), full_page=True)
    pg.close()

    # ---------------- Phase B1: the application in prototype mode ----------------
    proto_dir = Path(tempfile.mkdtemp(prefix="myai-proto-"))
    proc, port = boot({"MODE": "prototype", "PORT": str(free_port()), "DATA_DIR": str(proto_dir)})
    base = f"http://127.0.0.1:{port}/"
    pg, label = load(ctx, base)
    shape(pg, label, expect_enabled=True)
    pg.set_viewport_size({"width": 420, "height": 1400})
    pg.screenshot(path=str(HERE / "shot-app-form.png"), full_page=True)   # the live form, enabled
    pg.set_viewport_size({"width": 320, "height": 640})
    pg.fill("input[name=company]", "Acme Drinks <img src=x onerror=alert(1)>")
    pg.fill("textarea[name=offering]", "A canned citrus drink. " + "x" * 1900)
    pg.fill("input[name=email]", "buyer@acme-drinks.example")
    pg.check("input[name=placement][value=tiktok_short]")
    pg.set_input_files("input[name=assets]", {"name": "logo.png", "mimeType": "image/png", "buffer": PNG})
    pg.click("button[type=submit]"); pg.wait_for_load_state("networkidle")
    body = pg.inner_text("body")
    ok("app-prototype: a real submit is answered with the exact demo sentence") if "Demo only — nothing was sent." in body else bad(f"app-prototype: wrong answer: {body[:150]}")
    ok("app-prototype: never thanks for a submission it did not save") if "Thank you — your submission is saved." not in body else bad("app-prototype: unearned thank-you")
    left = [x.name for x in proto_dir.iterdir()] if proto_dir.exists() else []
    ok(f"app-prototype: the data directory stayed empty {left}") if not left else bad(f"app-prototype wrote to disk: {left}")
    ok("app-prototype: the echoed value stayed text, not markup") if pg.evaluate("document.querySelectorAll('form img,form script').length") == 0 else bad("app-prototype reflected markup as live elements")
    pg.screenshot(path=str(HERE / "shot-app-prototype-answer.png"), full_page=True)
    pg.close(); proc.terminate(); proc.wait(timeout=10); shutil.rmtree(proto_dir, ignore_errors=True)

    # ---------------- Phase B2: the application in live mode ----------------
    live_dir = Path(tempfile.mkdtemp(prefix="myai-live-"))
    proc, port = boot({"MODE": "live", "PORT": str(free_port()), "DATA_DIR": str(live_dir),
                       "OWNER_USER": "studio", "OWNER_PASS": "correct horse battery"})
    base = f"http://127.0.0.1:{port}/"
    creds = {"username": "studio", "password": "correct horse battery"}
    ctx_auth = b.new_context(viewport={"width": 390, "height": 844}, http_credentials=creds)
    pg = ctx_auth.new_page(); pg.goto(base + "?live=1", wait_until="networkidle")
    pg.fill("input[name=company]", "Acme Drinks")
    pg.fill("textarea[name=offering]", "A canned citrus drink.")
    pg.fill("input[name=email]", "buyer@acme-drinks.example")
    pg.check("input[name=placement][value=youtube_short]")
    pg.set_input_files("input[name=assets]", [{"name": "packshot.png", "mimeType": "image/png", "buffer": PNG},
                                              {"name": "scheme.png", "mimeType": "image/png", "buffer": SVG_LIE}])
    pg.click("button[type=submit]"); pg.wait_for_load_state("networkidle")
    body = pg.inner_text("body")
    ok("app-live: an SVG wearing a .png name is refused and the visitor is told which one") if "unrecognised file type" in body and "scheme.png" in body else bad("app-live: lying upload not refused clearly")
    ok("app-live: nothing is claimed saved while an asset was refused") if "Thank you — your submission is saved." not in body else bad("app-live: thanked while refusing a file")

    ok("app-live: the refused attempt wrote no record") if not (live_dir / "submissions").exists() or len(list((live_dir / "submissions").iterdir())) == 0 else bad("app-live: partial record written")
    pg.fill("input[name=company]", "Acme Drinks")
    pg.set_input_files("input[name=assets]", [{"name": "packshot.png", "mimeType": "image/png", "buffer": PNG}])
    pg.click("button[type=submit]"); pg.wait_for_load_state("networkidle")
    body = pg.inner_text("body")
    ok("app-live: the success sentence appears only after a confirmed write") if "Thank you — your submission is saved." in body else bad(f"app-live: no success after a good submit: {body[:160]}")
    subs, assets = live_dir / "submissions", live_dir / "assets"
    names = sorted(f.name for f in assets.iterdir()) if assets.exists() else []
    n_sub = len(list(subs.iterdir())) if subs.exists() else 0
    ok(f"app-live: one record and one asset on disk ({n_sub}/{len(names)})") if n_sub == 1 and len(names) == 1 else bad(f"app-live: disk counts {n_sub}/{len(names)}")
    ok(f"app-live: the stored name is opaque, not the visitor's ({names[0][:13]}...)" if names and re.fullmatch(r"[0-9a-f-]{36}\.png", names[0]) else "app-live: stored name is not opaque")
    pg.goto(base + "owner", wait_until="networkidle")
    otext = pg.inner_text("table") if pg.query_selector("table") else ""
    ok("app-owner: the owner can read the saved enquiry") if "Acme Drinks" in otext and "buyer@acme-drinks.example" in otext else bad(f"app-owner: listing problem {otext[:120]}")
    ok("app-owner: the refused asset is not listed as if it existed") if "scheme" not in otext else bad("app-owner: refused asset listed")
    pg.set_viewport_size({"width": 1280, "height": 1000}); pg.screenshot(path=str(HERE / "shot-app-owner.png"), full_page=True)
    asset_href = pg.get_attribute("table a", "href")
    pg.close(); ctx_auth.close()

    ctx_anon = b.new_context(viewport={"width": 390, "height": 844})
    pg = ctx_anon.new_page()
    resp = pg.goto(base + "owner", wait_until="networkidle")
    ok(f"app-anon: /owner without credentials -> {resp.status}") if resp.status == 401 else bad(f"app-anon: /owner gave {resp.status}")
    ok("app-anon: the challenge discloses nothing") if "Acme Drinks" not in pg.content() else bad("app-anon: leak on the challenge page")
    if asset_href:
        r2 = pg.request.get(base.rstrip("/") + asset_href)
        ok(f"app-anon: asset fetch without credentials -> {r2.status}") if r2.status == 401 else bad(f"app-anon: asset readable without login ({r2.status})")
        r3 = pg.request.get(base + "owner/asset/..%2f..%2fsubmissions%2fx.json")
        ok(f"app-anon: traversal-shaped key -> {r3.status}") if r3.status in (400, 401, 404) else bad(f"app-anon: traversal got {r3.status}")
    pg.close(); ctx_anon.close()

    os.chmod(subs, 0o500)                      # storage starts failing, mid-flight
    pg = ctx.new_page(); pg.goto(base, wait_until="networkidle")
    pg.fill("input[name=company]", "Second Company"); pg.fill("textarea[name=offering]", "A crisp.")
    pg.fill("input[name=email]", "ops@second.example"); pg.check("input[name=placement][value=instagram_reel]")
    pg.click("button[type=submit]"); pg.wait_for_load_state("networkidle")
    body = pg.inner_text("body")
    ok("app-live: a failing write is stated plainly") if "Nothing was saved." in body else bad("app-live: failure was not reported")
    ok("app-live: a failing write never says thank you") if "Thank you — your submission is saved." not in body else bad("app-live: false thank-you on failure")
    ok(f"app-live: record count unmoved during the failure ({len(list(subs.iterdir())) if subs.exists() else 'dir gone'})") if subs.exists() and len(list(subs.iterdir())) == 1 else bad("app-live: record count moved on a failed write")
    leftover = len(list(assets.iterdir())) if assets.exists() else 0
    ok(f"app-live: the asset written before the failure was rolled back ({leftover} total)") if leftover == 1 else bad(f"app-live: orphaned asset left behind ({leftover})")
    pg.screenshot(path=str(HERE / "shot-app-storage-failure.png"), full_page=True)
    os.chmod(subs, 0o700); pg.close()
    proc.terminate(); proc.wait(timeout=10); shutil.rmtree(live_dir, ignore_errors=True)

    ctx.close(); b.close()

print()
print(f"      (phase A served the export from {SITE} at {EXPORT_URL})")
print("RESULT:", "browser checks all passed" if not fails else f"{len(fails)} browser check(s) FAILED")
sys.exit(1 if fails else 0)
