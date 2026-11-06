// THROWAWAY spike: thin relay. All logic lives in server.mjs / the operator.
const URL_WS = 'ws://127.0.0.1:17777/ext';
let ws;
const events = [];

function connect() {
  ws = new WebSocket(URL_WS);
  ws.onmessage = async (m) => {
    const { id, op, args = {} } = JSON.parse(m.data);
    let result, error;
    try { result = await handle(op, args); } catch (e) { error = String(e?.message || e); }
    ws.send(JSON.stringify({ id, result, error }));
  };
  ws.onclose = () => setTimeout(connect, 1000);
  ws.onerror = () => {};
}

async function handle(op, a) {
  switch (op) {
    case 'ping': return 'pong';
    case 'reload': setTimeout(() => chrome.runtime.reload(), 100); return 'reloading'; // re-reads unpacked code from disk
    case 'tabs': return (await chrome.tabs.query({})).map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
    case 'attach': await chrome.debugger.attach({ tabId: a.tabId }, '1.3'); return true;
    case 'detach': await chrome.debugger.detach({ tabId: a.tabId }); return true;
    case 'cdp': return await chrome.debugger.sendCommand({ tabId: a.tabId }, a.method, a.params || {});
    case 'events': return events.splice(0, events.length);
    case 'download': return await chrome.downloads.download({ url: a.url, filename: a.filename, conflictAction: 'uniquify' });
    case 'downloads': return await chrome.downloads.search(a.query || { limit: 10, orderBy: ['-startTime'] });
    case 'prep': {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: a.tabId }, func: pagePrep, args: [a] });
      return r.result;
    }
    case 'open': return (await chrome.tabs.create({ url: a.url, active: true })).id;
    case 'reloadTab': await chrome.tabs.reload(a.tabId); return true;
    case 'page': {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: a.tabId }, func: pageOps, args: [a.fn, a.args || {}] });
      return r.result;
    }
    default: throw new Error('unknown op ' + op);
  }
}

chrome.debugger.onEvent.addListener((src, method, params) => {
  events.push({ t: Date.now(), tabId: src.tabId, method, params });
  if (events.length > 2000) events.shift();
});
chrome.debugger.onDetach.addListener((src, reason) => events.push({ t: Date.now(), tabId: src.tabId, method: 'detached', params: { reason } }));
chrome.downloads.onChanged.addListener((d) => events.push({ t: Date.now(), method: 'download.changed', params: d }));

// Generic page ops (isolated world, untrusted DOM events). No eval: a fixed menu of operations.
async function pageOps(fn, a) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  switch (fn) {
    case 'tiles': return [...document.querySelectorAll('flow-grid-tile-container')].map((t) => {
      const m = t.querySelector('[data-media-id]'); const e = t.querySelector('flow-error-tile');
      return { id: m && m.getAttribute('data-media-id'), kind: t.querySelector('flow-pending-tile') ? 'pending' : e ? 'error' : t.querySelector('flow-video-tile') ? 'video' : t.querySelector('flow-image-tile') ? 'image' : '?',
        pct: (t.querySelector('.loading-percentage') || {}).innerText, label: t.getAttribute('aria-label'), err: e && e.innerText.slice(0, 120), src: (t.querySelector('img[data-media-id]') || {}).src };
    });
    case 'state': {
      const ed = $('flow-prompt-box .ProseMirror[contenteditable="true"]'); const s = $('flow-prompt-box button[type="submit"]');
      return { text: ed && ed.innerText.trim(), submitDisabled: s && s.disabled, chips: [...document.querySelectorAll('flow-prompt-box flow-image-ingredient-chip img')].map((i) => i.src.split('/image/')[1]?.split('?')[0]),
        settings: ($('flow-prompt-box button.settings-trigger-button') || {}).innerText, banner: /cookies/i.test(document.body.innerText.slice(-3000)) };
    }
    case 'composer': { const b = $('flow-prompt-box'); if (!b) return null;
      return { buttons: [...b.querySelectorAll('button')].map((x, i) => [i, x.className.slice(0, 40), x.getAttribute('aria-label'), x.innerText.replace(/\s+/g, ' ').trim().slice(0, 30)]),
        tags: [...new Set([...b.querySelectorAll('*')].map((e) => e.tagName.toLowerCase()).filter((t) => t.startsWith('flow-')))] }; }
    case 'video': return [...document.querySelectorAll('flow-grid-tile-container')].slice(0, a.n || 2).map((t) => ({
      label: t.getAttribute('aria-label'), html: t.outerHTML.replace(/\s+/g, ' ').slice(0, a.len || 1500),
      video: [...t.querySelectorAll('video')].map((v) => ({ src: v.currentSrc || v.src, poster: v.poster })), ids: [...t.querySelectorAll('[data-media-id],[data-tile-id]')].map((e) => e.getAttribute('data-media-id') || e.getAttribute('data-tile-id')) }));
    case 'radios': { const p = $('flow-prompt-box-settings'); if (!p) return 'no panel';
      return [...p.querySelectorAll('button')].map((b, i) => [i, b.getAttribute('role'), b.innerText.replace(/\s+/g, ' ').trim().slice(0, 30), b.getAttribute('aria-checked')]); }
    case 'click': { const e = document.querySelectorAll(a.sel)[a.idx || 0]; if (!e) return 'NOTFOUND'; e.click(); return 'clicked'; }
    case 'submit': { const s = $('flow-prompt-box button[type="submit"]'); if (!s || s.disabled) return 'disabled'; s.click(); return 'clicked'; }
    case 'net': { document.documentElement.removeAttribute('data-tf-net'); document.dispatchEvent(new CustomEvent('toolflow:net')); await sleep(100);
      return JSON.parse(document.documentElement.getAttribute('data-tf-net') || 'null'); }
    case 'ping': { document.documentElement.removeAttribute('data-tf-ping'); document.dispatchEvent(new CustomEvent('toolflow:ping')); await sleep(50);
      return JSON.parse(document.documentElement.getAttribute('data-tf-ping') || 'null'); }
    case 'html': return [...document.querySelectorAll(a.sel)].slice(0, 5).map((e) => e.outerHTML.slice(0, a.len || 1500));
    case 'list': return [...document.querySelectorAll(a.sel)].map((e, i) => [i, e.className && String(e.className).slice(0, 50), e.innerText.replace(/\s+/g, ' ').trim().slice(0, 60)]);
    case 'trusted': { document.documentElement.removeAttribute('data-tf-submit-result');
      document.dispatchEvent(new CustomEvent('toolflow:submit')); await sleep(300);
      return JSON.parse(document.documentElement.getAttribute('data-tf-submit-result') || '{"noMainWorld":true}'); }
    case 'enter': { const ed = $('flow-prompt-box .ProseMirror[contenteditable="true"]'); ed.focus();
      for (const t of ['keydown', 'keypress', 'keyup']) ed.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return 'sent'; }
    case 'pointer': { const s = $('flow-prompt-box button[type="submit"]'); const r = s.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true, button: 0 };
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) s.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)); s.dispatchEvent(new MouseEvent('click', o)); return 'sent'; }
    case 'file': {
      // build a File from bytes given by the operator, then try paste and drop on the composer
      const bin = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
      const file = new File([bin], a.name, { type: a.mime });
      const dt = new DataTransfer(); dt.items.add(file);
      const target = $('flow-prompt-box .ProseMirror[contenteditable="true"]');
      if (a.how === 'paste') { target.focus(); target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }
      else for (const t of ['dragenter', 'dragover', 'drop']) (a.on ? $(a.on) : target).dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
      await sleep(1500);
      return { chips: document.querySelectorAll('flow-prompt-box flow-image-ingredient-chip').length };
    }
    default: return 'unknown fn ' + fn;
  }
}

// Runs in the page (isolated world): no debugger, plain DOM events (isTrusted=false). Never clicks submit.
async function pagePrep({ prompt, asset }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s, root = document) => root.querySelector(s);
  const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(150); } return null; };
  const log = [];
  if (asset) {
    $('flow-add-menu button.add-menu-trigger').click();
    const item = await until(() => [...document.querySelectorAll('flow-add-menu-popover-content .asset-item')].find((b) => b.innerText.includes(asset)));
    if (!item) return { ok: false, log: ['asset not found'] };
    item.click(); await sleep(600);
    const add = await until(() => $('flow-add-menu-popover-content button.detail-add-to-prompt-btn'));
    add.click();
    const chip = await until(() => $('flow-prompt-box flow-image-ingredient-chip img'));
    log.push('chip ' + (chip ? chip.src.split('/image/')[1]?.split('?')[0] : 'MISSING'));
  }
  const ed = $('flow-prompt-box .ProseMirror[contenteditable="true"]');
  ed.focus();
  const ok = document.execCommand('insertText', false, prompt);
  await sleep(400);
  const sub = $('flow-prompt-box button[type="submit"]');
  return { ok, text: ed.innerText.trim(), textMatches: ed.innerText.trim() === prompt, submitDisabled: sub.disabled, log };
}

// SW dies when the relay is gone; alarms + tab events wake it so it reconnects (finding: needs a wake source)
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { if (!ws || ws.readyState > 1) connect(); });
chrome.tabs.onUpdated.addListener(() => { if (!ws || ws.readyState > 1) connect(); });
connect();
// keep SW alive while connected (Chrome 116+: WS activity extends lifetime)
setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ keepalive: Date.now() })), 20000);
