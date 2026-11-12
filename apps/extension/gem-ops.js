// Isolated-world content script on gemini.google.com. Fixed menu of ops, no eval. Nothing here reads cookies or tokens, and no op returns
// conversation text or an address: only ids, states, counts and, for our own prompt, whether it matches.
// Controls are found by their icon's name, which is the same in every UI language. Page facts were measured on 2026-11-12:
// docs/superpowers/plans/2026-11-12-gemini.md.
(() => {
  if (window.__tfGemOps) return; window.__tfGemOps = true;
  const G = globalThis.TFGem;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FULL_SIZE_WAIT_MS = 45000; // measured: 1 s (the page had it) to 15 s
  const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(120); } return null; };
  const iconsOf = (e) => [...e.querySelectorAll('mat-icon, gem-icon')].map((i) => i.getAttribute('fonticon') || i.getAttribute('data-mat-icon-name') || i.getAttribute('name') || i.textContent.trim()).filter(Boolean);
  const esc = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));

  const area = () => document.querySelector('input-area-v2');
  const editor = () => area()?.querySelector('rich-textarea .ql-editor') ?? null;
  const btn = (icon) => [...(area()?.querySelectorAll('button') ?? [])].find((b) => iconsOf(b).includes(icon)) ?? null;
  const locked = (b) => b.disabled || b.getAttribute('aria-disabled') === 'true';
  // the chosen tool shows as a chip in the input area; it stays on after a send
  const chip = () => area()?.querySelector('[data-test-id="deselect-drawer-item-gem-button"]') ?? null;
  const modeOf = () => { const c = chip(); return !c ? null : iconsOf(c).includes(G.IMAGE_ICON) ? G.IMAGE_MODE : 'other'; };
  const promptText = () => G.flat(editor()?.innerText);
  const menuItems = () => [...document.querySelectorAll('.cdk-overlay-pane [role="menuitemcheckbox"], .cdk-overlay-pane [role="menuitem"]')];
  const turnEls = () => [...document.querySelectorAll('.conversation-container')].filter((t) => G.isId(t.id));
  const singles = (t) => [...t.querySelectorAll('generated-image single-image')];
  const shown = (i) => !!i && i.complete && i.naturalWidth > 0;

  const OPS = {
    // Read-only outline for diagnosing a changed page: structure only.
    gemLook() {
      const a = area();
      return {
        path: location.pathname.replace(/[0-9a-f]{8,32}/g, '<id>'), visible: document.visibilityState, editor: !!editor(), mode: modeOf(),
        areaIcons: a ? [...a.querySelectorAll('button')].map((b) => iconsOf(b).join('+')).filter(Boolean) : null,
        turns: turnEls().slice(-6).map((t) => ({ query: t.querySelectorAll('user-query .query-text-line').length, response: !!t.querySelector('model-response'), pending: !!t.querySelector('pending-response, pending-request'), actions: !!t.querySelector('message-actions'), images: singles(t).length, shown: singles(t).filter((s) => shown(s.querySelector('img'))).length, download: t.querySelectorAll('download-generated-image-button button').length })),
        unnamedTurns: document.querySelectorAll('.conversation-container').length - turnEls().length,
      };
    },
    // What the composer and the conversation are right now.
    gemState() {
      const send = btn('arrow_upward');
      return {
        conv: G.convOf(location.pathname), start: location.pathname === '/app', visible: document.visibilityState === 'visible', editor: !!editor(), mode: modeOf(),
        textLen: promptText().length, canSend: !!send && !locked(send), generating: !!btn('stop'), turns: turnEls().length,
      };
    },
    // Turns on the image tool ("+" → the entry with the image icon) unless it is on already. The postcondition is the chip in the input area.
    async gemMode() {
      if (!editor()) return { ok: false, code: 'NO_EDITOR' };
      if (modeOf() === G.IMAGE_MODE) return { ok: true };
      if (modeOf()) return { ok: false, code: 'OTHER_MODE' }; // the user chose another tool for this message
      const plus = btn('plus'); if (!plus) return { ok: false, code: 'NO_PLUS' };
      const before = new Set(menuItems());
      plus.click();
      const hit = ((await until(() => { const f = menuItems().filter((x) => !before.has(x)); return f.length ? f : null; })) || []).filter((b) => iconsOf(b).includes(G.IMAGE_ICON));
      if (hit.length !== 1) { esc(); return { ok: false, code: 'MODE_NOT_FOUND' }; } // nothing is clicked on a menu we cannot read
      hit[0].click();
      return (await until(() => modeOf() === G.IMAGE_MODE, 4000)) ? { ok: true } : { ok: false, code: 'MODE_NOT_SET' };
    },
    // Types the prompt. Never sends, never replaces something that is in the editor already (Gemini brings an unsent draft back after a reload).
    async gemPrep(a) {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      if (modeOf() !== G.IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' };
      if (promptText() === G.flat(a.prompt)) return { ok: true }; // exactly this prompt is there already (an earlier try that was not sent)
      if (promptText().length) return { ok: false, code: 'COMPOSER_NOT_EMPTY' };
      ed.focus();
      const sel = getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
      document.execCommand('insertText', false, String(a.prompt));
      await sleep(400);
      return promptText() === G.flat(a.prompt) ? { ok: true } : { ok: false, code: 'PROMPT_MISMATCH' };
    },
    // Clicks Send once, only when the editor holds exactly this prompt with the image tool on. ok:false = nothing was clicked.
    async gemSend(a) {
      if (!editor()) return { ok: false, code: 'NO_EDITOR' };
      const ready = () => modeOf() === G.IMAGE_MODE && promptText() === G.flat(a.prompt);
      if (modeOf() !== G.IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' };
      if (!ready()) return { ok: false, code: 'PROMPT_MISMATCH' };
      const send = await until(() => { const b = btn('arrow_upward'); return b && !locked(b) ? b : null; }, 10000);
      if (!send) return { ok: false, code: btn('arrow_upward') ? 'SEND_DISABLED' : 'NO_SEND' };
      if (!ready()) return { ok: false, code: 'PROMPT_MISMATCH' }; // the composer changed while waiting
      send.click();
      const cleared = !!(await until(() => promptText().length === 0, 5000));
      return { ok: true, cleared };
    },
    // The conversation and its last turns in one look: id, state, whether the query is exactly this prompt, the ids of its shown images.
    gemTurns(a) {
      const all = turnEls(), last = all[all.length - 1];
      return { conv: G.convOf(location.pathname), turns: all.slice(-30).map((t) => {
        const query = [...t.querySelectorAll('user-query .query-text-line')].map((l) => l.innerText).join(' ');
        const images = []; let pending = 0;
        singles(t).forEach((s, k) => { if (shown(s.querySelector('img'))) images.push(G.mediaId(t.id, k + 1)); else pending++; });
        const done = !!t.querySelector('message-actions') && !t.querySelector('pending-response, pending-request') && ![...t.querySelectorAll('[aria-busy]')].some((e) => e.getAttribute('aria-busy') === 'true') && !(t === last && btn('stop'));
        return { key: t.id, state: done ? 'complete' : 'in_progress', mine: G.ownsQuery(query, a.prompt), images, pending };
      }) };
    },
  };

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m?.tf === 'gemDownload') { // INTERNAL: only our own service worker may ask. Presses the page's own "download full size" of one image and answers with where the page got the file.
      if (s?.id !== chrome.runtime.id) return;
      const id = G.parseMediaId(m.mediaId), t = id && turnEls().find((x) => x.id === id.turn), one = t && singles(t)[id.n - 1];
      const b = one && shown(one.querySelector('img')) ? one.querySelector('download-generated-image-button button') : null;
      if (!b) { reply({ code: 'NOT_FOUND' }); return; }
      if (locked(b)) { reply({ code: 'BUSY' }); return; }
      // The press makes the page fetch the real file; where from is read off the page's resource timing (an observer: the timing buffer of a
      // long-lived page is full). The address goes to our service worker only, which downloads it; it is never returned by an op.
      let url = null;
      const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (G.isFullSize(e)) url = e.name; });
      po.observe({ type: 'resource' });
      b.click();
      until(() => url, FULL_SIZE_WAIT_MS).then(() => { po.disconnect(); reply(url ? { url } : { code: 'NO_FULL_SIZE' }); });
      return true;
    }
    if (m?.tf !== 'op') return;
    const f = OPS[m.op];
    if (!f) { reply({ error: 'unknown page op ' + m.op }); return; }
    Promise.resolve().then(() => f(m.args)).then((result) => reply({ result }), (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
})();
