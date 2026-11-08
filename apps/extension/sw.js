import { validate, forwardEvent } from './ops.js';

// pair.json = { port, token } written by the desktop app into this folder. Never logged, never committed.
let ws; let connecting = false;
const PAGE_OPS = new Set(['ping','state','prep','radios','click','fill','hit','trusted','net','file','account','arm','probe','settings','listeners','attach']);

async function connect() {
  if (connecting || (ws && ws.readyState <= 1)) return;
  connecting = true;
  try {
    const { port, token } = await (await fetch(chrome.runtime.getURL('pair.json'))).json();
    const s = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    s.onmessage = (m) => onCommand(s, m.data);
    s.onclose = () => { if (ws === s) ws = undefined; };
    s.onerror = () => {};
    ws = s;
  } catch (_) { /* not paired yet / desktop down: the alarm retries */ } finally { connecting = false; }
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
    case 'focus': { if (!Number.isInteger(a.tabId)) throw new Error('tabId required'); const t = await chrome.tabs.update(a.tabId, { active: true }); await chrome.windows.update(t.windowId, { focused: true }); return true; }
    case 'open': return (await chrome.tabs.create({ url: a.url, active: true })).id;
    case 'reloadTab': if (!Number.isInteger(a.tabId)) throw new Error('tabId required'); await chrome.tabs.reload(a.tabId); return true;
    case 'download': return await chrome.downloads.download({ url: a.url, filename: a.filename, conflictAction: 'uniquify' });
    case 'downloads': return await chrome.downloads.search(a.query || { limit: 10, orderBy: ['-startTime'] });
  }
}

// sent/response carry the epoch of their own trusted click (stamped in main-world). Generates that start before any
// trusted op on the tab (manual / Flow-initiated) have no epoch and are dropped by forwardEvent.
chrome.runtime.onMessage.addListener((m, sender) => {
  if (m?.tf !== 'event' || !sender.tab || ws?.readyState !== 1) return;
  const out = forwardEvent(sender.tab.id, m.ev);
  if (out) ws.send(JSON.stringify(out));
});

// SW dies when the relay is gone; alarms + tab events wake it so it reconnects
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.tabs.onUpdated.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
connect();
// keep SW alive while connected (Chrome 116+: WS activity extends lifetime)
setInterval(() => ws?.readyState === 1 && ws.send(JSON.stringify({ keepalive: Date.now() })), 20000);
