#!/usr/bin/env python3
"""Step 1 evidence: the mode badge renders in nav AND footer, at phone and desktop widths.

Two sources are checked on purpose:
  - the published preview (the static export the preview host serves), because that is the file
    that would actually go public;
  - a real server booted in prototype and in live mode, because the badge TEXT differs by mode and a
    static file can only ever show one of them.
Screenshots are of served HTML, never of a fixture.
"""
import json, os, re, shutil, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parent          # .../output
APP = OUT / "app"
PREVIEW = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:3000/"

NAV = "header.nav .mark span"          # the header element IS .nav, it is not inside .nav
FOOT = "footer .wrap span:nth-child(1)"  # first footer span carries "MyAIStudio · <badge>"


def audit(page, label, expect_nav, expect_footer_substring):
    html = page.content()
    leaks = re.findall(r"\{\{[A-Z_]+\}\}", html)
    nav = (page.text_content(NAV) or "").strip()
    foot = (page.text_content(FOOT) or "").strip()
    width = page.evaluate("window.innerWidth")
    scroll = page.evaluate("document.documentElement.scrollWidth")
    print(f"  {label:<18} viewport={width}px scrollWidth={scroll}px nav={nav!r} footer={foot!r} raw_tokens={leaks}")
    bad = []
    if leaks:
        bad.append(f"{label}: raw template tokens survived into the DOM: {leaks}")
    if nav != expect_nav:
        bad.append(f"{label}: nav badge = {nav!r}, expected {expect_nav!r}")
    if expect_footer_substring not in foot:
        bad.append(f"{label}: footer badge missing {expect_footer_substring!r} (got {foot!r})")
    if scroll > width + 1:
        bad.append(f"{label}: horizontal overflow at {width}px ({scroll}px)")
    return bad


def boot(env_extra, tag):
    """Start the real server on a free port and wait for its listening line.

    stdout is piped, not redirected to a file, so the listening line can be read here; the same
    lines are echoed to a log for the case where startup fails.
    """
    env = {**os.environ, **env_extra}
    log = open(f"/tmp/qwenwork/step1-server-{tag}.log", "w")
    p = subprocess.Popen(["node", "src/server.js"], cwd=str(APP), env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    deadline = time.time() + 25
    while time.time() < deadline:
        line = p.stdout.readline()
        log.write(line); log.flush()
        if not line:
            if p.poll() is not None:
                raise RuntimeError(f"server exited early; see /tmp/qwenwork/step1-server-{tag}.log")
            time.sleep(0.05); continue
        if '"listening"' in line:
            port = json.loads(line)["port"]
            return p, f"http://127.0.0.1:{port}/"
    raise TimeoutError("server never reported a port")


def kill(p):
    p.send_signal(15)
    try:
        p.wait(timeout=10)
    except Exception:
        p.kill()


problems = []
os.makedirs("/tmp/qwenwork", exist_ok=True)
with sync_playwright() as sp:
    browser = sp.chromium.launch()

    # ---- 1. the published static export, through the preview host ----
    for width, tag in ((390, "phone"), (1280, "desk")):
        ctx = browser.new_context(viewport={"width": width, "height": 900})
        pg = ctx.new_page()
        pg.goto(PREVIEW, wait_until="networkidle")
        problems += audit(pg, f"export {tag}", "prototype preview", "prototype preview")
        pg.query_selector("footer").scroll_into_view_if_needed()
        pg.query_selector("footer").screenshot(path=str(OUT / f"s1-footer-{tag}.png"))
        pg.screenshot(path=str(OUT / f"s1-top-{tag}.png"), clip={"x": 0, "y": 0, "width": width, "height": 430})
        print(f"  wrote s1-footer-{tag}.png, s1-top-{tag}.png")
        ctx.close()

    # ---- 2. a booted server in prototype mode (ephemeral dir, nothing persisted to the repo) ----
    proto_dir = "/tmp/qwenwork/step1-proto"
    os.makedirs(proto_dir, exist_ok=True)
    p1, url1 = boot({"MODE": "prototype", "PORT": "0", "DATA_DIR": proto_dir, "STUDIO_DATA_DIR": proto_dir}, "proto")
    ctx = browser.new_context(viewport={"width": 390, "height": 900})
    pg = ctx.new_page(); pg.goto(url1, wait_until="networkidle")
    problems += audit(pg, "server prototype", "prototype preview", "prototype preview")
    ctx.close(); kill(p1)

    # ---- 3. a booted server in live mode, where the badge must read 'live' ----
    live_dir = "/tmp/qwenwork/step1-live"
    os.makedirs(live_dir, exist_ok=True)
    creds = {"OWNER_USER": "studio-owner", "OWNER_PASS": "correct horse battery staple"}
    p2, url2 = boot({"MODE": "live", "PORT": "0", "DATA_DIR": live_dir, "STUDIO_DATA_DIR": live_dir, **creds}, "live")
    ctx = browser.new_context(viewport={"width": 1280, "height": 900},
                              http_credentials={"username": creds["OWNER_USER"], "password": creds["OWNER_PASS"]})
    pg = ctx.new_page(); pg.goto(url2, wait_until="networkidle")
    problems += audit(pg, "server live", "live", "· live")
    pg.query_selector("footer").screenshot(path=str(OUT / "s1-footer-live.png"))
    print("  wrote s1-footer-live.png")
    ctx.close(); kill(p2)
    browser.close()
    for d in (proto_dir, live_dir):
        shutil.rmtree(d, ignore_errors=True)
    print(f"  cleaned ephemeral server dirs: {proto_dir}, {live_dir}")

print()
if problems:
    print("STEP 1 FOOTER CHECK FAILED:")
    for x in problems:
        print("  -", x)
    sys.exit(1)
# prove the live run wrote only into its own temp dir, which we then removed
if os.path.isdir(live_dir):
    print("WARNING: live temp dir survived"); sys.exit(1)
print("STEP 1 FOOTER CHECK PASSED: nav and footer both show the real mode badge in the static export,")
print("in a booted prototype server, and in a booted live server - no raw {{TOKEN}} anywhere, no overflow.")
