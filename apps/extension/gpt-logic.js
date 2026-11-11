// Pure logic for the ChatGPT tab (no DOM access): which menu item turns on image mode, whether a user bubble is our prompt, ids.
// Loaded before gpt-ops.js in the same isolated world; the service worker and node tests import it for its globalThis.TFGpt side effect.
(() => {
  const flat = (t) => String(t ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const isUuid = (s) => new RegExp(`^${UUID}$`).test(String(s));

  // What the composer's mode pill says when image mode is on (data-system-hint-type, measured 2026-11-11).
  const IMAGE_MODE = 'picture_v2';
  // The "+" menu item that turns it on, per UI language. Measured: English only; another language finds nothing and nothing is clicked.
  const MODE_LABELS = ['Create image'];
  const isModeLabel = (text) => MODE_LABELS.some((l) => flat(text).toLowerCase().startsWith(l.toLowerCase()));

  // The user's bubble shows the mode pill's label and then the prompt. Ours only on an exact match: the prompt alone, or one known label + the prompt.
  const ownsBubble = (bubble, prompt, pills = []) => {
    const b = flat(bubble), p = flat(prompt);
    if (!p) return false;
    return b === p || [...pills, ...MODE_LABELS].some((l) => flat(l) && b === `${flat(l)} ${p}`);
  };

  // One output = image n (1-based) of one assistant message.
  const mediaId = (msgId, n) => `${msgId}-${n}`;
  const parseMediaId = (s) => { const m = new RegExp(`^(${UUID})-([1-9][0-9]?)$`).exec(String(s)); return m ? { msgId: m[1], n: Number(m[2]) } : null; };
  // /c/<uuid> only: the start page and the short-lived /c/local-… of a conversation being created have no id yet
  const convOf = (path) => (new RegExp(`^/c/(${UUID})$`).exec(String(path)) || [])[1] || null;
  // What the page may hand to chrome.downloads: the bytes of one image, nothing with an address in it
  const isImageDataUrl = (s) => typeof s === 'string' && s.length < 60_000_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]/.test(s.slice(0, 40));

  globalThis.TFGpt = { flat, isUuid, IMAGE_MODE, MODE_LABELS, isModeLabel, ownsBubble, mediaId, parseMediaId, convOf, isImageDataUrl };
})();
