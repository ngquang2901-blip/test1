// Pure logic for the Gemini tab (no DOM access): ids, whether a query is our prompt, which download is Gemini's own.
// Loaded before gem-ops.js in the same isolated world; the service worker and node tests import it for its globalThis.TFGem side effect.
(() => {
  const flat = (t) => String(t ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const HEX = '[0-9a-f]{8,32}'; // measured: 16 hex chars for a conversation and for a turn
  const isId = (s) => new RegExp(`^${HEX}$`).test(String(s));

  // The "+" menu entry that makes an image is found by its icon's name, the same in every UI language (measured on a Vietnamese UI).
  const IMAGE_ICON = 'image_create';
  const IMAGE_MODE = 'image';

  // The turn's query lines hold the prompt and nothing else.
  const ownsQuery = (text, prompt) => { const p = flat(prompt); return p.length > 0 && flat(text) === p; };

  // One output = image n (1-based) of one turn.
  const mediaId = (turn, n) => `${turn}-${n}`;
  const parseMediaId = (s) => { const m = new RegExp(`^(${HEX})-([1-9][0-9]?)$`).exec(String(s)); return m ? { turn: m[1], n: Number(m[2]) } : null; };
  const convOf = (path) => (new RegExp(`^/app/(${HEX})$`).exec(String(path)) || [])[1] || null;

  // The page's own "download full size" starts a browser download from an opaque blob with no referrer (measured), so the address says nothing:
  // it is ours to name only when it is an image with Gemini's own file name, in the moment right after our press.
  const isGeminiDownload = (item) => String(item?.url ?? '').startsWith('blob:') && /^image\/(png|jpeg|webp)$/.test(String(item?.mime ?? ''))
    && /^Gemini_Generated_Image_[A-Za-z0-9]+\.[a-z]{3,4}$/.test(String(item?.filename ?? '').split(/[\\/]/).pop());

  globalThis.TFGem = { flat, isId, IMAGE_ICON, IMAGE_MODE, ownsQuery, mediaId, parseMediaId, convOf, isGeminiDownload };
})();
