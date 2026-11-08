// MAIN world, document_start (D-12 / ADR-0002). Records click listeners Flow attaches to buttons; on request calls the
// submit button's listener with a Proxy(MouseEvent) reporting isTrusted:true. Does not touch reCAPTCHA.
// Talks to the isolated-world page-ops.js only through DOM events carrying JSON strings.
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
  const emit = (name, obj) => document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(obj) }));
  const covered = (b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !(e && b.closest('flow-prompt-box').contains(e)); };

  let cur; // epoch of the latest trusted submit; stamped onto the XHR it triggers
  nativeAdd.call(document, 'toolflow:submit', (e) => {
    try { cur = JSON.parse(e.detail).epoch; } catch (_) { cur = undefined; }
    const b = document.querySelector(SUBMIT);
    const ls = b && reg.get(b);
    const out = { found: !!b, disabled: b?.disabled ?? null, listeners: ls ? ls.size : 0, called: 0 };
    // fail closed: a cover (cookie banner, overlay) means nothing is sent
    if (b && ls && ls.size === 1 && !b.disabled && !covered(b)) {
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
    emit('toolflow:submit-result', out);
  });
  nativeAdd.call(document, 'toolflow:hit', () => {
    const b = document.querySelector(SUBMIT);
    emit('toolflow:hit-result', b ? { covered: covered(b) } : null);
  });

  // Read-only network observer.
  const RPCS = /rpcids=(ogiZ0b|YhhmEf|eb1hJf|nprQif|MZZa6b|maseQ|jwpduf|as29s|Zzl0ze|nzlxg|bOKtO)/;
  const GEN = /^(ogiZ0b|YhhmEf|MZZa6b)$/; // generate calls: forwarded to the desktop as events
  const BIG = /^(Zzl0ze|bOKtO)$/;
  const net = [];
  const obs = { id: crypto.randomUUID(), seq: 0, dropped: 0 };
  const push = (url, body, status, text) => {
    const m = RPCS.exec(url); if (!m) return;
    const rec = { t: Date.now(), rpc: m[1], status, res: String(text || '').slice(0, BIG.test(m[1]) ? 3_000_000 : 6000), seq: ++obs.seq };
    net.push(rec); if (net.length > 200) { net.shift(); obs.dropped++; }
  };
  const gen = (url) => { const m = RPCS.exec(url); return m && GEN.test(m[1]) ? m[1] : null; };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__tfUrl = String(u); return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    const url = this.__tfUrl || '';
    if (RPCS.test(url)) {
      const rpc = gen(url); const req = String(b || ''); const epoch = cur;
      if (rpc) emit('toolflow:event', { type: 'sent', epoch, request: req });
      nativeAdd.call(this, 'loadend', () => { try {
        push(url, b, this.status, this.responseText);
        if (rpc) emit('toolflow:event', { type: 'response', epoch, rpc, text: this.responseText, request: req });
      } catch (e) { /* observer must never break the page */ } });
    }
    return xs.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = String(input?.url || input);
    const r = await of.apply(this, arguments);
    if (RPCS.test(url)) r.clone().text().then((t) => push(url, '', r.status, t)).catch(() => {});
    return r;
  };
  nativeAdd.call(document, 'toolflow:net', () => emit('toolflow:net-result', net.splice(0, net.length)));
  // heartbeat: are our hooks still the ones the page calls?
  const ourSend = XMLHttpRequest.prototype.send, ourOpen = XMLHttpRequest.prototype.open, ourFetch = window.fetch;
  nativeAdd.call(document, 'toolflow:ping', () => {
    const meta = document.querySelector('meta[name="toolflow-version"]');
    emit('toolflow:ping-result', {
      xhrSend: XMLHttpRequest.prototype.send === ourSend, xhrOpen: XMLHttpRequest.prototype.open === ourOpen,
      fetch: window.fetch === ourFetch, ...obs, t: Date.now(), version: meta ? meta.content : '' });
  });
})();
