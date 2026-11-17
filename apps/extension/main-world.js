// MAIN world, document_start (D-12 / ADR-0002). Records click listeners Flow attaches to buttons; on request calls the
// submit button's listener with a Proxy(MouseEvent) reporting isTrusted:true. Does not touch reCAPTCHA.
// Talks to the isolated-world page-ops.js only through one private MessageChannel port (no DOM events: page scripts could forge those).
(() => {
  if (window.__tfMain) return; window.__tfMain = true;
  const reg = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, l, o) {
    if (type === 'click' && l && this instanceof HTMLButtonElement) {
      let s = reg.get(this); if (!s) reg.set(this, (s = new Set())); s.add(l);
    }
    return nativeAdd.call(this, type, l, o);
  };
  EventTarget.prototype.removeEventListener = function (type, l, o) {
    if (type === 'click') reg.get(this)?.delete(l);
    return nativeRemove.call(this, type, l, o);
  };
  const SUBMIT = 'flow-prompt-box button[type="submit"]';
  // shortcut: a script that runs before ours could still take the port from the 'toolflow:port' message; upgrade only if Chrome offers a private page<->content-script channel
  let port = null; const H = {}; // H: request name -> handler(detail) returning the answer
  const emit = (name, detail) => { if (!port) throw new Error('no port'); port.postMessage({ name, detail }); };
  const onPort = (e) => {
    if (e.source !== window || e.data !== 'toolflow:port' || !e.ports || e.ports.length !== 1) return;
    port = e.ports[0]; nativeRemove.call(window, 'message', onPort);
    port.onmessage = (m) => {
      const q = m.data; if (!q || typeof q !== 'object' || typeof q.name !== 'string' || !Object.hasOwn(H, q.name)) return;
      try { const r = H[q.name](q.detail && typeof q.detail === 'object' ? q.detail : {}); if (r !== undefined) port.postMessage({ name: q.name + '-result', id: q.id, detail: r }); } catch (_) { /* malformed: ignored */ }
    };
  };
  nativeAdd.call(window, 'message', onPort);
  const covered = (b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(e && b.closest('flow-prompt-box').contains(e)); };

  const tracker = globalThis.makeEpochTracker(); // epoch.js: one click ↔ one generate send, else undefined
  delete globalThis.makeEpochTracker;
  const TFMedia = globalThis.TFMedia; // media-logic.js
  delete globalThis.TFMedia;
  // manual mode: the user clicks Gửi, we only observe; arm(epoch) = same as our own click, null disarms
  H['toolflow:arm'] = ({ epoch: ep }) => {
    if (Number.isInteger(ep)) tracker.submit(ep, true); else if (ep === null) tracker.clear(); else return;
    return { ok: true };
  };
  H['toolflow:submit'] = ({ epoch: ep }) => {
    const b = document.querySelector(SUBMIT);
    const ls = b && reg.get(b);
    const out = { found: !!b, disabled: b?.disabled ?? null, listeners: ls ? ls.size : 0, called: 0 };
    // fail closed: a cover (cookie banner, overlay) means nothing is sent
    if (b && ls && ls.size === 1 && !b.disabled && !covered(b)) {
      tracker.submit(ep, true); // before the listener: a synchronous send inside it must already carry the epoch
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0 });
      const p = new Proxy(ev, {
        get(t, k) {
          if (k === 'isTrusted') return true;
          if (k === 'target' || k === 'currentTarget' || k === 'srcElement') return b;
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      for (const l of ls) { out.called++; /* before the call: a throwing listener may still have sent */ try { typeof l === 'function' ? l.call(b, p) : l.handleEvent(p); } catch (e) { /* uncertain, not rejected */ } }
    }
    return out;
  };
  H['toolflow:hit'] = () => {
    const b = document.querySelector(SUBMIT);
    return b ? { covered: covered(b) } : null;
  };

  // Read-only: how many click listeners Flow attached to the submit button. Never calls one, never arms.
  H['toolflow:listeners'] = () => {
    const b = document.querySelector(SUBMIT); const ls = b && reg.get(b);
    return { found: !!b, disabled: b?.disabled ?? null, listeners: ls ? ls.size : 0 };
  };

  // Read-only network observer.
  const RPCS = /rpcids=(ogiZ0b|YhhmEf|eb1hJf|nprQif|MZZa6b|maseQ|jwpduf|as29s|Zzl0ze|nzlxg|bOKtO)/;
  const GEN = /^(ogiZ0b|YhhmEf|MZZa6b|eb1hJf|nprQif)$/; // generate calls: forwarded to the desktop as events
  const BIG = /^(Zzl0ze|bOKtO)$/;
  const net = []; let netOn = false; // the ring (up to 3 MB a record) only fills once a `net` op has asked for it: live scripts do, the product never
  const seen = {}; // rpc names that completed OK since page load (names only: the self-check wants proof the project loaded)
  const obs = { id: crypto.randomUUID(), seq: 0, dropped: 0 };
  const media = new Map(); // video media id -> content token, learnt from Flow's own answers; never leaves the page except as the download's address
  const push = (url, body, status, text, via) => {
    const m = RPCS.exec(url); if (!m) return;
    if (m[1] === 'as29s' || m[1] === 'Zzl0ze') for (const [id, token] of TFMedia.videoTokens(text, m[1])) media.set(id, token);
    const rec = { t: Date.now(), rpc: m[1], via, status, res: String(text || '').slice(0, BIG.test(m[1]) ? 3_000_000 : 6000), seq: ++obs.seq };
    if (status >= 200 && status < 300) seen[rec.rpc] = true;
    if (netOn) { net.push(rec); if (net.length > 200) net.shift(); } // overflow is normal (the ring is a debug tail): sent/response events never go through it
  };
  const out = (ev) => { try { emit('toolflow:event', ev); } catch (_) { obs.dropped++; } }; // dropped = a real observer failure, so a skip can no longer prove 'nothing sent'
  const gen = (url) => { const m = RPCS.exec(url); return m && GEN.test(m[1]) ? m[1] : null; };
  const poll = (url, text) => { if (/rpcids=jwpduf/.test(url)) out({ type: 'poll', text: String(text || '') }); }; // Flow polls its videos by itself; the desktop only reads the answers
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  let probe = null, reached = false; // heartbeat: a request object that is never opened, to see whether a call still gets to our hooks
  XMLHttpRequest.prototype.open = function (m, u) { if (this === probe) { reached = true; return; } this.__tfUrl = String(u); return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (this === probe) { reached = true; return; }
    const url = this.__tfUrl || '';
    if (RPCS.test(url)) {
      const rpc = gen(url); const req = String(b || ''); const epoch = rpc ? tracker.send() : undefined;
      if (rpc) out({ type: 'sent', epoch, request: req });
      nativeAdd.call(this, 'loadend', () => { try {
        push(url, b, this.status, this.responseText, 'xhr');
        poll(url, this.responseText);
        if (rpc) out({ type: 'response', epoch, rpc, text: this.responseText, request: req });
      } catch (e) { /* observer must never break the page */ } });
    }
    return xs.apply(this, arguments);
  };
  // Live finding: Flow sends generate (ogiZ0b) via fetch, so this path must feed the same sent/response events as XHR.
  const readBody = (input, init) => { try { // sync part runs before the page fetch can consume a Request body
    if (init && init.body != null) return Promise.resolve(String(init.body));
    if (input && typeof input.clone === 'function') return input.clone().text();
  } catch (_) { /* unreadable body: desktop fails closed on an empty request */ } return Promise.resolve(''); };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = String(input?.url || input);
    const rpc = gen(url);
    const reqP = rpc ? readBody(input, init).catch(() => '') : null;
    const epoch = rpc ? tracker.send() : undefined; // counts gen too, so a skip can never read 'nothing sent'
    if (reqP) reqP.then((request) => out({ type: 'sent', epoch, request })).catch(() => {});
    const r = await of.apply(this, arguments);
    if (RPCS.test(url)) r.clone().text().then(async (t) => {
      push(url, '', r.status, t, 'fetch');
      poll(url, t);
      if (rpc) out({ type: 'response', epoch, rpc, text: t, request: await reqP });
    }).catch(() => {});
    return r;
  };
  H['toolflow:net'] = () => { netOn = true; return net.splice(0, net.length); };
  // The MP4 address of one video media, for the isolated world's internal download message only.
  H['toolflow:media'] = ({ mediaId }) => {
    const id = String(mediaId).toLowerCase();
    return { src: media.has(id) ? TFMedia.mp4(media.get(id)) : null };
  };
  // heartbeat: are our hooks still the ones the page calls? Being the installed function is one proof. The other: a page script may put its
  // own wrapper on top and call the one before (seen 2026-11-12: Flow's bundle redefines send as `function(){…;return d.apply(this,arguments)}`);
  // then every request still passes ours. So a throwaway, never-opened request is put through whatever is installed: ours stops it and
  // says so, nothing leaves the page. A replacement that leaves ours out does not reach it: that is the loss this reports.
  const through = (name, ours) => {
    const cur = XMLHttpRequest.prototype[name];
    if (cur === ours) return true;
    probe = new XMLHttpRequest(); reached = false;
    try { cur.call(probe, 'GET', 'about:blank'); } catch (_) { /* not ours: an unopened request throws in the browser's own send */ }
    probe = null;
    return reached;
  };
  const ourSend = XMLHttpRequest.prototype.send, ourOpen = XMLHttpRequest.prototype.open, ourFetch = window.fetch;
  H['toolflow:ping'] = () => {
    const meta = document.querySelector('meta[name="toolflow-version"]');
    return {
      xhrSend: through('send', ourSend), xhrOpen: through('open', ourOpen),
      fetch: window.fetch === ourFetch, ...obs, seen: Object.keys(seen), gen: tracker.gen, t: Date.now(), version: meta ? meta.content : '' };
  };
})();
