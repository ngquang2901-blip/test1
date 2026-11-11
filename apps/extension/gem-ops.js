// SPIKE, isolated-world content script on gemini.google.com: read-only structure of the page for the Gemini driver.
// Nothing here returns conversation text, titles or addresses: tags, attribute NAMES, control labels of the composer, counts, masked shapes.
(() => {
  if (window.__tfGemOps) return; window.__tfGemOps = true;
  const short = (s, n = 40) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const shape = (s) => String(s || '').replace(/[a-z]/g, 'a').replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9').slice(0, 60); // what an id looks like, not the id
  const ctl = (e) => { const o = { tag: e.tagName.toLowerCase() }; for (const [k, a] of [['testid', 'data-test-id'], ['aria', 'aria-label'], ['tip', 'mattooltip'], ['role', 'role']]) { const v = e.getAttribute(a); if (v) o[k] = short(v, 50); } if (e.disabled || e.getAttribute('aria-disabled') === 'true') o.disabled = true; o.cls = short(e.className, 50); return o; };
  const img = (i) => { let u; try { u = new URL(i.currentSrc || i.src, location.href); } catch (_) { return { bad: true }; } return { scheme: u.protocol, host: u.host, pathShape: shape(u.pathname.slice(0, 30)), keys: [...u.searchParams.keys()].slice(0, 6), w: i.naturalWidth, h: i.naturalHeight, complete: i.complete, cls: short(i.className, 40) }; };
  const census = (root) => { const n = {}; for (const e of root.querySelectorAll('*')) if (e.tagName.includes('-')) n[e.tagName.toLowerCase()] = (n[e.tagName.toLowerCase()] || 0) + 1; return n; };
  const attrNames = (e) => [...e.attributes].map((x) => x.name).filter((n) => n !== 'class' && n !== 'style' && !n.startsWith('_ng'));

  const OPS = {
    gemLook() {
      const main = document.querySelector('main') || document.body;
      const input = document.querySelector('input-area-v2, input-area, .input-area-container, rich-textarea')?.closest('input-area-v2, input-area, .input-area-container') || document.querySelector('rich-textarea')?.parentElement;
      const turns = [...document.querySelectorAll('.conversation-container, [id^="conversation-container"], conversation-turn')].slice(-3);
      return {
        pathShape: shape(location.pathname), visible: document.visibilityState,
        editors: [...document.querySelectorAll('rich-textarea [contenteditable], .ql-editor, textarea')].map((e) => ({ ...ctl(e), editable: e.getAttribute('contenteditable'), len: (e.innerText || e.value || '').length })),
        inputButtons: input ? [...input.querySelectorAll('button, [role="button"]')].slice(0, 20).map(ctl) : null,
        mainTags: census(main),
        turns: turns.map((t) => ({ tag: t.tagName.toLowerCase(), attrs: attrNames(t), idShape: shape(t.id), tags: census(t), imgs: [...t.querySelectorAll('img')].slice(0, 4).map(img), buttons: [...t.querySelectorAll('button')].slice(0, 12).map(ctl), textLen: t.innerText.length })),
        overlays: [...document.querySelectorAll('.cdk-overlay-pane, mat-dialog-container, [role="dialog"], [role="menu"]')].map((d) => ({ ...ctl(d), items: [...d.querySelectorAll('button, [role="menuitem"]')].slice(0, 20).map(ctl) })),
      };
    },
  };

  chrome.runtime.onMessage.addListener((m, s, reply) => {
    if (m?.tf !== 'op') return;
    const f = OPS[m.op];
    if (!f) { reply({ error: 'unknown page op ' + m.op }); return; }
    Promise.resolve().then(() => f(m.args)).then((result) => reply({ result }), (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
})();
