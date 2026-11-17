import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

// sw.js against stand-ins: `app.up` says whether ToolFlow listens on 127.0.0.1; the clock is mocked, the 30 s alarm never fires by itself.
let loads = 0;
async function load(app) {
  const made = []; // [time made, socket]
  globalThis.chrome = {
    storage: { local: { get: async () => ({ tfInstance: '0123abcd' }), set: async () => {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    tabs: { onUpdated: { addListener() {} } },
    runtime: { onStartup: { addListener() {} }, onMessage: { addListener() {} }, getURL: (p) => p },
  };
  globalThis.fetch = async () => ({ json: async () => ({ port: 1, token: 'x' }) });
  globalThis.WebSocket = class {
    constructor(url, protos) {
      this.readyState = 0; this.sent = []; this.protos = protos; made.push([Date.now(), this]);
      const nonce = protos.find((p) => p.startsWith('tfn.')).slice(4); // the app's side of the handshake: hello = hmac(token, 's' + nonce)
      const hello = app.hello ?? createHmac('sha256', 'x').update('s' + nonce).digest('hex');
      queueMicrotask(() => { if (app.up) { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ hello }) }); } else this.close(); });
    }
    send(d) { this.sent.push(d); }
    close(code) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  };
  await import(new URL(`../sw.js?load=${++loads}`, import.meta.url));
  return made;
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const open = (made) => made.some(([, s]) => s.readyState === 1);
async function advance(t, ms) { for (let k = 0; k < ms; k += 100) { t.mock.timers.tick(100); await settle(); } }

test('the app restarts: the extension finds it again about a second after it is back, not at the next 30 s alarm', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const app = { up: true };
  const made = await load(app);
  await settle();
  assert.equal(open(made), true);
  app.up = false; made.at(-1)[1].close(); // the app quits
  await advance(t, 2500); // …and is back 2.5 s later
  app.up = true;
  const back = Date.now();
  let found = null;
  for (let k = 0; k < 300 && found === null; k++) { await advance(t, 100); if (open(made)) found = Date.now() - back; }
  assert.ok(found !== null && found <= 2000, `reconnected ${found} ms after the app came back`);
});

test('while the app is away the extension retries after 1 s, doubling to 30 s at most; once connected the next loss starts at 1 s again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const app = { up: false };
  const made = await load(app);
  await settle();
  await advance(t, 130_000);
  const gaps = made.slice(1).map(([at], i) => Math.round((at - made[i][0]) / 1000));
  assert.deepEqual(gaps.slice(0, 7), [1, 2, 4, 8, 16, 30, 30]);
  app.up = true;
  await advance(t, 31_000);
  assert.equal(open(made), true);
  const n = made.length;
  app.up = false; made.at(-1)[1].close();
  await advance(t, 1000);
  assert.equal(made.length, n + 1, 'first retry 1 s after the loss');
});

test('a 4401 close (wrong token) retries every 30 s, not every second', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const app = { up: true };
  const made = await load(app);
  await settle();
  const n = made.length;
  made.at(-1)[1].close(4401);
  await advance(t, 29_000);
  assert.equal(made.length, n, 'nothing before 30 s');
  await advance(t, 2000);
  assert.equal(made.length, n + 1);
});

test('handshake: the token is never offered, only a proof; ops are heard after a right hello and never after a wrong one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const good = await load({ up: true }); await settle();
  const s = good.at(-1)[1];
  assert.ok(!s.protos.some((p) => p.startsWith('tf.')));
  assert.equal(s.protos.find((p) => p.startsWith('tfp.')).length, 4 + 64);
  s.onmessage({ data: JSON.stringify({ id: 5, op: 'nope' }) });
  await settle();
  assert.match(s.sent.at(-1), /"id":5/, 'an op after a right hello is answered');
  const bad = await load({ up: true, hello: 'f'.repeat(64) }); await settle();
  const b = bad.at(-1)[1];
  assert.equal(b.readyState, 3, 'wrong hello: closed');
  b.onmessage({ data: JSON.stringify({ id: 6, op: 'nope' }) });
  await settle();
  assert.equal(b.sent.length, 0, 'nothing answered, nothing sent to a listener that failed the proof');
});
