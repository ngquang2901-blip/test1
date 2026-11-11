import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseRpcResponse, parseGenerateRequest, parseImageReceipt, parseVideoReceipt } from '@toolflow/flow-protocol/parse';
import burst3 from '../../../../packages/flow-protocol/test/fixtures/image-1x1-burst3.json';
import videoT2v from '../../../../packages/flow-protocol/test/fixtures/video-t2v.json';
import throttledVideo from '../../../../packages/flow-protocol/test/fixtures/throttled-YhhmEf.json';
import throttledImage from '../../../../packages/flow-protocol/test/fixtures/throttled-ogiZ0b.json';
import project from '../../../../packages/flow-protocol/test/fixtures/project-Zzl0ze.json';
import { DEFAULT_COMBO, profile, type Combo } from './profile';
import type { ConnectorServer } from './connector/server';
import type { AssetStore } from './assets';
import { ConnectorError, type ClickResult, type DlInfo, type DriverEvent, type FlowDriver, type Ping } from './driver';

// Tests only: the profile qualifies the image combo alone, so video batches need a stand-in.
export const FAKE_COMBOS: Combo[] = [DEFAULT_COMBO, { kind: 'video', mode: 'Video', model: 'fake', aspect: '16:9', quality: 'High', count: 1 }];
export const fakeCombo = (kind: 'image' | 'video'): Combo => FAKE_COMBOS.find((c) => c.kind === kind)!;
// blocked: there is no live capture of a content block, so this is the throttle capture with its reason swapped for a content one
// (the product reads only the reasons list of a rejection). It stands in for "Flow refused this prompt", not for the real bytes.
export type FakeScript = Array<'image-ok' | 'video-ok' | 'throttled' | 'blocked' | 'no-request' | 'drop'>;
// Per fetchMedia call, in order; the default after the script runs out is a good PNG.
// html: the file is an error page · empty: 0 bytes · ack-lost: the transfer happens but the reply is lost · fail-once: this transfer is interrupted · slow: in progress for 2 polls
export type DownloadScript = 'download-ok' | 'download-html' | 'download-empty' | 'download-ack-lost' | 'download-fail-once' | 'download-slow';
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'); // a real 1x1 PNG, same bytes every time
type Rec = { phase: string; rpc: string; req?: string; res?: string };

// Real redacted captures; the fake only swaps the prompt text and keeps their structure.
// Static imports so the bundled main process carries the fixtures (R53).
const FIXTURES: Record<string, { records: Rec[] }> = { 'image-1x1-burst3': burst3, 'video-t2v': videoT2v, 'throttled-YhhmEf': throttledVideo, 'throttled-ogiZ0b': throttledImage, 'project-Zzl0ze': project } as never;
const fx = (name: string): Rec[] => FIXTURES[name].records;
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

// fail: codes returned (in order, one per call) by prepare / checkBeforeClick before they go back to ok.
export function createFakeDriver(input: FakeScript, fail: { prepare?: string[]; check?: string[]; assets?: AssetStore; downloads?: DownloadScript[]; downloadsDir?: string; tabs?: number; version?: string } = {}) {
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
  const ledger = { clicks: 0, prepares: 0, checks: 0, readProject: 0, arms: 0, fetches: 0, uploads: [] as string[], refs: [] as string[][], armLog: [] as Array<[string, number | null]> };
  const focusLog: string[] = [];
  const armed = new Map<string, number | undefined>(); // page tracker: pending (key present) + the epoch it would stamp (undefined = ambiguous)
  const gens = new Map<string, number>(); // generate sends the page made (ours or not), reported by ping
  const bump = (tab: string) => gens.set(tab, (gens.get(tab) ?? 0) + 1);
  const prompts = new Map<string, string>();
  const emit = (e: DriverEvent) => listeners.forEach((cb) => cb(e));
  const later = (...es: DriverEvent[]) => setTimeout(() => es.forEach(emit), 0);

  // sent + response of one real-fixture pair carrying the prompt prepared on the tab
  const pair = (tabId: string, step: 'image-ok' | 'video-ok' | 'throttled' | 'blocked', epoch: number): DriverEvent[] => {
    const to = prompts.get(tabId)!;
    let sent: Rec, done: Rec;
    if (step === 'throttled' || step === 'blocked') {
      const video = kinds.get(tabId) === 'video';
      ({ sent } = video ? next('throttledVideo') : next('throttledImage'));
      done = fx(video ? 'throttled-YhhmEf' : 'throttled-ogiZ0b')[0];
    } else ({ sent, done } = step === 'image-ok' ? next('image') : next('video'));
    const from = promptOf(sent);
    const oldBatch = parseGenerateRequest(fReqOf(sent)).batchId;
    const subs: Array<[string, string]> = [[from, to], [oldBatch, randomUUID()], ...(step === 'blocked' ? [['PUBLIC_ERROR_USER_REQUESTS_THROTTLED', 'PUBLIC_ERROR_UNSAFE_GENERATION'] as [string, string]] : [])];
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

  // fake browser downloads: real files in a ToolFlow-tmp folder, items shaped like the extension's `downloads` op
  const dlScript = [...(fail.downloads ?? [])];
  const dlItems: Array<DlInfo & { polls: number }> = [];
  let dlDir = fail.downloadsDir;
  const fetchMedia: FlowDriver['fetchMedia'] = async (_tab, p) => {
    ledger.fetches++;
    dlDir ??= join(mkdtempSync(join(tmpdir(), 'tf-fake-dl-')), 'ToolFlow-tmp');
    mkdirSync(dlDir, { recursive: true });
    const step = dlScript.shift() ?? 'download-ok';
    let name = p.filename, n = 1;
    while (dlItems.some((x) => x.filename === join(dlDir!, name))) name = p.filename.replace(/(\.[^.]*)?$/, ` (${n++})$1`); // uniquify, like the browser
    const filename = join(dlDir, name);
    const item: DlInfo & { polls: number } = { id: dlItems.length + 1, state: 'complete', filename, fileSize: 0, mime: '', error: null, polls: step === 'download-slow' ? 2 : 0 };
    const body = step === 'download-html' ? Buffer.from('<!doctype html><title>403</title>') : step === 'download-empty' ? Buffer.alloc(0) : TINY_PNG;
    if (step === 'download-fail-once') Object.assign(item, { state: 'interrupted', error: 'NETWORK_FAILED' });
    else { writeFileSync(filename, body); item.fileSize = body.length; item.mime = step === 'download-html' ? 'text/html' : 'image/png'; }
    dlItems.push(item);
    if (step === 'download-ack-lost') throw new ConnectorError('fake: ack lost');
    return { ok: true, downloadId: item.id };
  };
  const downloads: FlowDriver['downloads'] = async (q) => dlItems
    .filter((x) => (q.id !== undefined ? x.id === q.id : q.filenamePrefix !== undefined && basename(x.filename).startsWith(q.filenamePrefix)))
    .map(({ polls, ...x }) => {
      const it = dlItems.find((i) => i.id === x.id)!;
      if (q.id === undefined || polls <= 0) return x;
      it.polls--; // slow: still in progress for the first polls by id
      return { ...x, state: 'in_progress' as const, fileSize: -1 };
    });

  const driver: FlowDriver & { ledger: typeof ledger; focusLog: string[]; emit: typeof emit; userSends(tabId: string, kind: 'image' | 'video', deliver?: boolean): DriverEvent[] } = {
    ledger, emit, focusLog, fetchMedia, downloads,
    async ping(tabId): Promise<Ping> {
      return { xhrSend: true, xhrOpen: true, fetch: true, id: 'fake', seq: 0, dropped: 0, gen: gens.get(tabId) ?? 0, t: Date.now(), version: fail.version ?? '0.0.0-fake', email: 'fake@example.invalid' };
    },
    async probeTab() { return { present: { editor: true, submit: true }, listeners: 1, sawProjectLoad: true }; },
    async prepare(tabId, p) { ledger.prepares++; const code = fail.prepare?.shift(); if (code) return { ok: false, code };
      for (const id of p.refIds) { // like the real driver: an asset is uploaded once, then only attached
        if (fail.assets && !fail.assets.get(id)) return { ok: false, code: 'REF_ASSET_MISSING' };
        if (!ledger.uploads.includes(id)) ledger.uploads.push(id);
      }
      if (p.refIds.length) ledger.refs.push([...p.refIds]);
      prompts.set(tabId, p.prompt); kinds.set(tabId, p.kind); return { ok: true }; },
    async checkBeforeClick() { ledger.checks++; const code = fail.check?.shift(); return code ? { ok: false, code: code as 'COVERED' } : { ok: true }; },
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
    async listTabs() { // tab tN shows its own project and account (e2e of several tabs)
      return Array.from({ length: fail.tabs ?? 1 }, (_, i) => ({ tabId: `t${i + 1}`, projectId: i ? `${i}b4d3c1e-1111-4222-8333-44445555666${i + 6}` : '0b4d3c1e-1111-4222-8333-444455556666', email: i ? `fake${i + 1}@example.invalid` : 'fake@example.invalid', active: i === 0 }));
    },
    async focusTab(tabId) { focusLog.push(tabId); },
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

// ---- fake Flow page behind the connector: media library + composer chips (for ext-driver tests) ----
export type UploadScript = 'ok' | 'upload-no-ack' | 'upload-late-ack'
type FakeFlowOptions = {
  lateAfter?: number // 'upload-late-ack': attach polls that answer NOT_FOUND before the item shows
  stuckChips?: boolean // the clear button does nothing
  strayOnPrep?: boolean // typing the prompt drops an unrelated chip in
  onFile?: (name: string) => void
  tabPath?: string | null // the granted tab's path (default: the fake project); null = the tab is gone
}
export const FAKE_FLOW_PROJECT = 'cb7b8a3e-0000-4000-8000-000000000001'
/** Models what the live page showed: op `file` how=drop only uploads (library, no chip); `attach` opens the library by name and adds one chip. 'upload-no-ack' counts the upload but attach never finds it. */
export function createFakeFlow(input: UploadScript[] = [], o: FakeFlowOptions = {}) {
  const script = [...input]
  const library: Array<{ name: string; uuid: string; wait: number }> = []
  let chips: string[] = [], text = ''
  const f = {
    uploads: [] as string[], hows: [] as string[], attaches: 0, ops: [] as string[],
    chips: () => [...chips], setChips: (c: string[]) => { chips = [...c] }, dropChips: () => { chips = [] }, setText: (t: string) => { text = t },
    uploadsOf: (assetId: string) => f.uploads.filter((n) => n.startsWith(`tf-${assetId.slice(0, 8)}-`)).length,
    addToLibrary: (name: string, wait = 0) => { const uuid = randomUUID(); library.push({ name, uuid, wait }); return uuid },
    libraryMedia: (name: string) => library.find((l) => l.name === name)?.uuid,
    server: {
      async send(op: string, args: Record<string, unknown>): Promise<unknown> {
        f.ops.push(op)
        switch (op) {
          case 'tabs': return o.tabPath === null ? [] : [{ tabId: Number(args.tabId ?? 7), path: o.tabPath ?? `/fx/tools/flow/project/${FAKE_FLOW_PROJECT}`, active: true }]
          case 'settings': return { ok: true, current: {}, mismatches: [] }
          case 'state': return { text, chips: [...chips], submitDisabled: false, creditWarning: false }
          case 'prep': text = args.prompt as string; if (o.strayOnPrep) chips.push(randomUUID()); return { ok: true, textMatches: true, log: [] }
          case 'click': if (args.sel === profile.selectors.clear) { if (!o.stuckChips) chips = []; text = ''; return 'clicked' } return 'NOTFOUND'
          case 'file': {
            f.uploads.push(args.name as string); f.hows.push(args.how as string); o.onFile?.(args.name as string)
            const step = script.shift() ?? 'ok'
            if (step !== 'upload-no-ack') f.addToLibrary(args.name as string, step === 'upload-late-ack' ? o.lateAfter ?? 2 : 0)
            return { chips: chips.length }
          }
          case 'attach': {
            f.attaches++
            const hits = library.filter((l) => l.name.startsWith((args.name as string).slice(0, 20)))
            if (hits.length > 1) return { ok: false, code: 'AMBIGUOUS' }
            if (!hits.length || hits[0].wait-- > 0) return { ok: false, code: 'NOT_FOUND' }
            if (chips.includes(hits[0].uuid)) return { ok: false, code: 'NO_CHIP' }
            chips.push(hits[0].uuid)
            return { ok: true, chips: [...chips], added: hits[0].uuid }
          }
          default: throw new Error(`fake flow: op ${op}`)
        }
      },
      onEvent: () => () => {},
    },
  }
  return f as typeof f & { server: ConnectorServer }
}
