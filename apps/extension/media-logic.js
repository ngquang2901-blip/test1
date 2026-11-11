// Pure logic (no DOM): which content token belongs to which video media, read from Flow's own answers.
// A video tile carries no media id (measured live 2026-11-11); the project listing (Zzl0ze) and the single-media answer (as29s)
// do: entry = [mediaId, projectId, workflowId, _, _, gen, image?, video?], gen[5] = content url *.googleusercontent.com/asb/<token>,
// and the tile's thumbnail is flow.google.com/asb/<same token>. Loaded before main-world.js; node tests import it for globalThis.TFMedia.
(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CONTENT = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\/asb\/([A-Za-z0-9_-]{20,400})(?:=[^/?#]*)?$/; // a plain token only: it becomes part of a download address
  const one = (e) => {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !UUID.test(e[0]) || !Array.isArray(e[5]) || !Array.isArray(e[7])) return null; // [7] exists for a video only
    const m = [e[5][5], e[5][10]].map((u) => (typeof u === 'string' ? CONTENT.exec(u) : null)).find(Boolean); // [5][5] is empty in the as29s answer that follows a finish; [5][10] holds the same token
    return m ? [e[0].toLowerCase(), m[1]] : null;
  };
  /** [[mediaId, token], …] for the video media in one batchexecute answer of `rpc`; anything unreadable teaches nothing. */
  function videoTokens(text, rpc) {
    const out = [];
    for (const line of String(text ?? '').split('\n')) {
      if (line[0] !== '[') continue;
      let frames; try { frames = JSON.parse(line); } catch (_) { continue; }
      for (const f of Array.isArray(frames) ? frames : []) {
        if (!Array.isArray(f) || f[0] !== 'wrb.fr' || f[1] !== rpc || typeof f[2] !== 'string') continue;
        let p; try { p = JSON.parse(f[2]); } catch (_) { continue; }
        for (const e of rpc === 'Zzl0ze' ? (Array.isArray(p?.[2]) ? p[2] : []) : [p]) { const hit = one(e); if (hit) out.push(hit); }
      }
    }
    return out;
  }
  // Spike finding (FINDINGS "Tải"): the thumbnail address with this suffix is the MP4; it needs the browser's cookies, so only chrome.downloads can fetch it.
  const mp4 = (token) => `https://flow.google.com/asb/${token}=mm,22,15`;
  globalThis.TFMedia = { videoTokens, mp4 };
})();
