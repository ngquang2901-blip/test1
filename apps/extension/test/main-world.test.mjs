import test, { after } from 'node:test';
import assert from 'node:assert/strict';

// The page's world, as little of it as main-world.js touches.
class XHR { open() { this.opened = true; } send() { if (!this.opened) throw new Error('InvalidStateError'); XHR.sent++; } }
XHR.sent = 0;
const doc = new EventTarget(); doc.querySelector = () => null;
const win = new EventTarget(); win.fetch = async () => new Response(''); win.postMessage = (data, origin, ports) => win.dispatchEvent(Object.assign(new Event('message'), { source: win, data, ports }));
Object.assign(globalThis, { window: win, document: doc, XMLHttpRequest: XHR, HTMLButtonElement: class {}, fetch: async () => new Response('') });
await import('../epoch.js'); await import('../media-logic.js'); await import('../main-world.js');
const ch = new MessageChannel(); let answer; ch.port1.onmessage = (e) => answer?.(e.data.detail);
win.postMessage('toolflow:port', 'https://flow.google.com', [ch.port2]);
const ping = () => new Promise((res) => { answer = res; ch.port1.postMessage({ name: 'toolflow:ping', id: 1 }); });
after(() => { ch.port1.close(); ch.port2.close(); });

test('heartbeat: our hooks count as in place while the page still reaches them, also through a wrapper the page put on top (seen: Flow redefines send and calls the one before); a replacement that leaves ours out is a loss; the test sends nothing', async () => {
  assert.deepEqual([(await ping()).xhrSend, (await ping()).xhrOpen], [true, true]);
  const ours = XHR.prototype.send;
  Object.defineProperty(XHR.prototype, 'send', { configurable: true, writable: true, value: function () { return ours.apply(this, arguments); } }); // what Flow's bundle does
  assert.equal((await ping()).xhrSend, true);
  const x = new XHR(); x.open('POST', 'https://x.example/'); x.send('b'); // a real request still goes through
  assert.equal(XHR.sent, 1);
  XHR.prototype.send = function () { /* somebody else's, ours left out */ };
  assert.equal((await ping()).xhrSend, false);
  XHR.prototype.open = function () { /* likewise */ };
  assert.equal((await ping()).xhrOpen, false);
  assert.equal(XHR.sent, 1); // no ping ever sent anything
});
