import test from 'node:test';
import assert from 'node:assert/strict';

// The page's world, as little of it as main-world.js touches.
class XHR { open() { this.opened = true; } send() { if (!this.opened) throw new Error('InvalidStateError'); XHR.sent++; } }
XHR.sent = 0;
const doc = new EventTarget(); doc.querySelector = () => null;
Object.assign(globalThis, { window: globalThis, document: doc, XMLHttpRequest: XHR, HTMLButtonElement: class {}, fetch: async () => new Response('') });
await import('../epoch.js'); await import('../media-logic.js'); await import('../main-world.js');
const ping = () => { let r; const on = (e) => { r = JSON.parse(e.detail); }; doc.addEventListener('toolflow:ping-result', on); doc.dispatchEvent(new CustomEvent('toolflow:ping')); doc.removeEventListener('toolflow:ping-result', on); return r; };

test('heartbeat: our hooks count as in place while the page still reaches them, also through a wrapper the page put on top (seen: Flow redefines send and calls the one before); a replacement that leaves ours out is a loss; the test sends nothing', () => {
  assert.deepEqual([ping().xhrSend, ping().xhrOpen], [true, true]);
  const ours = XHR.prototype.send;
  Object.defineProperty(XHR.prototype, 'send', { configurable: true, writable: true, value: function () { return ours.apply(this, arguments); } }); // what Flow's bundle does
  assert.equal(ping().xhrSend, true);
  const x = new XHR(); x.open('POST', 'https://x.example/'); x.send('b'); // a real request still goes through
  assert.equal(XHR.sent, 1);
  XHR.prototype.send = function () { /* somebody else's, ours left out */ };
  assert.equal(ping().xhrSend, false);
  XHR.prototype.open = function () { /* likewise */ };
  assert.equal(ping().xhrOpen, false);
  assert.equal(XHR.sent, 1); // no ping ever sent anything
});
