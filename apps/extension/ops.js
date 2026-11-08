// Pure: the only commands the desktop may send. No eval / debugger / raw CDP.
export const OPS = ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','fetchMedia','downloads','account','arm','tabs','focus','probe','settings','listeners','attach','locate'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Flat names only (no path, no leading dot, no '..'): the desktop picks the name, the extension adds the ToolFlow-tmp/ folder.
export const validTmpName = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) && !s.includes('..');

export function isAllowedDownloadUrl(s) {
  let u; try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  // measured live: tile images are served from flow.google.com/asb/<key>=s<size>; other flow.google.com paths (the app's API) must never be fetched
  if (u.hostname === 'flow.google.com') return u.pathname.startsWith('/asb/');
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
  if (op === 'settings' && !['mode', 'aspect', 'quality', 'count', 'model'].every((k) => typeof args[k] === 'string' && args[k])) return 'settings needs mode, aspect, quality, count, model';
  if (op === 'attach' && !(typeof args.name === 'string' && args.name.length >= 1 && args.name.length <= 200)) return 'attach needs a name of 1..200 chars';
  if (op === 'locate' && !(Number.isInteger(args.tabId) && UUID.test(args.mediaId))) return 'locate needs integer tabId and a media uuid';
  if (op === 'fetchMedia' && !(Number.isInteger(args.tabId) && UUID.test(args.mediaId) && validTmpName(args.filename))) return 'fetchMedia needs integer tabId, a media uuid and a flat filename';
  if (op === 'downloads' && !(Number.isInteger(args.id) || validTmpName(args.filenamePrefix))) return 'downloads needs an integer id or a filenamePrefix';
  if (op === 'open' && !(typeof args.url === 'string' && args.url.startsWith('https://flow.google.com/'))) return 'open url not allowed';
  return null;
}

// Event from a tab -> message for the desktop. The epoch is the one main-world captured at its own submit; no epoch => not ours.
export function forwardEvent(tabId, ev) {
  if (!ev || !Number.isInteger(ev.epoch)) return null;
  return { type: ev.type, tabId, epoch: ev.epoch, ...(ev.type === 'response' ? { rpc: ev.rpc, text: ev.text } : {}), request: ev.request };
}

// ---- downloads: the url lives only inside the extension (R54); results carry ids, state, path, size, mime, error code ----
export const shapeDownload = (d) => ({ id: d.id, state: d.state, filename: d.filename, fileSize: d.fileSize, mime: d.mime, error: d.error ?? null });
const codeOf = (c) => (typeof c === 'string' && /^[A-Z_]{1,30}$/.test(c) ? c : 'NOT_FOUND');

/** The tab's content script answers an INTERNAL message with the tile's src (not an allowlisted op, never forwarded). Codes only on failure. */
export async function fetchMediaOp(c, a) {
  let r;
  try { r = await c.tabs.sendMessage(a.tabId, { tf: 'src', mediaId: a.mediaId }); } catch { return { ok: false, code: 'NO_CONTENT_SCRIPT' }; }
  if (!r || typeof r.src !== 'string') return { ok: false, code: codeOf(r?.code) };
  if (!isAllowedDownloadUrl(r.src)) { let host = '?'; try { host = new URL(r.src).hostname; } catch { /* keep ? */ } return { ok: false, code: 'SRC_NOT_ALLOWED', host }; } // host only: never the url
  try {
    const downloadId = await c.downloads.download({ url: r.src, filename: 'ToolFlow-tmp/' + a.filename, conflictAction: 'uniquify' });
    return Number.isInteger(downloadId) ? { ok: true, downloadId } : { ok: false, code: 'DOWNLOAD_REFUSED' };
  } catch { return { ok: false, code: 'DOWNLOAD_REFUSED' }; } // the browser's message can echo the url: never forward it
}

export async function downloadsOp(c, a) {
  const q = Number.isInteger(a.id) ? { id: a.id } : { filenameRegex: 'ToolFlow-tmp[\\\\/]' + a.filenamePrefix.replace(/[.]/g, '\\.'), limit: 20 };
  return (await c.downloads.search(q)).map(shapeDownload);
}
