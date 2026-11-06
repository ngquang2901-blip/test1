// THROWAWAY spike (D-12): MAIN world, document_start. Records click listeners Flow attaches to buttons,
// then on request calls them with a Proxy event reporting isTrusted:true. Does not touch reCAPTCHA.
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
  nativeAdd.call(document, 'toolflow:submit', () => {
    const b = document.querySelector('flow-prompt-box button[type="submit"]');
    const ls = b && reg.get(b);
    const out = { found: !!b, disabled: b?.disabled ?? null, listeners: ls ? ls.size : 0, called: 0, errors: [], t: Date.now() };
    if (b && ls && !b.disabled) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: window, detail: 1, button: 0 });
      const p = new Proxy(ev, {
        get(t, k) {
          if (k === 'isTrusted') return true;
          if (k === 'target' || k === 'currentTarget' || k === 'srcElement') return b;
          const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      for (const l of ls) { try { typeof l === 'function' ? l.call(b, p) : l.handleEvent(p); out.called++; } catch (e) { out.errors.push(String(e)); } }
    }
    document.documentElement.setAttribute('data-tf-submit-result', JSON.stringify(out));
  });

  // Read-only network observer: keep generation/poll/upload batchexecute exchanges for correlation.
  const RPCS = /rpcids=(ogiZ0b|YhhmEf|eb1hJf|nprQif|MZZa6b|maseQ|jwpduf|as29s|Zzl0ze|nzlxg|bOKtO)/;
  const BIG = /^(Zzl0ze|bOKtO)$/; // project/media listings for reconciliation: keep the whole body
  const net = [];
  const obs = { id: crypto.randomUUID(), seq: 0, dropped: 0 }; // id changes on page load: buffered records are gone
  const push = (url, body, status, text, phase = 'done') => {
    const m = RPCS.exec(url); if (!m) return;
    // recaptcha tokens / base64 uploads are long: keep head only
    const rec = { t: Date.now(), phase, rpc: m[1], status, req: decodeURIComponent(String(body || '')).replace(/[A-Za-z0-9_\-]{400,}/g, '<long>').slice(0, 3000), res: String(text || '').slice(0, BIG.test(m[1]) ? 3_000_000 : 6000) };
    if (phase === 'sent') rec.raw = String(body || '').slice(0, 400000); // as sent on the wire; redact when saving
    rec.seq = ++obs.seq; net.push(rec);
    if (net.length > 200) { net.shift(); obs.dropped++; }
  };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  const urls = []; const seen = (u) => { urls.push(String(u).replace(/\?.*?(rpcids=[^&]+).*/, '?$1').slice(0, 140)); if (urls.length > 20) urls.shift(); };
  XMLHttpRequest.prototype.open = function (m, u) { this.__tfUrl = String(u); seen(u); return xo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    if (RPCS.test(this.__tfUrl || '')) {
      push(this.__tfUrl, b, 0, '', 'sent');
      nativeAdd.call(this, 'loadend', () => { try { push(this.__tfUrl, b, this.status, this.responseText); } catch (e) {} });
    }
    return xs.apply(this, arguments);
  };
  const of = window.fetch;
  window.fetch = async function (input, init) {
    const url = String(input?.url || input); seen(url);
    let body = init?.body;
    if (RPCS.test(url)) { if (body == null && input instanceof Request) body = await input.clone().text().catch(() => ''); push(url, body, 0, '', 'sent'); }
    const r = await of.apply(this, arguments);
    if (RPCS.test(url)) r.clone().text().then((t) => push(url, body, r.status, t)).catch(() => {});
    return r;
  };
  nativeAdd.call(document, 'toolflow:net', () => {
    document.documentElement.setAttribute('data-tf-net', JSON.stringify(net.splice(0, net.length)));
  });
  // heartbeat: are our hooks still the ones the page calls? (another extension may re-patch after us)
  const ourSend = XMLHttpRequest.prototype.send, ourOpen = XMLHttpRequest.prototype.open, ourFetch = window.fetch;
  nativeAdd.call(document, 'toolflow:ping', () => {
    document.documentElement.setAttribute('data-tf-ping', JSON.stringify({
      xhrSend: XMLHttpRequest.prototype.send === ourSend, xhrOpen: XMLHttpRequest.prototype.open === ourOpen,
      fetch: window.fetch === ourFetch, buffered: net.length, ...obs, urls, t: Date.now() }));
  });
})();
