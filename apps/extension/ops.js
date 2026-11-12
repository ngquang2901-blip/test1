// Pure: the only commands the desktop may send. No eval / debugger / raw CDP.
import './gpt-logic.js';
import './gem-logic.js';
const G = globalThis.TFGpt, M = globalThis.TFGem;
export const OPS = ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','fetchMedia','downloads','account','arm','tabs','focus','probe','settings','listeners','attach','locate','gptTabs','gptNew','gptOpen','gptFront','gptLook','gptState','gptMode','gptPrep','gptSend','gptTurns','gptFetch','gptAttach','gemTabs','gemNew','gemOpen','gemLook','gemState','gemMode','gemPrep','gemSend','gemTurns','gemFetch','gemAttach'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Flat names only (no path, no leading dot, no '..'): the desktop picks the name, the extension adds the ToolFlow-tmp/ folder.
export const validTmpName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) && !s.includes('..');

export function isAllowedDownloadUrl(s) {
  let u; try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  // measured live: tile images are served from flow.google.com/asb/<key>=s<size>; other flow.google.com paths (the app's API) must never be fetched
  // after /asb/ no encoded or literal way to leave it: no %, no .., no backslash, no // (checked on the raw string too, the parser normalises some of them away)
  if (u.hostname === 'flow.google.com') return u.pathname.startsWith('/asb/') && !/[%\\]|\.\.|\/\//.test(s.slice(s.indexOf('/asb/') + 4));
  return u.hostname === 'flow-content.google' || u.hostname.endsWith('.googleusercontent.com');
}

export function validate(msg) {
  if (!msg || typeof msg !== 'object') return 'bad message';
  const { id, epoch, op, args } = msg;
  if (!Number.isInteger(id)) return 'missing id';
  if (!Number.isInteger(epoch)) return 'missing epoch';
  if (!OPS.includes(op)) return `op not allowed: ${op}`;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'args must be an object';
  if (op === 'arm' && !(Number.isInteger(args.epoch) || args.epoch === null)) return 'arm needs integer epoch or null';
  if (op === 'focus' && !Number.isInteger(args.tabId)) return 'focus needs integer tabId';
  if (op === 'probe' && !(args.selectors && typeof args.selectors === 'object' && !Array.isArray(args.selectors) && Object.values(args.selectors).every((v) => typeof v === 'string' && v.length < 300))) return 'probe needs a selectors map of strings';
  if (op === 'settings' && !(['mode', 'aspect', 'count', 'model'].every((k) => typeof args[k] === 'string' && args[k]) && (args.quality === null || (typeof args.quality === 'string' && args.quality)) && (args.input === undefined || (typeof args.input === 'string' && args.input)))) return 'settings needs mode, aspect, count, model, a quality (null for a model without one) and, for video, the input type';
  if (op === 'attach' && !(typeof args.name === 'string' && args.name.length >= 1 && args.name.length <= 200)) return 'attach needs a name of 1..200 chars';
  if (op === 'attach' && args.slot !== undefined && args.slot !== 'start' && args.slot !== 'end') return 'attach: slot is start or end';
  if (op === 'locate' && !(Number.isInteger(args.tabId) && UUID.test(args.mediaId))) return 'locate needs integer tabId and a media uuid';
  if (op === 'fetchMedia' && !(Number.isInteger(args.tabId) && UUID.test(args.mediaId) && validTmpName(args.filename))) return 'fetchMedia needs integer tabId, a media uuid and a flat filename';
  if (op === 'downloads' && !(Number.isInteger(args.id) || validTmpName(args.filenamePrefix))) return 'downloads needs an integer id or a filenamePrefix';
  if (['gptNew', 'gptOpen', 'gptFront', 'gptLook', 'gptState', 'gptMode', 'gptPrep', 'gptSend', 'gptTurns', 'gptFetch', 'gptAttach'].includes(op) && !Number.isInteger(args.tabId)) return `${op} needs integer tabId`;
  if (['gptPrep', 'gptSend', 'gptTurns'].includes(op) && !(typeof args.prompt === 'string' && args.prompt.length >= 1 && args.prompt.length <= 20000)) return `${op} needs a prompt of 1..20000 chars`;
  if (['gemNew', 'gemOpen', 'gemLook', 'gemState', 'gemMode', 'gemPrep', 'gemSend', 'gemTurns', 'gemFetch', 'gemAttach'].includes(op) && !Number.isInteger(args.tabId)) return `${op} needs integer tabId`;
  if (['gemPrep', 'gemSend', 'gemTurns'].includes(op) && !(typeof args.prompt === 'string' && args.prompt.length >= 1 && args.prompt.length <= 20000)) return `${op} needs a prompt of 1..20000 chars`;
  if (op === 'gemOpen' && !M.isId(args.conv)) return 'gemOpen needs a conversation id';
  if (op === 'gemMode' && args.aspect !== undefined && !Object.hasOwn(M.ASPECT_ICONS, args.aspect)) return 'gemMode: unknown aspect';
  if (op === 'gemMode' && args.model !== undefined && !M.MODELS.includes(args.model)) return 'gemMode: unknown model';
  if ((op === 'gemAttach' || op === 'gptAttach') && !(M.isRefFile(args) && (args.clear === undefined || typeof args.clear === 'boolean'))) return `${op} needs a flat name, an image type, base64 bytes and an optional boolean clear`;
  if ((op === 'gemSend' || op === 'gptSend') && args.refs !== undefined && !(Number.isInteger(args.refs) && args.refs >= 0 && args.refs <= M.MAX_REFS)) return `${op}: refs is a count of 0..10`;
  if (op === 'gemFetch' && !(M.parseMediaId(args.mediaId) && validTmpName(args.filename))) return 'gemFetch needs a Gemini media id and a flat filename';
  if (op === 'gptFront' && args.raise !== undefined && typeof args.raise !== 'boolean') return 'gptFront: raise is a boolean';
  if (op === 'gptOpen' && !G.isUuid(args.conv)) return 'gptOpen needs a conversation uuid';
  if (op === 'gptFetch' && !(G.parseMediaId(args.mediaId) && validTmpName(args.filename))) return 'gptFetch needs a ChatGPT media id and a flat filename';
  if (op === 'open' && !(typeof args.url === 'string' && args.url.startsWith('https://flow.google.com/'))) return 'open url not allowed';
  return null;
}

// Event from a tab -> message for the desktop. The epoch is the one main-world captured at its own submit; no epoch => not ours.
export function forwardEvent(tabId, ev) {
  if (ev?.type === 'poll') return typeof ev.text === 'string' ? { type: 'poll', tabId, text: ev.text } : null; // Flow's own video polls: no click, so no epoch
  if (!ev || !Number.isInteger(ev.epoch)) return null;
  return { type: ev.type, tabId, epoch: ev.epoch, ...(ev.type === 'response' ? { rpc: ev.rpc, text: ev.text } : {}), request: ev.request };
}

// ---- downloads: the url lives only inside the extension (R54); results carry ids, state, path, size, mime, error code ----
export const shapeDownload = (d) => ({ id: d.id, state: d.state, filename: d.filename, fileSize: d.fileSize, mime: d.mime, error: d.error ?? null });
// Measured: while this extension listens for filenames (a Gemini save does, and a moment after), the browser drops download()'s own filename for
// EVERY download of ours: a ChatGPT image of that moment landed in Downloads as "download". So each one is remembered by its id and named
// again when the browser asks (nameOurs).
const ourNames = new Map(); // download id -> its name inside ToolFlow-tmp; in memory only
async function startDownload(c, url, filename) {
  const id = await c.downloads.download({ url, filename: 'ToolFlow-tmp/' + filename, conflictAction: 'uniquify' });
  if (Number.isInteger(id)) { ourNames.set(id, filename); if (ourNames.size > 500) ourNames.delete(ourNames.keys().next().value); } // nobody asks when no listener is up: the oldest go
  return id;
}
/** For a filename listener: true when the download is ours; its name is suggested as soon as download() has said which id it is. */
function nameOurs(c, item, suggest) {
  if (!item || item.byExtensionId !== c.runtime.id) return false;
  (async () => {
    for (let i = 0; i < 40 && !ourNames.has(item.id); i++) await new Promise((r) => setTimeout(r, 50)); // the browser may ask first
    const name = ourNames.get(item.id); ourNames.delete(item.id);
    if (name) suggest({ filename: 'ToolFlow-tmp/' + name, conflictAction: 'uniquify' }); else suggest();
  })();
  return true; // the answer comes later
}
const codeOf = (c) => (typeof c === 'string' && /^[A-Z_]{1,30}$/.test(c) ? c : 'NOT_FOUND');

/** The tab's content script answers an INTERNAL message with the tile's src (not an allowlisted op, never forwarded). Codes only on failure. */
export async function fetchMediaOp(c, a) {
  let r;
  try { r = await c.tabs.sendMessage(a.tabId, { tf: 'src', mediaId: a.mediaId }); } catch { return { ok: false, code: 'NO_CONTENT_SCRIPT' }; }
  if (!r || typeof r.src !== 'string') return { ok: false, code: codeOf(r?.code) };
  if (!isAllowedDownloadUrl(r.src)) { let host = '?'; try { host = new URL(r.src).hostname; } catch { /* keep ? */ } return { ok: false, code: 'SRC_NOT_ALLOWED', host }; } // host only: never the url
  try {
    const downloadId = await startDownload(c, r.src, a.filename);
    return Number.isInteger(downloadId) ? { ok: true, downloadId } : { ok: false, code: 'DOWNLOAD_REFUSED' };
  } catch { return { ok: false, code: 'DOWNLOAD_REFUSED' }; } // the browser's message can echo the url: never forward it
}

/** ChatGPT: the tab's content script answers an INTERNAL message with the image's bytes as a data: URL (its blob: address cannot leave the page). */
export async function gptFetchOp(c, a) {
  let url = ''; try { url = (await c.tabs.get(a.tabId)).url || ''; } catch { /* no such tab */ }
  if (!url.startsWith('https://chatgpt.com/')) return { ok: false, code: 'NOT_CHATGPT_TAB' };
  let r;
  try { r = await c.tabs.sendMessage(a.tabId, { tf: 'gptSrc', mediaId: a.mediaId }); } catch { return { ok: false, code: 'NO_CONTENT_SCRIPT' }; }
  if (!r || typeof r.src !== 'string') return { ok: false, code: codeOf(r?.code) };
  if (!G.isImageDataUrl(r.src)) return { ok: false, code: 'SRC_NOT_ALLOWED' };
  try {
    const downloadId = await startDownload(c, r.src, a.filename);
    return Number.isInteger(downloadId) ? { ok: true, downloadId } : { ok: false, code: 'DOWNLOAD_REFUSED' };
  } catch { return { ok: false, code: 'DOWNLOAD_REFUSED' }; }
}

/** Gemini: the image on the page is a preview. The content script presses the page's own "download full size" (INTERNAL message) and answers
 *  with the address the page fetched the real file from; that address, checked, is downloaded here like any other output. The copy the page
 *  may start by itself is cancelled while this runs and a moment after. One at a time: one press at a time on the page.
 *  Measured: once an extension listens for filenames, the browser drops download()'s own filename, so ours is suggested when it asks. */
let gemQueue = Promise.resolve();
let gemLinger = null; // the listener of the request before, still up for its moment after
export function gemFetchOp(c, a, lingerMs = 15000) {
  const run = async () => {
    let tabUrl = ''; try { tabUrl = (await c.tabs.get(a.tabId)).url || ''; } catch { /* no such tab */ }
    if (!tabUrl.startsWith('https://gemini.google.com/')) return { ok: false, code: 'NOT_GEMINI_TAB' };
    if (gemLinger) { clearTimeout(gemLinger.timer); gemLinger.off(); gemLinger = null; }
    const asked = (item, suggest) => {
      if (nameOurs(c, item, suggest)) return true; // ours, of any site
      if (M.isGeminiDownload(item)) Promise.resolve().then(() => c.downloads.cancel(item.id)).then(() => c.downloads.erase({ id: item.id })).catch(() => undefined);
    };
    const off = () => c.downloads.onDeterminingFilename.removeListener(asked);
    c.downloads.onDeterminingFilename.addListener(asked);
    try {
      let r;
      try { r = await c.tabs.sendMessage(a.tabId, { tf: 'gemDownload', mediaId: a.mediaId }); } catch { return { ok: false, code: 'NO_CONTENT_SCRIPT' }; }
      if (!r || typeof r.url !== 'string') return { ok: false, code: codeOf(r?.code) };
      if (!M.isFullSizeUrl(r.url)) { let host = '?'; try { host = new URL(r.url).hostname; } catch { /* keep ? */ } return { ok: false, code: 'SRC_NOT_ALLOWED', host }; } // host only: never the url
      try {
        const downloadId = await startDownload(c, r.url, a.filename);
        if (Number.isInteger(downloadId)) return { ok: true, downloadId };
      } catch { /* the browser's message can echo the url: never forward it */ }
      return { ok: false, code: 'DOWNLOAD_REFUSED' };
    } finally { const me = { off, timer: setTimeout(() => { off(); if (gemLinger === me) gemLinger = null; }, lingerMs) }; gemLinger = me; }
  };
  const p = gemQueue.then(run, run);
  gemQueue = p.catch(() => undefined);
  return p;
}

export async function downloadsOp(c, a) {
  const q = Number.isInteger(a.id) ? { id: a.id } : { filenameRegex: 'ToolFlow-tmp[\\\\/]' + a.filenamePrefix.replace(/[.]/g, '\\.'), limit: 20 };
  return (await c.downloads.search(q)).map(shapeDownload);
}
