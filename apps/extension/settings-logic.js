// Pure logic for the composer settings panel (no DOM access): label normalization, group detection, select-until-stable.
// Loaded before page-ops.js in the same isolated world; node tests import it for its globalThis.TFSettings side effect.
(() => {
  const GROUPS = {
    mode: ['Image', 'Video'],
    aspect: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    quality: ['Low', 'Medium', 'High'],
    count: ['x1', 'x2', 'x3', 'x4'],
  };
  const ORDER = ['mode', 'aspect', 'quality', 'count'];

  // 'crop_16_9 16:9' -> '16:9', 'image Image' -> 'Image', 'x2' -> 'x2'. The leading token is a Material icon name (lowercase snake_case) when something follows it.
  const label = (t) => {
    const parts = String(t || '').replace(/\s+/g, ' ').trim().split(' ');
    if (parts.length > 1 && /^[a-z][a-z0-9_]*$/.test(parts[0])) parts.shift();
    return parts.join(' ');
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
    return { current, find };
  }

  const mismatches = (cur, want) => [...ORDER, 'model'].filter((g) => cur[g] !== want[g]);

  // getButtons(): fresh button list (re-read after EVERY click, Q-31: other groups can jump). click(button) must never reach the submit button.
  // The model is verified, never changed (P2).
  async function converge(want, getButtons, click, { passes = 3, settle = async () => {} } = {}) {
    let r = read(await getButtons());
    for (let p = 0; p < passes && mismatches(r.current, want).length; p++) {
      for (const g of ORDER) {
        if (r.current[g] === want[g]) continue;
        const b = r.find[g][want[g]];
        if (!b) continue;
        click(b); await settle();
        r = read(await getButtons());
      }
    }
    return { ok: mismatches(r.current, want).length === 0, current: r.current, mismatches: mismatches(r.current, want) };
  }

  globalThis.TFSettings = { GROUPS, label, modelLabel, read, mismatches, converge };
})();
