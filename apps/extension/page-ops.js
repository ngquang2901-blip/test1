// Isolated-world content script (document_start). Fixed menu of DOM ops, plain untrusted events, no eval.
// Submit is possible ONLY via op 'trusted' (main-world.js); generic 'click' refuses the submit button (R34).
(() => {
  if (window.__tfPageOps) return; window.__tfPageOps = true;
  const meta = document.createElement('meta');
  meta.name = 'toolflow-version'; meta.content = chrome.runtime.getManifest().version;
  document.documentElement.append(meta);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, root = document) => root.querySelector(s);
  const SUBMIT = 'flow-prompt-box button[type="submit"]';
  const CLEAR = 'button.clear-button';
  const TRIGGER = 'flow-prompt-box button.settings-trigger-button';
  const ask = (name, ms = 500, detail) => new Promise((resolve) => {
    const h = (e) => { clearTimeout(t); document.removeEventListener(name + '-result', h); resolve(JSON.parse(e.detail)); };
    const t = setTimeout(() => { document.removeEventListener(name + '-result', h); resolve(null); }, ms);
    document.addEventListener(name + '-result', h);
    document.dispatchEvent(new CustomEvent(name, detail ? { detail: JSON.stringify(detail) } : undefined));
  });
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };

  // main world -> service worker: generate request left / answered
  document.addEventListener('toolflow:event', (e) => {
    try { chrome.runtime.sendMessage({ tf: 'event', ev: JSON.parse(e.detail) }).catch(() => {}); } catch (_) { /* extension reloaded */ }
  });

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // The one result tile of a media uuid; anything but exactly one is a code, never a guess.
  const tile = (id) => {
    if (typeof id !== 'string' || !UUID.test(id)) return { code: 'BAD_ID' };
    const l = document.querySelectorAll(`img[data-media-id="${CSS.escape(id)}"]`);
    return l.length === 1 ? { img: l[0] } : { code: l.length ? 'AMBIGUOUS' : 'NOT_FOUND' };
  };

  const OPS = {
    // Read-only. Reports size, never the (signed) url.
    locate(a) { const t = tile(a.mediaId); return t.img ? { ok: true, w: t.img.naturalWidth, h: t.img.naturalHeight, complete: t.img.complete } : { ok: false, code: t.code }; },
    state() {
      const ed = $('flow-prompt-box .ProseMirror[contenteditable="true"]'); const s = $(SUBMIT);
      return { text: ed && ed.innerText.trim(), submitDisabled: s && s.disabled,
        chips: [...document.querySelectorAll('flow-prompt-box flow-image-ingredient-chip img')].map((i) => i.src.split('/image/')[1]?.split('?')[0]),
        settings: ($('flow-prompt-box button.settings-trigger-button') || {}).innerText,
        banner: /cookies/i.test(document.body.innerText.slice(-3000)),
        creditWarning: !!$('flow-prompt-box button.prompt-warning-button') };
    },
    radios() {
      const p = $('flow-prompt-box-settings'); if (!p) return 'no panel';
      return [...p.querySelectorAll('button')].map((b, i) => [i, b.getAttribute('role'), b.innerText.replace(/\s+/g, ' ').trim().slice(0, 30), b.getAttribute('aria-checked')]);
    },
    click(a) {
      const e = document.querySelectorAll(a.sel)[a.idx || 0]; if (!e) return 'NOTFOUND';
      const sub = $(SUBMIT);
      if (e.closest(SUBMIT) || (sub && e.contains(sub)) || (e.tagName === 'LABEL' && e.control && e.control.matches(SUBMIT))) return 'REFUSED: submit goes through trusted only';
      e.click(); return 'clicked';
    },
    async fill(a) {
      const e = $(a.sel); if (!e) return 'NOTFOUND';
      e.focus(); e.value = a.text; e.dispatchEvent(new Event('input', { bubbles: true })); await sleep(a.wait || 1500); return 'filled';
    },
    probe: (a) => ({ present: Object.fromEntries(Object.entries(a.selectors).map(([k, s]) => { try { return [k, !!document.querySelector(s)]; } catch (_) { return [k, false]; } })), path: location.pathname }), // read-only DOM presence check
    hit: () => ask('toolflow:hit'),
    listeners: () => ask('toolflow:listeners'), // read-only: count of the submit button's click listeners
    async trusted(a) { return (await ask('toolflow:submit', 1000, { epoch: a.epoch })) || { noMainWorld: true }; },
    async arm(a) { const r = await ask('toolflow:arm', 1000, { epoch: a.epoch }); if (!r?.ok) throw new Error('arm: no ack from main world'); return true; },
    net: () => ask('toolflow:net'),
    ping: () => ask('toolflow:ping'),
    account() {
      // shortcut: relies on the Google account button aria-label containing the email; null if layout differs
      for (const el of document.querySelectorAll('a[aria-label], button[aria-label]')) {
        const l = el.getAttribute('aria-label');
        if (/google|tài khoản/i.test(l)) { const m = /[^\s()<>]+@[^\s()<>]+/.exec(l); if (m) return m[0]; }
      }
      return null;
    },
    async file(a) {
      const bin = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bin], a.name, { type: a.mime }));
      const target = $('flow-prompt-box .ProseMirror[contenteditable="true"]'); if (!target) return 'NOTFOUND';
      if (a.how === 'paste') { target.focus(); target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }
      else for (const t of ['dragenter', 'dragover', 'drop']) (a.on ? $(a.on) : target).dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      await sleep(1500);
      return { chips: document.querySelectorAll('flow-prompt-box flow-image-ingredient-chip').length };
    },
    // Radios by LABEL (settings-logic.js), re-read after every click; model is verified only. Opens/closes the panel, never touches submit.
    async settings(a) {
      const trigger = $(TRIGGER); if (!trigger) return { ok: false, current: null, mismatches: ['trigger'] };
      if (!$('flow-prompt-box-settings')) trigger.click();
      if (!(await until(() => $('flow-prompt-box-settings'), 3000))) return { ok: false, current: null, mismatches: ['panel'] };
      const buttons = () => [...$('flow-prompt-box-settings').querySelectorAll('button')].map((el) => ({ role: el.getAttribute('role'), text: el.innerText, checked: el.getAttribute('aria-checked'), el }));
      try {
        return await TFSettings.converge({ mode: a.mode, aspect: a.aspect, quality: a.quality, count: a.count, model: a.model }, buttons, (b) => b.el.click(), { settle: () => sleep(150) });
      } finally { if ($('flow-prompt-box-settings')) trigger.click(); }
    },
    // Library -> chip by upload name (ref-logic.js). Opens/closes the '+' popover, never touches submit; returns codes only.
    async attach(a) {
      const pop = () => $('flow-add-menu-popover-content');
      const plus = () => { const bs = [...document.querySelectorAll('flow-prompt-box button')].filter((b) => !b.closest('flow-add-menu-popover-content')); const i = TFRef.plusIndex(bs.map((b) => ({ text: b.innerText, label: b.getAttribute('aria-label') }))); return i < 0 ? null : bs[i]; };
      const env = {
        chips: () => OPS.state().chips,
        isOpen: () => !!pop(),
        open: async () => { const b = plus(); if (!b) return false; b.click(); return !!(await until(pop, 3000)); },
        close: () => { const b = plus(); if (b) b.click(); },
        setSearch: (q) => { const e = $('flow-add-menu-popover-content input.search-input'); if (!e) return; e.focus(); e.value = q; e.dispatchEvent(new Event('input', { bubbles: true })); },
        items: () => [...document.querySelectorAll('flow-add-menu-popover-content .asset-item')].map((el) => ({ text: el.innerText, click: () => el.click() })),
        addButton: () => { const b = [...(pop()?.querySelectorAll('button') || [])].filter((x) => TFRef.isAddLabel(x.innerText)); return b.length === 1 ? b[0] : null; },
      };
      return TFRef.attach(env, a.name, { until, chipMs: 15000 }); // a fresh upload shows its chip long before the image src (uuid) is readable (measured >10 s)
    },
    // Never clicks submit. Types the prompt (and optional library asset) into the composer.
    async prep({ prompt, asset }) {
      const log = [];
      if (asset) {
        $('flow-add-menu button.add-menu-trigger').click();
        const item = await until(() => [...document.querySelectorAll('flow-add-menu-popover-content .asset-item')].find((b) => b.innerText.includes(asset)));
        if (!item) return { ok: false, log: ['asset not found'] };
        item.click(); await sleep(600);
        const add = await until(() => $('flow-add-menu-popover-content button.detail-add-to-prompt-btn'));
        if (!add) return { ok: false, log: ['add button not found'] };
        add.click();
        const chip = await until(() => $('flow-prompt-box flow-image-ingredient-chip img'));
        log.push('chip ' + (chip ? chip.src.split('/image/')[1]?.split('?')[0] : 'MISSING'));
      }
      const ed = $('flow-prompt-box .ProseMirror[contenteditable="true"]');
      if (!ed) return { ok: false, log: ['composer not found'] };
      if (ed.innerText.trim()) { // stale text: clear it, and prove it is empty before typing (no doubled prompt)
        const clear = $(CLEAR); if (clear) clear.click();
        if (!(await until(() => !ed.innerText.trim(), 2000))) return { ok: false, log: ['clear failed'] };
      }
      ed.focus();
      const typed = document.execCommand('insertText', false, prompt);
      await sleep(400);
      const sub = $(SUBMIT);
      const textMatches = ed.innerText.trim() === prompt;
      return { ok: typed && textMatches, text: ed.innerText.trim(), textMatches, submitDisabled: sub ? sub.disabled : null, log };
    },
  };

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m?.tf === 'src') { // INTERNAL: only our own service worker may ask; the src goes to chrome.downloads and nowhere else
      if (s?.id !== chrome.runtime.id) return;
      const t = tile(m.mediaId);
      reply(t.img && t.img.src ? { src: t.img.src } : { code: t.code ?? 'NOT_FOUND' });
      return;
    }
    if (m?.tf !== 'op') return;
    const f = OPS[m.op];
    if (!f) { reply({ error: 'unknown page op ' + m.op }); return; }
    Promise.resolve().then(() => f(m.args)).then((result) => reply({ result }), (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
})();
