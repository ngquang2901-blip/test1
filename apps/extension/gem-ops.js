// Isolated-world content script on gemini.google.com. Fixed menu of ops, no eval. Nothing here reads cookies or tokens, and no op returns
// conversation text or an address: only ids, states, counts and, for our own prompt, whether it matches.
// Controls are found by their icon's name, which is the same in every UI language. Page facts were measured on 2026-11-12:
// docs/superpowers/plans/2026-11-12-gemini.md.
(() => {
  if (window.__tfGemOps) return; window.__tfGemOps = true;
  const G = globalThis.TFGem;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ATTACH_WAIT_MS = 40000;
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
  // the aspect ratio button: its icon is `aspect_ratio` until a ratio is chosen, then that ratio's icon
  const aspectBtn = () => [...(area()?.querySelectorAll('button') ?? [])].find((b) => iconsOf(b).some((i) => i === 'aspect_ratio' || Object.values(G.ASPECT_ICONS).includes(i))) ?? null;
  const previews = () => [...(area()?.querySelectorAll('uploader-file-preview') ?? [])]; // one per attached file
  const loaded = (p) => shown(p.querySelector('img')) && !p.querySelector('mat-spinner, .loading, .gem-attachment-loading-container'); // measured: all three are there while the file uploads (2 s for 8 MB)
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
    async gemMode(a) {
      if (!editor()) return { ok: false, code: 'NO_EDITOR' };
      const aspect = async () => { // the ratio the batch asked for; without one, whatever the user has chosen stays
        if (!a?.aspect) return { ok: true };
        const want = G.ASPECT_ICONS[a.aspect], b = await until(aspectBtn, 3000);
        if (!b) return { ok: false, code: 'ASPECT_NOT_FOUND' };
        if (iconsOf(b).includes(want)) return { ok: true };
        b.click();
        const hit = (await until(() => { const f = [...document.querySelectorAll('.cdk-overlay-pane [role="menuitemradio"]')].filter((x) => iconsOf(x).includes(want)); return f.length ? f : null; })) || []; // the entry itself is waited for: see the "+" menu
        if (hit.length !== 1) { esc(); return { ok: false, code: 'ASPECT_NOT_FOUND' }; }
        hit[0].click();
        return (await until(() => { const x = aspectBtn(); return x && iconsOf(x).includes(want); }, 4000)) ? { ok: true } : { ok: false, code: 'ASPECT_NOT_SET' };
      };
      const model = async () => { // the model the batch asked for; without one, the user's choice stays. Chosen before the ratio.
        if (!a?.model) return { ok: true };
        const b = await until(() => document.querySelector('[data-test-id="bard-mode-menu-button"]'), 3000);
        if (!b) return { ok: false, code: 'MODEL_NOT_FOUND' };
        if (G.flat(b.innerText) === a.model) return { ok: true };
        b.click();
        const hit = (await until(() => { const f = [...document.querySelectorAll('.cdk-overlay-pane [role="menuitemradio"][data-test-id^="bard-mode-option-"]')].filter((x) => G.isModelItem(x.innerText, a.model) && !iconsOf(x).includes('lock')); return f.length ? f : null; })) || [];
        if (hit.length !== 1) { esc(); return { ok: false, code: 'MODEL_NOT_FOUND' }; }
        hit[0].click();
        return (await until(() => G.flat(b.innerText) === a.model, 4000)) ? { ok: true } : { ok: false, code: 'MODEL_NOT_SET' };
      };
      const rest = async () => { const m = await model(); return m.ok ? aspect() : m; };
      if (modeOf() === G.IMAGE_MODE) return rest();
      if (modeOf()) return { ok: false, code: 'OTHER_MODE' }; // the user chose another tool for this message
      const plus = btn('plus'); if (!plus) return { ok: false, code: 'NO_PLUS' };
      const before = new Set(menuItems());
      plus.click();
      // measured: the menu fills in steps (attach_file and drive first, the tools up to 1.5 s later), so the entry itself is waited for, not the first new item
      const hit = (await until(() => { const f = menuItems().filter((x) => !before.has(x) && iconsOf(x).includes(G.IMAGE_ICON)); return f.length ? f : null; }, 8000)) || [];
      if (hit.length !== 1) { esc(); return { ok: false, code: 'MODE_NOT_FOUND' }; } // nothing is clicked on a menu we cannot read
      hit[0].click();
      return (await until(() => modeOf() === G.IMAGE_MODE, 4000)) ? rest() : { ok: false, code: 'MODE_NOT_SET' };
    },
    // Types the prompt. Never sends, never replaces something that is in the editor already (Gemini brings an unsent draft back after a reload).
    // One reference image into the composer, as a pasted file (measured: the page takes a paste event carrying a File). clear: what is
    // attached already (an earlier try, or the user's) is removed first, so a prompt goes out with exactly its own images.
    async gemAttach(a) {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      if (a.clear) {
        for (const p of previews()) [...p.querySelectorAll('button')].find((b) => iconsOf(b).includes('close'))?.click();
        if (!(await until(() => previews().length === 0, 4000))) return { ok: false, code: 'ATTACH_NOT_CLEARED' };
      }
      const n = previews().length;
      const bin = atob(a.b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([bytes], a.name, { type: a.mime }));
      ed.focus();
      ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      const ok = await until(() => previews().length === n + 1 && previews().every(loaded), ATTACH_WAIT_MS);
      return ok ? { ok: true, count: n + 1 } : { ok: false, code: previews().length === n ? 'ATTACH_REFUSED' : 'ATTACH_NOT_READY' };
    },
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
      if (a.refs !== undefined && !(previews().length === a.refs && previews().every(loaded))) return { ok: false, code: 'REF_MISMATCH' }; // exactly the batch's images go out, fully loaded
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
        const done = G.turnDone({ actions: !!t.querySelector('message-actions'), waiting: !!t.querySelector('pending-response, pending-request'), busy: [...t.querySelectorAll('[aria-busy]')].some((e) => e.getAttribute('aria-busy') === 'true'), generating: t === last && !!btn('stop'), imageEls: singles(t).length });
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
