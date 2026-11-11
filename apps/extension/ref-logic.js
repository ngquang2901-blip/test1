// Pure logic for attaching a library image to the composer (no DOM access): name matching, chip diff, '+' button pick, the attach flow itself.
// Loaded before page-ops.js in the same isolated world; node tests import it for its globalThis.TFRef side effect.
(() => {
  const PREFIX = 20; // the library list truncates long names, so compare on the head only
  const prefix = (name) => String(name).slice(0, PREFIX);
  const flat = (t) => String(t || '').replace(/\s+/g, ' ');

  // texts: item texts in list order. Reports how many contain the prefix and, when exactly one, where; the list re-sorts (Q-17), so the caller must act on that item, not on a remembered position.
  function matchByName(texts, name) {
    const p = prefix(name); const hits = [];
    texts.forEach((t, i) => { if (flat(t).includes(p)) hits.push(i); });
    return { n: hits.length, i: hits.length === 1 ? hits[0] : -1 };
  }

  // Exactly one uuid that was not there before; a chip without a parsable uuid proves nothing.
  function newChip(before, after) {
    if (after.some((c) => typeof c !== 'string' || !c)) return { ok: false };
    const fresh = after.filter((c) => !before.includes(c));
    return fresh.length === 1 ? { ok: true, added: fresh[0] } : { ok: false };
  }

  // buttons: [{ text, label }] of the composer. The round '+' is the Material icon 'add' or an aria-label starting with Add; zero or several ⇒ -1 (fail closed).
  function plusIndex(buttons) {
    const hits = [];
    buttons.forEach((b, i) => { if (String(b.text || '').trim() === 'add' || /^add/i.test(String(b.label || ''))) hits.push(i); });
    return hits.length === 1 ? hits[0] : -1;
  }

  // The empty Start slot of the Frames composer (video from a first frame) is a button showing only its label; it opens the same library popover as '+'.
  const START = ['Start', 'Bắt đầu'];
  function startIndex(buttons) {
    const hits = [];
    buttons.forEach((b, i) => { if (START.includes(flat(b.text).trim())) hits.push(i); });
    return hits.length === 1 ? hits[0] : -1;
  }

  // env: chips() isOpen() open()->bool close() setSearch(q) items()->[{text,click}] addButton()->{click}|null. o.until(fn, ms) polls fn until truthy (null on timeout).
  async function attach(env, name, o) {
    const before = env.chips();
    if (!env.isOpen() && !(await env.open())) return { ok: false, code: 'NO_POPOVER' };
    try {
      env.setSearch(name);
      let hit = { n: 0, i: -1 }; let picked = null;
      const found = await o.until(() => {
        const items = env.items(); hit = matchByName(items.map((x) => x.text), name);
        picked = hit.n === 1 ? items[hit.i] : null; return picked;
      }, o.findMs ?? 8000);
      if (!found) return { ok: false, code: hit.n > 1 ? 'AMBIGUOUS' : 'NOT_FOUND' };
      // A freshly uploaded item shows in the library before its Add button works (measured: ~10-15 s). Re-click only while NO chip exists at all
      // (even an unreadable one), so a slow chip can never be added twice.
      const retryMs = o.retryMs ?? 3000; let diff = { ok: false };
      for (let round = 0; ; round++) {
        picked.click();
        const add = await o.until(() => env.addButton(), 5000);
        if (!add) return { ok: false, code: 'NO_ADD' };
        add.click();
        const appeared = await o.until(() => env.chips().length > before.length, retryMs);
        if (appeared) break;
        if (round >= (o.maxRounds ?? 6)) return { ok: false, code: 'NO_CHIP' };
        const items = env.items(); const h = matchByName(items.map((x) => x.text), name);
        if (h.n !== 1) return { ok: false, code: h.n > 1 ? 'AMBIGUOUS' : 'NOT_FOUND' };
        picked = items[h.i];
      }
      await o.until(() => { diff = newChip(before, env.chips()); return diff.ok; }, o.chipMs ?? 10000); // the chip can exist before its image src (the uuid) is readable
      return diff.ok ? { ok: true, chips: env.chips(), added: diff.added } : { ok: false, code: 'NO_CHIP' };
    } finally { if (env.isOpen()) env.close(); }
  }

  // The library's confirm button, per Flow UI language (Vietnamese seen live 2026-11-10 on a vi account).
  const ADD_LABELS = ['Add to prompt', 'Thêm vào câu lệnh'];
  const isAddLabel = (t) => ADD_LABELS.includes(String(t || '').replace(/\s+/g, ' ').trim());
  globalThis.TFRef = { prefix, matchByName, newChip, plusIndex, startIndex, attach, isAddLabel };
})();
