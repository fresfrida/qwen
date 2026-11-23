// The only client script in the build. Three jobs, all of them presentation:
//   1. show a stage that runs in the background, without the owner guessing when to refresh;
//   2. reveal the "Other" text box when Other is chosen, because a hidden field nobody can reach is
//      a form that lies about what it accepts;
//   3. restate the four layers in one line as they are picked, reading only labels that are already
//      in the page - it invents nothing, and it never claims progress the record has not made.
// It reads the stored record and nothing else: it never starts a stage, never retries one, and
// stops as soon as nothing is running.
(() => {
  const host = document.getElementById('poll-status');
  if (!host) return;
  const filmId = host.dataset.film;
  const every = Math.max(700, Number(host.dataset.interval) || 1200);
  let version = Number(host.dataset.version) || 0;
  let wasRunning = host.dataset.state === 'running';
  let timer = null;
  let stopped = false;
  let reloads = 0;

  const stop = (why) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (why) host.textContent = why;
  };

  const stageName = (key, record) => {
    const card = document.querySelector(`[data-stage="${key}"] h4`);
    if (card) return card.textContent;
    const found = (record.status && record.status.stage === key) ? record.status.label : key;
    return found;
  };

  const describe = (s) => {
    if (s.running.length) return `${stageName(s.running[0], s)} is working. Reading the record every ${Math.round(every / 1000)}s.`;
    if (s.waitingOnYou.length) return `Nothing is running. ${stageName(s.waitingOnYou[0], s)} needs your decision.`;
    if (s.failed.length) return `Nothing is running. ${stageName(s.failed[0].stage, s)} failed and will not retry itself.`;
    return `Nothing is running. ${s.status.label}.`;
  };

  const tick = async () => {
    if (stopped) return;
    if (document.hidden) return;                        // never poll a hidden tab
    let s;
    try {
      const r = await fetch(`/studio/film/${filmId}/status`, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!r.ok) return stop('The studio stopped answering this record. Nothing was changed by this page - refresh to read it again.');
      s = await r.json();
      if (!s.ok) return stop('This film could not be read. Nothing was changed by this page.');
    } catch {
      return stop('The studio became unreachable. Nothing was changed by this page.');
    }

    const runningNow = s.running.length > 0;
    host.textContent = describe(s);
    host.dataset.state = runningNow ? 'running' : 'idle';
    if (s.unreadable) host.textContent = 'The stored record for this film cannot be read. Nothing was written over it.';

    // a stage finished: redraw to show its output, once, and only if we saw it running
    if (wasRunning && !runningNow && s.version > version) {
      if (reloads >= 2) return stop('This stage has landed. Refresh once to read the new output.');
      reloads += 1;
      version = s.version;
      wasRunning = false;
      location.reload();
      return;
    }
    if (!runningNow && !wasRunning) stop(`Nothing is running. ${s.status.label}. This page has stopped refreshing.`);
  };

  timer = setInterval(tick, every);
  if (wasRunning) tick();
  else stop(`Nothing is running. ${host.textContent.trim() || 'this page is not refreshing.'}`);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !stopped) tick(); });
})();


// --- 2 and 3: the brief layer controls -------------------------------------------------------
(() => {
  const blocks = [...document.querySelectorAll('[data-layer-block]')];
  if (!blocks.length) return;
  const OTHER = 'other';

  const otherInputFor = (block, kind) => block.querySelector(`[data-other-for="${kind}"]`);

  const selectedValue = (sel) => {
    const opt = sel.options[sel.selectedIndex];
    return opt ? opt.value : '';
  };

  const labelFor = (el) => {
    if (el.tagName === 'OPTGROUP') return null;
    return (el.textContent || '').trim();
  };

  /** The one line, built from the words already printed in this form. */
  const summary = (block) => {
    const parts = [];
    const describe = (sel) => {
      const v = selectedValue(sel);
      if (!v) return 'not chosen';
      if (v !== OTHER) return labelFor(sel.options[sel.selectedIndex]) || v;
      const box = otherInputFor(block, sel.dataset.layer);
      const t = (box?.value ?? '').trim();
      return t ? `Other: ${t.length > 60 ? `${t.slice(0, 60)}…` : t}` : 'Other (nothing written yet)';
    };
    for (const kind of ['style', 'format', 'sound']) {
      const sel = block.querySelector(`select[data-layer="${kind}"]`);
      parts.push(sel ? describe(sel) : 'not chosen');
    }
    const boxes = [...block.querySelectorAll('input[name="genres"]')];
    const on = boxes.filter((b) => b.checked);
    if (!on.length) parts.splice(1, 0, 'no genre chosen');
    else {
      const words = on.map((b) => {
        if (b.value !== OTHER) return (b.nextElementSibling?.textContent ?? b.value).trim();
        const t = (otherInputFor(block, 'genre')?.value ?? '').trim();
        return t ? `Other: ${t.length > 60 ? `${t.slice(0, 60)}…` : t}` : 'Other (nothing written yet)';
      });
      parts.splice(1, 0, words.join(' / '));
    }
    const out = block.closest('form')?.querySelector('[data-summary]');
    if (!out) return parts;
    // The face clause is only carried forward if the server already decided it. A form that has not
    // been sent cannot know it, so the placeholder stays rather than the line implying otherwise.
    if (out.hasAttribute('data-face-unread')) parts.push('face direction not set yet');
    else if (out.dataset.face) parts.push(out.dataset.face);
    out.textContent = parts.join(' + ');
    return parts;
  };

  const syncOther = (block) => {
    for (const kind of ['style', 'genre', 'format', 'sound']) {
      const box = otherInputFor(block, kind);
      if (!box) continue;
      let wanted = false;
      if (kind === 'genre') wanted = [...block.querySelectorAll('input[name="genres"]')].some((b) => b.value === OTHER && b.checked);
      else {
        const sel = block.querySelector(`select[data-layer="${kind}"]`);
        wanted = sel ? selectedValue(sel) === OTHER : false;
      }
      const hiddenNow = box.hasAttribute('hidden');
      if (wanted && hiddenNow) { box.removeAttribute('hidden'); box.setAttribute('aria-hidden', 'false'); }
      if (!wanted && !hiddenNow) { box.setAttribute('hidden', ''); box.setAttribute('aria-hidden', 'true'); box.value = ''; }
      box.required = wanted && box.value.trim() === '';
    }
  };

  for (const block of blocks) {
    syncOther(block);
    const form = block.closest('form');
    if (form) {
      form.addEventListener('change', () => { syncOther(block); summary(block); });
      form.addEventListener('input', (e) => {
        if (e.target?.getAttribute?.('data-other-for') === 'genre' || e.target?.dataset?.otherFor) syncOther(block);
        summary(block);
      });
    }
  }
  // The line printed by the server is authoritative on load; this only recomputes after a change.
})();
