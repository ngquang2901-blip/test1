// Pure logic for the Gemini tab (no DOM access): ids, whether a query is our prompt, where the full-size file is, which download is the page's own copy.
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

  // The image on the page is a preview. Pressing the page's own "download full size" makes the page fetch the real file from Google's image
  // host (measured: https://lh3.googleusercontent.com/rd-gg/<long token>=s0-d-I?alr=yes for a reopened conversation, …/rd-gg-dl/… for an image
  // just made: the PNG itself, after two small answers that only carry the next address). The 1024 px preview comes from the same place and
  // is big too (…=s1024-rw, 0.65 MB WebP): the size option s0 with d (download) is what marks the real file. The extension downloads that address.
  const isFullSizeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /^lh[0-9]\.googleusercontent\.com$/.test(x.hostname) && !x.port && !x.username && !x.password && /^\/rd-gg(-dl)?\/[^/]+=s0-d(-[A-Za-z0-9]+)*$/.test(x.pathname); } catch { return false; } };
  const isFullSize = (entry) => isFullSizeUrl(entry?.name) && entry.encodedBodySize > 50_000;
  // The page then also hands the bytes to a sandboxed frame that starts a browser download: an opaque blob with no referrer, an image named
  // Gemini_Generated_Image_<id>. Chrome lets that through only once per page load the user started, so it cannot be relied on; when it does
  // start it is a second copy.
  const isGeminiDownload = (item) => String(item?.url ?? '').startsWith('blob:') && /^image\/(png|jpeg|webp)$/.test(String(item?.mime ?? ''))
    && /^Gemini_Generated_Image_[A-Za-z0-9]+\.[a-z]{3,4}$/.test(String(item?.filename ?? '').split(/[\\/]/).pop());

  globalThis.TFGem = { flat, isId, IMAGE_ICON, IMAGE_MODE, ownsQuery, mediaId, parseMediaId, convOf, isFullSizeUrl, isFullSize, isGeminiDownload };
})();
