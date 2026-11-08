import { validate } from './ops.js';

// pair.json = { port, token } written by the desktop app into this folder. Never logged, never committed.
let ws; let connecting = false;
const epochByTab = new Map(); // epoch of the latest 'trusted' op per tab: stamps sent/response events
const PAGE_OPS = new Set(['ping','state','prep','radios','click','fill','hit','trusted','net','file','account']);

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
    if (op === 'trusted') epochByTab.set(a.tabId, epoch);
    const r = await chrome.tabs.sendMessage(a.tabId, { tf: 'op', op, args: a });
    if (!r) throw new Error('no content script in tab');
    if (r.error) throw new Error(r.error);
    return r.result;
  }
  switch (op) {
    case 'open': return (await chrome.tabs.create({ url: a.url, active: true })).id;
    case 'reloadTab': await chrome.tabs.reload(a.tabId); return true;
    case 'download': return await chrome.downloads.download({ url: a.url, filename: a.filename, conflictAction: 'uniquify' });
    case 'downloads': return await chrome.downloads.search(a.query || { limit: 10, orderBy: ['-startTime'] });
  }
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (m?.tf !== 'event' || !sender.tab || ws?.readyState !== 1) return;
  const tabId = sender.tab.id;
  const epoch = epochByTab.get(tabId);
  if (epoch === undefined) return; // not submitted by us (e.g. user clicked by hand)
  ws.send(JSON.stringify({ type: m.ev.type, tabId, epoch, ...(m.ev.type === 'response' ? { rpc: m.ev.rpc, text: m.ev.text } : {}), request: m.ev.request }));
});
chrome.tabs.onRemoved.addListener((id) => epochByTab.delete(id));

chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
