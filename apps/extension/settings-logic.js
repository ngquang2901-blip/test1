// Pure logic for the composer settings panel (no DOM access): label normalization, group detection, select-until-stable.
// Loaded before page-ops.js in the same isolated world; node tests import it for its globalThis.TFSettings side effect.
(() => {
  const GROUPS = {
    mode: ['Image', 'Video'],
    input: ['Frames', 'Ingredients'], // Video only (seen live 2026-11-11): what the video is made from; Ingredients without refs is text-to-video
    aspect: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    quality: ['Low', 'Medium', 'High'],
    count: ['x1', 'x2', 'x3', 'x4'],
  };
  const ORDER = ['mode', 'input', 'aspect', 'quality', 'count'];
  // Flow follows the account language: the same radios read in Vietnamese (seen live 2026-11-10). Map them to the English labels the combo uses.
  const ALIAS = { 'Hình ảnh': 'Image', 'Khung hình': 'Frames', 'Thành phần': 'Ingredients', 'Thấp': 'Low', 'Trung bình': 'Medium', 'Cao': 'High' };

  // 'crop_16_9 16:9' -> '16:9', 'image Image' -> 'Image', 'x2' -> 'x2'. The leading token is a Material icon name (lowercase snake_case) when something follows it.
  const label = (t) => {
    const parts = String(t || '').replace(/\s+/g, ' ').trim().split(' ');
    if (parts.length > 1 && /^[a-z][a-z0-9_]*$/.test(parts[0])) parts.shift();
    const l = parts.join(' ');
    return ALIAS[l] ?? l;
  };
  // '🍌 Nano Banana 2.1 arrow_drop_down' -> 'Nano Banana 2.1': drop the emoji prefix and the trailing icon token.
  const modelLabel = (t) => String(t || '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s*arrow_drop\S*$/, '').trim();

  // buttons: [{ role, text, checked, ...anything }] -> { current: {group: label|null, model}, find: {group: {label: button}} }
  function read(buttons) {
    const current = { model: null }; const find = {};
    for (const g of ORDER) { current[g] = null; find[g] = {}; }
    for (const b of buttons) {
      if (b.role !== 'radio') { if (current.model === null && b.role == null) current.model = modelLabel(b.text); continue; }
      const l = label(b.text);
      const g = ORDER.find((k) => GROUPS[k].includes(l));
      if (!g) continue;
      find[g][l] = b;
      if (b.checked === 'true' || b.checked === true) current[g] = l;
    }
    if (!Object.keys(find.input).length) delete current.input; // only the Video panel has this group; an image panel reports none
    return { current, find };
  }

  // A group the combo does not name must be absent from the panel (an image combo names no input type; a video combo must name it).
  const mismatches = (cur, want) => [...ORDER, 'model'].filter((g) => (cur[g] ?? null) !== (want[g] ?? null));

  // getButtons(): fresh button list (re-read after EVERY click, Q-31: other groups can jump). click(button) must never reach the submit button.
  // pickModel(label), when given, picks the model from its menu: once, before the radios, because the option groups differ per model
  // (seen live: only Nano Banana 2.1 has the thinking-level radios; such a combo wants quality null). Without it the model is only verified.
  // The mode goes before the model: each mode has its own model menu and remembers its own model.
  async function converge(want, getButtons, click, { passes = 3, settle = async () => {}, pickModel } = {}) {
    let r = read(await getButtons());
    const pick = async (g) => {
      const b = r.find[g][want[g]];
      if (r.current[g] === want[g] || !b) return;
      click(b); await settle();
      r = read(await getButtons());
    };
    await pick('mode');
    if (pickModel && r.current.model !== want.model) { await pickModel(want.model); await settle(); r = read(await getButtons()); }
    for (let p = 0; p < passes && mismatches(r.current, want).length; p++) for (const g of ORDER) await pick(g);
    return { ok: mismatches(r.current, want).length === 0, current: r.current, mismatches: mismatches(r.current, want) };
  }

  globalThis.TFSettings = { GROUPS, label, modelLabel, read, mismatches, converge };
})();
