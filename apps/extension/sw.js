import { validate, forwardEvent, siteTab, SITES, fetchMediaOp, gptFetchOp, gemFetchOp, downloadsOp, frontOp } from './ops.js';

// pair.json = { port, token } written by the desktop app into this folder. Never logged, never committed.
let ws; let connecting = false;
let retryMs = 1000; let retry; // the app restarts on a new port: look for it again soon (1 s, doubling to 30 s), not only at the 30 s alarm
const PAGE_OPS = new Set(['ping','state','prep','radios','click','fill','hit','trusted','net','file','account','arm','probe','settings','listeners','attach','locate','gptLook','gptState','gptMode','gptPrep','gptSend','gptTurns','gptAttach','gemLook','gemState','gemMode','gemPrep','gemSend','gemTurns','gemAttach']);

// One id per Chrome profile (this extension's storage is per profile): the app keeps one connection per profile, so several accounts can work at once.
async function instance() {
  const { tfInstance } = await chrome.storage.local.get('tfInstance');
  if (/^[0-9a-f]{8}$/.test(tfInstance ?? '')) return tfInstance;
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  await chrome.storage.local.set({ tfInstance: id });
  return id;
}

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
async function mac(token, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))));
}

function later() {
  clearTimeout(retry);
  retry = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 30000);
}

// The app rewrites this folder when it updates (to its own version), but Chrome keeps running the code it loaded. The
// app's hello names its version: a different one reloads the extension, once per version (a folder Chrome does not load
// from cannot loop); then the site tabs reload, so their pages run the new content scripts too. The app updates only
// while nothing runs, so no tab is mid-way through a lot.
async function selfUpdate(appVersion) {
  try {
    if (typeof appVersion !== 'string' || !appVersion || appVersion === chrome.runtime.getManifest().version) return;
    const { tfReloadedFor } = await chrome.storage.local.get('tfReloadedFor');
    if (tfReloadedFor === appVersion) return;
    await chrome.storage.local.set({ tfReloadedFor: appVersion, tfReloadTabs: true });
    chrome.runtime.reload();
  } catch { /* the self-check still asks for a reload */ }
}

async function reloadSiteTabs() {
  try {
    const { tfReloadTabs } = await chrome.storage.local.get('tfReloadTabs');
    if (!tfReloadTabs) return;
    await chrome.storage.local.set({ tfReloadTabs: false });
    for (const t of await chrome.tabs.query({ url: SITES.map((s) => `${s}*`) })) await chrome.tabs.reload(t.id).catch(() => {});
  } catch { /* an older Chrome without the call: the self-check asks for F5 instead */ }
}

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  try {
    const { port, token } = await (await fetch(chrome.runtime.getURL('pair.json'))).json();
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    const want = await mac(token, 's' + nonce), protos = ['toolflow.v1', `tfn.${nonce}`, `tfp.${await mac(token, 'c' + nonce)}`, `tfi.${await instance()}`]; // all awaited before the socket exists: its first frame must find onmessage set
    const s = new WebSocket(`ws://127.0.0.1:${port}/`, protos); // the token itself is never sent, nor in the URL (Chrome logs failed URLs)
    // no op is run and nothing is sent until the first frame proves the listener knows the token
    s.onmessage = (m) => {
      if (s.ready) return onCommand(s, m.data);
      let h, v; try { ({ hello: h, v } = JSON.parse(m.data)); } catch { /* not json: not the app */ }
      if (h === want) { s.ready = true; retryMs = 1000; void selfUpdate(v); } else s.close(); // a wrong hello keeps the backoff growing
    };
    s.onclose = (e) => { if (ws === s) { ws = undefined; if (e.code === 4401) retryMs = 30000; /* wrong token: a 1 s loop helps nobody */ later(); } };
    s.onerror = () => {};
    ws = s;
  } catch (_) { later(); /* not paired yet: the alarm retries too */ } finally { connecting = false; }
}

async function onCommand(s, data) {
  let msg; try { msg = JSON.parse(data); } catch { return; }
  const reply = (o) => s.readyState === 1 && s.send(JSON.stringify({ id: msg?.id, epoch: msg?.epoch, ...o }));
  const bad = validate(msg);
  if (bad) return reply({ ok: false, error: bad });
  try { reply({ ok: true, result: await handle(msg.op, msg.args, msg.epoch) }); }
  catch (e) { reply({ ok: false, error: String(e?.message || e) }); }
}

async function handle(op, a, epoch) {
  if (PAGE_OPS.has(op)) {
    if (!Number.isInteger(a.tabId)) throw new Error('tabId required');
    const r = await chrome.tabs.sendMessage(a.tabId, { tf: 'op', op, args: op === 'trusted' ? { ...a, epoch } : a });
    if (!r) throw new Error('no content script in tab');
    if (r.error) throw new Error(r.error);
    return r.result;
  }
  switch (op) {
    case 'tabs': return (await chrome.tabs.query({ url: 'https://flow.google.com/*' })).map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, path: new URL(t.url).pathname, status: t.status })); // read-only; path only, no query string
    case 'gptTabs': return (await chrome.tabs.query({ url: 'https://chatgpt.com/*' })).map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, path: new URL(t.url).pathname, status: t.status })); // read-only; path only
    case 'gemTabs': return (await chrome.tabs.query({ url: 'https://gemini.google.com/*' })).map((t) => ({ tabId: t.id, windowId: t.windowId, active: t.active, path: new URL(t.url).pathname, status: t.status })); // read-only; path only
    case 'gptNew': case 'gptOpen': case 'gemNew': case 'gemOpen': { // a new, empty conversation, or one of ours again: the tab goes there (the page op API cannot outlive a navigation)
      const site = op.startsWith('gem') ? { origin: 'https://gemini.google.com/', home: 'app', conv: 'app/' } : { origin: 'https://chatgpt.com/', home: '', conv: 'c/' };
      if (!((await chrome.tabs.get(a.tabId)).url || '').startsWith(site.origin)) throw new Error('not a tab of that site');
      await chrome.tabs.update(a.tabId, { active: true, url: site.origin + (op.endsWith('Open') ? site.conv + a.conv : site.home) }); // conv is a validated id; active: see gptFront
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 250)); if ((await chrome.tabs.get(a.tabId)).status === 'complete') return true; }
      return false;
    }
    case 'gptFront': return frontOp(chrome, a); // a hidden page (ChatGPT's "+" menu, Flow's settings panel) does not open its menus (measured)
    case 'gemFetch': return gemFetchOp(chrome, a); // tab presses its own full-size download and says where the page got the file -> downloaded here into ToolFlow-tmp
    case 'gptFetch': return gptFetchOp(chrome, a); // tab -> image bytes (internal message) -> chrome.downloads
    case 'focus': { if (!Number.isInteger(a.tabId)) throw new Error('tabId required'); await siteTab(chrome, a.tabId); const t = await chrome.tabs.update(a.tabId, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); return true; }
    case 'open': return (await chrome.tabs.create({ url: a.url, active: true })).id;
    case 'reloadTab': if (!Number.isInteger(a.tabId)) throw new Error('tabId required'); await siteTab(chrome, a.tabId); await chrome.tabs.reload(a.tabId); return true;
    case 'fetchMedia': return fetchMediaOp(chrome, a); // tab -> src (internal message) -> chrome.downloads; the url never leaves the extension
    case 'downloads': return downloadsOp(chrome, a);
  }
}

// sent/response carry the epoch of their own trusted click (stamped in main-world). Generates that start before any
// trusted op on the tab (manual / Flow-initiated) have no epoch and are dropped by forwardEvent.
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m?.tf !== 'event' || !sender.tab || !ws?.ready || ws.readyState !== 1) return;
  const out = forwardEvent(sender.tab.id, m.ev);
  if (out) ws.send(JSON.stringify(out));
});

// SW dies when the relay is gone; alarms + tab events wake it so it reconnects
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
// Chrome's onUpdated takes no filter argument (that is Firefox only: in Chrome it throws and the whole worker never starts) — filter here instead
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete' && SITES.some((s) => tab?.url?.startsWith(s))) connect(); });
chrome.runtime.onStartup.addListener(connect);
void reloadSiteTabs();
connect();
// keep SW alive while connected (Chrome 116+: WS activity extends lifetime)
setInterval(() => ws?.ready && ws.readyState === 1 && ws.send(JSON.stringify({ keepalive: Date.now() })), 20000);
