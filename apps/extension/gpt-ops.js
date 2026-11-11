// Isolated-world content script on chatgpt.com. Fixed menu of ops, no eval. Nothing here reads cookies or tokens, and no op returns
// conversation text or an address: only structure (ids, states, counts) and, for our own prompt, whether it matches.
// Page facts (selectors, attributes) were measured on 2026-11-11: docs/superpowers/plans/2026-11-11-p5-chatgpt.md.
(() => {
  if (window.__tfGptOps) return; window.__tfGptOps = true;
  const G = globalThis.TFGpt;
  const short = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(120); } return null; };
  // the "+" menu opens on pointerdown, not on click(): send the whole press
  const press = (e) => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) e.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, view: window, button: 0, pointerType: 'mouse' })); };

  const editor = () => document.querySelector('form [contenteditable="true"]');
  const sendBtn = () => document.querySelector('form button[type="submit"]');
  const plusBtn = () => document.querySelector('form button[aria-label="Add files and more"]');
  const modeOf = (ed) => ed?.querySelector('[data-system-hint-type]')?.getAttribute('data-system-hint-type') ?? null;
  // the prompt as typed: the editor's text without the mode pill's label
  const promptText = (ed) => { const c = ed.cloneNode(true); c.querySelectorAll('[data-system-hint-type]').forEach((p) => p.remove()); return G.flat(c.innerText); };
  const idsOf = (e) => String(e.getAttribute('data-chatgpt-search-message-ids') || '').split(/[\s,]+/).filter(G.isUuid);
  const imgsOf = (holder) => [...holder.querySelectorAll('[data-testid="generated-image-gallery"] [data-testid="generated-image-preview"] img')];
  const shown = (i) => i.complete && i.naturalWidth > 0;

  const OPS = {
    // Read-only outline for diagnosing a changed page: structure only (tags, test ids, labels of controls, counts).
    gptLook() {
      const el = (e, withText) => { const o = { tag: e.tagName.toLowerCase() }; for (const [k, a] of [['testid', 'data-testid'], ['aria', 'aria-label'], ['type', 'type']]) { const v = e.getAttribute(a); if (v) o[k] = short(v, 60); } if (e.disabled) o.disabled = true; if (withText) { const t = short(e.innerText); if (t) o.text = t; } return o; };
      return {
        path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'),
        editors: [...document.querySelectorAll('form [contenteditable="true"], form textarea')].map((e) => ({ ...el(e), len: (e.innerText || e.value || '').length })),
        formButtons: [...document.querySelectorAll('form button')].map((b) => el(b, true)),
        turns: [...document.querySelectorAll('[data-turn-key]')].slice(-6).map((t) => ({ state: t.querySelector('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') ?? null, bubble: !!t.querySelector('[data-user-message-bubble]'), messages: t.querySelectorAll('[data-chatgpt-search-message-ids]').length, galleries: t.querySelectorAll('[data-testid="generated-image-gallery"]').length, images: imgsOf(t).length, shown: imgsOf(t).filter(shown).length, textLen: t.innerText.length })),
        dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => ({ textLen: d.innerText.length, buttons: d.querySelectorAll('button').length })), // counts only: a dialog's labels can carry the conversation's title
      };
    },
    // What the composer and the conversation are right now.
    gptState() {
      const ed = editor(), send = sendBtn();
      return {
        conv: G.convOf(location.pathname), start: location.pathname === '/', visible: document.visibilityState === 'visible', editor: !!ed, mode: modeOf(ed), textLen: ed ? promptText(ed).length : 0,
        canSend: !!send && !send.disabled, generating: !!document.querySelector('form button[data-testid="stop-button"], form button[aria-label*="Stop" i]'),
        turns: document.querySelectorAll('[data-turn-key]').length,
      };
    },
    // Turns on image mode ("+" → Create image) unless it is on already. The postcondition is the pill in the composer.
    async gptMode() {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      if (modeOf(ed) === G.IMAGE_MODE) return { ok: true };
      if (modeOf(ed)) return { ok: false, code: 'OTHER_MODE' }; // the user chose another tool for this message
      const plus = plusBtn(); if (!plus) return { ok: false, code: 'NO_PLUS' };
      const before = new Set(document.querySelectorAll('button'));
      const fresh = () => [...document.querySelectorAll('button')].filter((b) => !before.has(b));
      press(plus);
      const hit = ((await until(() => (fresh().length ? fresh() : null), 3000)) || []).filter((b) => G.isModeLabel(b.innerText));
      if (hit.length !== 1) { // nothing is clicked on a menu we cannot read; close it again
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300);
        if (fresh().length) press(plus);
        return { ok: false, code: 'MODE_NOT_FOUND' };
      }
      hit[0].click();
      return (await until(() => modeOf(editor()) === G.IMAGE_MODE, 3000)) ? { ok: true } : { ok: false, code: 'MODE_NOT_SET' };
    },
    // Types the prompt after the mode pill. Never sends, never replaces something the user typed.
    async gptPrep(a) {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      if (modeOf(ed) !== G.IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' };
      if (promptText(ed) === G.flat(a.prompt)) return { ok: true }; // exactly this prompt is there already (an earlier try that was not sent)
      if (promptText(ed).length) return { ok: false, code: 'COMPOSER_NOT_EMPTY' };
      ed.focus();
      const sel = getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
      document.execCommand('insertText', false, String(a.prompt));
      await sleep(300);
      return promptText(editor()) === G.flat(a.prompt) ? { ok: true } : { ok: false, code: 'PROMPT_MISMATCH' };
    },
    // Clicks Send once, only when the composer holds exactly this prompt in image mode. ok:false = nothing was clicked.
    async gptSend(a) {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      if (modeOf(ed) !== G.IMAGE_MODE) return { ok: false, code: 'MODE_NOT_SET' };
      if (promptText(ed) !== G.flat(a.prompt)) return { ok: false, code: 'PROMPT_MISMATCH' };
      // measured: right after the previous answer ends the button stays locked for a moment although the text is in
      const send = await until(() => { const b = sendBtn(); return b && !b.disabled ? b : null; }, 10000);
      if (!send) return { ok: false, code: sendBtn() ? 'SEND_DISABLED' : 'NO_SEND' };
      if (modeOf(editor()) !== G.IMAGE_MODE || promptText(editor()) !== G.flat(a.prompt)) return { ok: false, code: 'PROMPT_MISMATCH' }; // the composer changed while waiting
      send.click();
      const cleared = !!(await until(() => { const e = editor(); return e && promptText(e).length === 0; }, 5000));
      return { ok: true, cleared };
    },
    // The conversation and its last turns in one look: key, state, whether the user bubble is exactly this prompt, the ids of its finished images.
    gptTurns(a) {
      return { conv: G.convOf(location.pathname), turns: turnsOf(a.prompt) };
    },
  };
  const turnsOf = (prompt) => [...document.querySelectorAll('[data-turn-key]')].slice(-30).map((t) => {
        const bubble = t.querySelector('[data-user-message-bubble]');
        const pills = bubble ? [...bubble.querySelectorAll('[data-prompt-link-label]')].map((e) => e.getAttribute('data-prompt-link-label')) : [];
        const images = []; let pending = 0;
        for (const m of t.querySelectorAll('[data-chatgpt-search-message-ids]')) {
          const id = idsOf(m).pop(), has = m.querySelector('[data-testid="generated-image-gallery"]');
          if (!has) continue;
          const imgs = imgsOf(m);
          if (!id || !imgs.length) { pending++; continue; }
          imgs.forEach((i, k) => { if (shown(i)) images.push(G.mediaId(id, k + 1)); else pending++; });
        }
        return { key: t.getAttribute('data-turn-key'), state: t.querySelector('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') ?? null, mine: !!bubble && G.ownsBubble(bubble.innerText, prompt, pills), images, pending };
      });

  // INTERNAL: only our own service worker may ask. The image's bytes (a data: URL) go to chrome.downloads and nowhere else.
  const srcOf = async (mediaId) => {
    const id = G.parseMediaId(mediaId); if (!id) return { code: 'NOT_FOUND' };
    const holder = [...document.querySelectorAll('[data-chatgpt-search-message-ids]')].find((m) => idsOf(m).pop() === id.msgId && m.querySelector('[data-testid="generated-image-gallery"]'));
    const i = holder && imgsOf(holder)[id.n - 1];
    if (!i || !shown(i)) return { code: 'NOT_FOUND' };
    try {
      const blob = await (await fetch(i.currentSrc || i.src)).blob();
      if (!/^image\/(png|jpeg|webp)$/.test(blob.type)) return { code: 'NOT_IMAGE' };
      const src = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
      return { src };
    } catch (_) { return { code: 'FETCH_FAILED' }; }
  };

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m?.tf === 'gptSrc') { if (s?.id !== chrome.runtime.id) return; srcOf(m.mediaId).then(reply, () => reply({ code: 'FETCH_FAILED' })); return true; }
    if (m?.tf !== 'op') return;
    const f = OPS[m.op];
    if (!f) { reply({ error: 'unknown page op ' + m.op }); return; }
    Promise.resolve().then(() => f(m.args)).then((result) => reply({ result }), (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
})();
