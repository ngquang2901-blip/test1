import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseRpcResponse, parseGenerateRequest, parseImageReceipt, parseVideoReceipt } from '@toolflow/flow-protocol/parse';
import { ConnectorError, type ClickResult, type DriverEvent, type FlowDriver, type Ping } from './driver';

export type FakeScript = Array<'image-ok' | 'video-ok' | 'throttled' | 'no-request' | 'drop'>;
type Rec = { phase: string; rpc: string; req?: string; res?: string };

// Real redacted captures; the fake only swaps the prompt text and keeps their structure.
const fx = (name: string): Rec[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../packages/flow-protocol/test/fixtures/${name}.json`, import.meta.url)), 'utf8')).records;
const fReqOf = (r: Rec) => r.req!.slice('f.req='.length, r.req!.indexOf('&at='));
const promptOf = (r: Rec) => parseGenerateRequest(fReqOf(r)).items[0].prompt as string;
const payloadOf = (r: Rec) => (parseRpcResponse(r.res!, r.rpc) as { payload: unknown }).payload;

// Prompt and batchId sit in JSON-in-string at unknown depth: walk the tree, re-parsing string leaves that are themselves JSON.
// Envelope chunk-length lines go stale after a swap; parseEnvelope ignores them.
function swap(text: string, subs: Array<[string, string]>): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'string') return v;
    if (v.startsWith('[')) {
      try { return JSON.stringify(walk(JSON.parse(v))); } catch { /* plain string */ }
    }
    return subs.reduce((acc, [from, to]) => acc.replaceAll(from, to), v);
  };
  return text.split('\n').map((l) => (l.startsWith('[') ? JSON.stringify(walk(JSON.parse(l))) : l)).join('\n');
}

// All (sent, done) pairs of a fixture, matched by batchId; `ok` drops pairs the real parser rejects.
function pairs(name: string, ok: (payload: unknown) => unknown = () => 0): Array<{ sent: Rec; done: Rec }> {
  const recs = fx(name);
  const dones = recs.filter((r) => r.phase === 'done');
  return recs.filter((r) => r.phase === 'sent').map((sent) => {
    const batchId = parseGenerateRequest(fReqOf(sent)).batchId;
    const done = dones.find((r) => {
      try { return JSON.stringify(payloadOf(r)).includes(batchId); } catch { return false; }
    })!;
    ok(payloadOf(done));
    return { sent, done };
  });
}

export function createFakeDriver(input: FakeScript) {
  const script = [...input];
  // shortcut: server media ids repeat across clicks, when a test needs distinct media ids substitute them too
  const pools = {
    image: [...pairs('image-1x1-burst3', parseImageReceipt)],
    video: [...pairs('video-t2v', parseVideoReceipt)],
    throttledImage: pairs('image-1x1-burst3'),
    throttledVideo: pairs('video-t2v'),
  };
  const used = { image: 0, video: 0, throttledImage: 0, throttledVideo: 0 };
  const kinds = new Map<string, 'image' | 'video'>();
  const next = (k: keyof typeof pools) => pools[k][used[k]++ % pools[k].length];
  const listeners = new Set<(e: DriverEvent) => void>();
  const ledger = { clicks: 0, prepares: 0, readProject: 0, arms: 0, armLog: [] as Array<[string, number | null]> };
  const armed = new Map<string, number | undefined>(); // page tracker: pending (key present) + the epoch it would stamp (undefined = ambiguous)
  const gens = new Map<string, number>(); // generate sends the page made (ours or not), reported by ping
  const bump = (tab: string) => gens.set(tab, (gens.get(tab) ?? 0) + 1);
  const prompts = new Map<string, string>();
  const emit = (e: DriverEvent) => listeners.forEach((cb) => cb(e));
  const later = (...es: DriverEvent[]) => setTimeout(() => es.forEach(emit), 0);

  // sent + response of one real-fixture pair carrying the prompt prepared on the tab
  const pair = (tabId: string, step: 'image-ok' | 'video-ok' | 'throttled', epoch: number): DriverEvent[] => {
    const to = prompts.get(tabId)!;
    let sent: Rec, done: Rec;
    if (step === 'throttled') {
      const video = kinds.get(tabId) === 'video';
      ({ sent } = video ? next('throttledVideo') : next('throttledImage'));
      done = fx(video ? 'throttled-YhhmEf' : 'throttled-ogiZ0b')[0];
    } else ({ sent, done } = step === 'image-ok' ? next('image') : next('video'));
    const from = promptOf(sent);
    const oldBatch = parseGenerateRequest(fReqOf(sent)).batchId;
    const subs: Array<[string, string]> = [[from, to], [oldBatch, randomUUID()]];
    const body = new URLSearchParams({ 'f.req': swap(fReqOf(sent), subs) }).toString() + '&at=<redacted>';
    const text = swap(done.res!, subs);
    // A silent swap miss would leak fixture identity into tests.
    for (const old of [oldBatch, from]) {
      for (const needle of [old, JSON.stringify(old).slice(1, -1)]) {
        if (decodeURIComponent(body.replace(/\+/g, ' ')).includes(needle) || text.includes(needle)) throw new Error(`fake: fixture value survived substitution: ${old}`);
      }
    }
    return [{ tabId, type: 'sent', epoch, request: body }, { tabId, type: 'response', epoch, rpc: done.rpc, text, request: body }];
  };

  const driver: FlowDriver & { ledger: typeof ledger; emit: typeof emit; userSends(tabId: string, kind: 'image' | 'video', deliver?: boolean): DriverEvent[] } = {
    ledger, emit,
    async ping(tabId): Promise<Ping> {
      return { xhrSend: true, xhrOpen: true, fetch: true, id: 'fake', seq: 0, dropped: 0, gen: gens.get(tabId) ?? 0, t: Date.now(), version: '0.0.0-fake', email: 'fake@example.invalid' };
    },
    async prepare(tabId, p) { ledger.prepares++; prompts.set(tabId, p.prompt); kinds.set(tabId, p.kind); return { ok: true }; },
    async checkBeforeClick() { return { ok: true }; },
    async click(tabId, epoch): Promise<ClickResult> {
      ledger.clicks++;
      const step = script.shift();
      if (!step) throw new Error('fake driver: script exhausted');
      if (step === 'drop') { later({ tabId, type: 'disconnected' }); throw new ConnectorError('fake drop'); }
      const prepared = kinds.get(tabId);
      const to = prompts.get(tabId);
      if (to === undefined || !prepared) throw new Error('fake: click before prepare');
      const want = step.endsWith('-ok') ? step.slice(0, 5) : undefined;
      if (want && want !== prepared) throw new Error(`fake: script kind ${want} does not match prepared kind ${prepared}`);
      if (step !== 'no-request') { bump(tabId); later(...pair(tabId, step, epoch)); }
      return { found: true, disabled: false, listeners: 1, called: 1 };
    },
    async readProject() {
      ledger.readProject++;
      return fx('project-Zzl0ze').find((r) => r.phase === 'done')!.res!;
    },
    async focusTab() {},
    async arm(tabId, epoch) { ledger.arms++; ledger.armLog.push([tabId, epoch]); if (epoch === null) armed.delete(tabId); else armed.set(tabId, armed.has(tabId) ? undefined : epoch); }, // arming while pending is ambiguous
    // The user clicks Gửi in Flow: the page stamps the ARMED epoch (undefined when not armed) and the tracker is spent.
    userSends(tabId, kind, deliver = true) {
      if (!prompts.has(tabId)) throw new Error('fake: userSends before prepare');
      const epoch = armed.get(tabId) as number; armed.delete(tabId); bump(tabId);
      const es = pair(tabId, kind === 'image' ? 'image-ok' : 'video-ok', epoch);
      if (deliver) later(...es);
      return es;
    },
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return driver;
}
