// Isolated-world content script on chatgpt.com. Fixed menu of ops, no eval. Nothing here reads cookies or tokens, and no op returns
// conversation text: only structure (tags, test ids, labels, counts) and, for our own prompt, whether it matches.
(() => {
  if (window.__tfGptOps) return; window.__tfGptOps = true;
  const short = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const el = (e, withText) => {
    const o = { tag: e.tagName.toLowerCase() };
    for (const [k, a] of [['id', 'id'], ['testid', 'data-testid'], ['aria', 'aria-label'], ['role', 'role'], ['type', 'type'], ['turn', 'data-turn'], ['author', 'data-message-author-role']]) { const v = e.getAttribute(a); if (v) o[k] = short(v, 60); }
    if (e.disabled) o.disabled = true;
    if (withText) { const t = short(e.innerText); if (t) o.text = t; }
    return o;
  };
  // where an image comes from, without anything that opens it: host, the path with long ids cut, and the NAMES of the query keys
  const img = (i) => { let u; try { u = new URL(i.currentSrc || i.src, location.href); } catch (_) { return { bad: true }; }
    return { host: u.host, path: u.pathname.replace(/[A-Za-z0-9_-]{10,}/g, '<x>'), keys: [...u.searchParams.keys()], alt: short(i.alt), w: i.naturalWidth, h: i.naturalHeight, complete: i.complete }; };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(120); } return null; };
  // Radix menus open on pointerdown, not on click(): send the whole press
  const press = (e) => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) e.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, view: window, button: 0, pointerType: 'mouse' })); };
  const menuItems = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')];

  const editor = () => document.querySelector('form [contenteditable="true"]');
  const sendBtn = () => document.querySelector('form button[type="submit"]');
  // the prompt as typed: the editor's text without the mode pill's label
  const promptText = (ed) => { const c = ed.cloneNode(true); c.querySelectorAll('[data-system-hint-type]').forEach((p) => p.remove()); return c.innerText.replace(/\u00a0/g, ' ').trim(); };

  const OPS = {
    // What the composer and the conversation look like right now (no text leaves the page).
    gptState() {
      const ed = editor(), pill = ed && ed.querySelector('[data-system-hint-type]'), send = sendBtn();
      const stop = document.querySelector('form button[data-testid="stop-button"], form button[aria-label*="Stop" i]');
      return {
        conv: (/^\/c\/([0-9a-f-]{36})$/.exec(location.pathname) || [])[1] || null, path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'),
        editor: !!ed, mode: pill ? pill.getAttribute('data-system-hint-type') : null, textLen: ed ? promptText(ed).length : 0,
        send: send ? { disabled: !!send.disabled } : null, generating: !!stop,
        messages: [...document.querySelectorAll('[data-message-author-role]')].map((m) => ({ role: m.getAttribute('data-message-author-role'), id: m.getAttribute('data-message-id'), imgs: m.querySelectorAll('img').length })),
      };
    },
    // Types the prompt after the mode pill. Never sends.
    async gptPrep(a) {
      const ed = editor(); if (!ed) return { ok: false, code: 'NO_EDITOR' };
      ed.focus();
      const sel = getSelection(); sel.selectAllChildren(ed); sel.collapseToEnd();
      document.execCommand('insertText', false, String(a.prompt));
      await sleep(300);
      const got = promptText(ed), send = sendBtn();
      return { ok: got === String(a.prompt).trim(), textMatches: got === String(a.prompt).trim(), gotLen: got.length, mode: ed.querySelector('[data-system-hint-type]')?.getAttribute('data-system-hint-type') ?? null, sendDisabled: send ? !!send.disabled : null };
    },
    // SPIKE: clicks Send once.
    async gptSend() {
      const send = sendBtn(); if (!send || send.disabled) return { ok: false, code: send ? 'SEND_DISABLED' : 'NO_SEND' };
      send.click();
      const gone = !!(await until(() => { const ed = editor(); return ed && promptText(ed).length === 0; }, 5000));
      return { ok: gone, path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>') };
    },
    // SPIKE, read-only: every image of the conversation with its ancestors' data-* attributes (how a turn and its image are marked).
    gptImgs() {
      const region = document.querySelector('main') || document.body;
      const data = (e) => Object.fromEntries([...e.attributes].filter((x) => x.name.startsWith('data-') || x.name === 'id' || x.name === 'role' || x.name === 'aria-label').map((x) => [x.name, short(x.value, 44)]));
      return { regionKids: [...region.children].slice(0, 8).map((c) => ({ tag: c.tagName.toLowerCase(), ...data(c), kids: c.children.length })),
        counts: { img: document.querySelectorAll('img').length, mainImg: region.querySelectorAll('img').length, canvas: region.querySelectorAll('canvas').length, video: region.querySelectorAll('video').length, iframes: document.querySelectorAll('iframe').length, bg: [...region.querySelectorAll('*')].filter((e) => getComputedStyle(e).backgroundImage.startsWith('url(')).length },
        frames: [...document.querySelectorAll('iframe')].map((f) => { let u = null; try { u = new URL(f.src, location.href); } catch (_) { /* no src */ } return { host: u && u.host, path: u && u.pathname.slice(0, 40), w: f.offsetWidth, h: f.offsetHeight, ...data(f) }; }),
        shadows: [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).slice(0, 8).map((e) => ({ tag: e.tagName.toLowerCase(), ...data(e), imgs: e.shadowRoot.querySelectorAll('img').length, kids: e.shadowRoot.children.length })),
        anyImg: [...document.querySelectorAll('img')].map((i) => ({ ...img(i), inMain: !!i.closest('main'), parent: i.parentElement && i.parentElement.tagName.toLowerCase() })),
        imgs: [...region.querySelectorAll('img')].map((i) => { const chain = []; for (let x = i.parentElement; x && x !== region && chain.length < 12; x = x.parentElement) { const d = data(x); if (Object.keys(d).length) chain.push({ tag: x.tagName.toLowerCase(), ...d }); } return { ...img(i), id: i.id || undefined, ...data(i), chain }; }),
        turnish: [...region.querySelectorAll('[data-turn-id], [data-message-id], [data-turn], section, article')].slice(0, 12).map((t) => ({ tag: t.tagName.toLowerCase(), ...data(t), imgs: t.querySelectorAll('img').length, textLen: t.innerText.length })) };
    },
    // SPIKE, read-only: the turns of the conversation (keys, state, message ids, image count, which data-* names occur inside).
    async gptTurns() {
      const out = [];
      for (const t of document.querySelectorAll('[data-turn-key]')) {
        const names = new Set(); for (const e of t.querySelectorAll('*')) for (const x of e.attributes) if (x.name.startsWith('data-')) names.add(x.name);
        const i = t.querySelector('[data-testid="generated-image-preview"] img'); let blob = null;
        if (i) { try { const b = await (await fetch(i.src)).blob(); blob = { scheme: i.src.split(':')[0], type: b.type, size: b.size }; } catch (e) { blob = { scheme: i.src.split(':')[0], error: String(e).slice(0, 60) }; } }
        out.push({ key: t.getAttribute('data-turn-key'), state: t.querySelector('[data-talvt-turn-state]')?.getAttribute('data-talvt-turn-state') ?? null, msgIds: [...t.querySelectorAll('[data-chatgpt-search-message-ids]')].map((m) => m.getAttribute('data-chatgpt-search-message-ids')),
          imgs: t.querySelectorAll('[data-testid="generated-image-preview"] img').length, blob, textLen: t.innerText.length, names: [...names].slice(0, 40) });
      }
      return out;
    },
    // SPIKE: open "+" and click the one item whose label starts with a.text; report the composer's buttons afterwards.
    async gptPick(a) {
      const want = String(a.text || '').toLowerCase(); if (want.length < 3) return { ok: false, code: 'BAD_TEXT' };
      const plus = [...document.querySelectorAll('form button')].find((b) => /add files|thêm/i.test(b.getAttribute('aria-label') || ''));
      if (!plus) return { ok: false, code: 'NO_PLUS' };
      const before = new Set(document.querySelectorAll('button'));
      const fresh = () => [...document.querySelectorAll('button')].filter((b) => !before.has(b));
      press(plus);
      const hit = ((await until(() => (fresh().length ? fresh() : null), 3000)) || []).filter((b) => short(b.innerText).toLowerCase().startsWith(want));
      if (hit.length !== 1) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return { ok: false, code: hit.length ? 'AMBIGUOUS' : 'NOT_FOUND' }; }
      hit[0].click();
      await sleep(1200);
      return { ok: true, formButtons: [...document.querySelectorAll('form button')].map((b) => el(b, true)), menuOpen: plus.getAttribute('data-state') };
    },
    // SPIKE, read-only: where a UI label sits (its element and the chain of ancestors with their roles).
    gptFind(a) {
      const want = String(a.text || '').toLowerCase(); if (want.length < 3 || want.length > 40) return [];
      return [...document.querySelectorAll('body *')].filter((e) => e.children.length <= 3 && short(e.innerText, 80).toLowerCase().startsWith(want)).slice(0, 4).map((e) => {
        const chain = []; for (let x = e; x && chain.length < 7; x = x.parentElement) chain.push(el(x, false));
        return { chain };
      });
    },
    // SPIKE (read-only apart from opening and closing a menu): what the composer's "+" menu offers.
    async gptPlus() {
      const plus = [...document.querySelectorAll('form button')].find((b) => /add files|thêm/i.test(b.getAttribute('aria-label') || ''));
      if (!plus) return { ok: false, code: 'NO_PLUS' };
      const before = new Set(document.querySelectorAll('button'));
      const fresh = () => [...document.querySelectorAll('button')].filter((b) => !before.has(b));
      press(plus);
      const items = await until(() => (fresh().length ? fresh() : null), 3000);
      const out = (items || []).map((m) => el(m, true));
      const state = { expanded: plus.getAttribute('aria-expanded'), haspopup: plus.getAttribute('aria-haspopup'), plusState: plus.getAttribute('data-state') };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      if (fresh().length) press(plus);
      return { ok: !!items, ...state, items: out, closed: !!(await until(() => !fresh().length, 1500)) };
    },
    // Read-only outline of the page: composer, its buttons, the last turns and their images.
    gptLook() {
      const turns = [...document.querySelectorAll('article')].slice(-4).map((a) => ({
        ...el(a), messages: [...a.querySelectorAll('[data-message-author-role]')].map((m) => ({ ...el(m), hasId: !!m.getAttribute('data-message-id'), model: m.getAttribute('data-message-model-slug') || undefined })),
        imgs: [...a.querySelectorAll('img')].map(img), buttons: [...a.querySelectorAll('button')].slice(0, 14).map((b) => el(b, false)), textLen: a.innerText.length,
      }));
      return {
        path: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>'), title: document.title.length,
        editors: [...document.querySelectorAll('#prompt-textarea, form [contenteditable="true"], form textarea')].map((e) => ({ ...el(e), editable: e.getAttribute('contenteditable'), cls: short(e.className, 60), len: (e.innerText || e.value || '').length })),
        formButtons: [...document.querySelectorAll('form button')].map((b) => el(b, true)),
        editorNodes: [...document.querySelectorAll('form [contenteditable="true"] *')].slice(0, 12).map((e) => ({ ...el(e, true), attrs: [...e.attributes].map((x) => x.name).filter((n) => n !== 'class' && n !== 'style'), cls: short(e.className, 50) })),
        fileInputs: [...document.querySelectorAll('input[type="file"]')].map((i) => ({ accept: short(i.accept, 80), multiple: i.multiple, inForm: !!i.closest('form') })),
        menus: [...document.querySelectorAll('[role="menu"] [role^="menuitem"], [role="listbox"] [role="option"]')].slice(0, 30).map((m) => el(m, true)),
        turns, articleCount: document.querySelectorAll('article').length,
        messages: [...document.querySelectorAll('[data-message-author-role]')].slice(-4).map((m) => ({ ...el(m), hasId: !!m.getAttribute('data-message-id'), parents: (() => { const p = []; for (let x = m.parentElement; x && p.length < 5; x = x.parentElement) p.push([x.tagName.toLowerCase(), x.getAttribute('data-testid') || '', x.getAttribute('data-turn') || '', short(x.className, 30)].join('|')); return p; })(), imgs: m.querySelectorAll('img').length })),
        turnEls: [...document.querySelectorAll('[data-testid^="conversation-turn"], [data-turn]')].slice(-4).map((t) => ({ ...el(t), imgs: [...t.querySelectorAll('img')].map(img), textLen: t.innerText.length })),
        pills: [...document.querySelectorAll('form [data-testid*="pill"], form button[aria-label*="click to remove" i], form [class*="pill"]')].slice(0, 6).map((p) => el(p, true)),
        dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].map((d) => ({ ...el(d), textLen: d.innerText.length, buttons: [...d.querySelectorAll('button')].slice(0, 6).map((b) => el(b, true)) })),
      };
    },
  };

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m?.tf !== 'op') return;
    const f = OPS[m.op];
    if (!f) { reply({ error: 'unknown page op ' + m.op }); return; }
    Promise.resolve().then(() => f(m.args)).then((result) => reply({ result }), (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
})();
