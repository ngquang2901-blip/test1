// Pure: the only commands the desktop may send. No eval / debugger / raw CDP.
export const OPS = ['ping','state','prep','radios','click','fill','hit','trusted','net','file','open','reloadTab','download','downloads','account','arm','tabs','focus','probe'];

const NEED_URL = new Set(['download', 'open']);

export function isAllowedDownloadUrl(s) {
  let u; try { u = new URL(s); } catch { return false; }
  return u.protocol === 'https:' && (u.hostname === 'flow-content.google' || u.hostname.endsWith('.googleusercontent.com'));
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
  if (op === 'download' && !isAllowedDownloadUrl(args.url)) return 'download url not allowed';
  if (op === 'open' && !(typeof args.url === 'string' && args.url.startsWith('https://flow.google.com/'))) return 'open url not allowed';
  return null;
}

// Event from a tab -> message for the desktop. The epoch is the one main-world captured at its own submit; no epoch => not ours.
export function forwardEvent(tabId, ev) {
  if (!ev || !Number.isInteger(ev.epoch)) return null;
  return { type: ev.type, tabId, epoch: ev.epoch, ...(ev.type === 'response' ? { rpc: ev.rpc, text: ev.text } : {}), request: ev.request };
}
