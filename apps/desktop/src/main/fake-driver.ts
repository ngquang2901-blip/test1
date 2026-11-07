import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRpcResponse, parseGenerateRequest } from '@toolflow/flow-protocol/parse';
import { ConnectorError, type ClickResult, type DriverEvent, type FlowDriver, type Ping } from './driver';

export type FakeScript = Array<'image-ok' | 'video-ok' | 'throttled' | 'no-request' | 'drop'>;
type Rec = { phase: string; rpc: string; req?: string; res?: string };

// Real redacted captures; the fake only swaps the prompt text and keeps their structure.
const fx = (name: string): Rec[] =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../packages/flow-protocol/test/fixtures/${name}.json`, import.meta.url)), 'utf8')).records;
const fReqOf = (r: Rec) => r.req!.slice('f.req='.length, r.req!.indexOf('&at='));
const promptOf = (r: Rec) => parseGenerateRequest(fReqOf(r)).items[0].prompt as string;
const payloadOf = (r: Rec) => (parseRpcResponse(r.res!, r.rpc) as { payload: unknown }).payload;

// The prompt sits in JSON-in-string at unknown depth: walk the tree, re-parsing string leaves that are themselves JSON.
// Envelope chunk-length lines go stale after a swap; parseEnvelope ignores them.
function swap(text: string, from: string, to: string): string {
  const walk = (v: unknown): unknown => {
    if (v === from) return to;
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'string' && v.startsWith('[')) {
      try { return JSON.stringify(walk(JSON.parse(v))); } catch { return v; }
    }
    return v;
  };
  return text.split('\n').map((l) => (l.startsWith('[') ? JSON.stringify(walk(JSON.parse(l))) : l)).join('\n');
}

function pick(kind: 'image' | 'video' | 'throttled') {
  if (kind === 'throttled') return { sent: fx('image-1x1-burst3').find((r) => r.phase === 'sent')!, done: fx('throttled-ogiZ0b')[0] };
  const recs = fx(kind === 'image' ? 'image-1x1-burst3' : 'video-t2v');
  const sent = recs.find((r) => r.phase === 'sent')!;
  const batchId = parseGenerateRequest(fReqOf(sent)).batchId;
  const done = recs.filter((r) => r.phase === 'done').find((r) => {
    try { return JSON.stringify(payloadOf(r)).includes(batchId); } catch { return false; }
  })!;
  return { sent, done };
}

export function createFakeDriver(script: FakeScript) {
  const listeners = new Set<(e: DriverEvent) => void>();
  const ledger = { clicks: 0, prepares: 0, readProject: 0 };
  const prompts = new Map<string, string>();
  const emit = (e: DriverEvent) => listeners.forEach((cb) => cb(e));
  const later = (...es: DriverEvent[]) => setTimeout(() => es.forEach(emit), 0);

  const driver: FlowDriver & { ledger: typeof ledger; emit: typeof emit } = {
    ledger, emit,
    async ping(): Promise<Ping> {
      return { xhrSend: true, xhrOpen: true, fetch: true, id: 'fake', seq: 0, dropped: 0, t: Date.now(), version: '0.0.0-fake', email: 'fake@example.invalid' };
    },
    async prepare(tabId, p) { ledger.prepares++; prompts.set(tabId, p.prompt); return { ok: true }; },
    async checkBeforeClick() { return { ok: true }; },
    async click(tabId): Promise<ClickResult> {
      ledger.clicks++;
      const step = script.shift();
      if (!step) throw new Error('fake driver: script exhausted');
      if (step === 'drop') { later({ tabId, type: 'disconnected' }); throw new ConnectorError('fake drop'); }
      if (step !== 'no-request') {
        const { sent, done } = pick(step === 'image-ok' ? 'image' : step === 'video-ok' ? 'video' : 'throttled');
        const to = prompts.get(tabId) ?? promptOf(sent);
        const from = promptOf(sent);
        const body = new URLSearchParams({ 'f.req': swap(fReqOf(sent), from, to) }).toString() + '&at=<redacted>';
        later({ tabId, type: 'sent', request: body }, { tabId, type: 'response', rpc: done.rpc, text: swap(done.res!, from, to) });
      }
      return { found: true, disabled: false, listeners: 1, called: 1 };
    },
    async readProject() {
      ledger.readProject++;
      return fx('project-Zzl0ze').find((r) => r.phase === 'done')!.res!;
    },
    async focusTab() {},
    onEvent(cb) { listeners.add(cb); return () => listeners.delete(cb); },
  };
  return driver;
}
