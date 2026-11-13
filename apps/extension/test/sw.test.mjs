import test from 'node:test';
import assert from 'node:assert/strict';

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
    constructor() {
      this.readyState = 0; made.push([Date.now(), this]);
      queueMicrotask(() => { if (app.up) { this.readyState = 1; this.onopen?.(); } else this.close(); });
    }
    send() {}
    close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
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
