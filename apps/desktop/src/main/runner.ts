import { canClick, type AttemptEvent, type AttemptState, type ItemState } from '@toolflow/flow-protocol/attempt';
import { classifyGenerateError } from '@toolflow/flow-protocol/errors';
import { parseGenerateRequest, parseImageReceipt, parseRpcResponse, parseVideoReceipt, readFReq } from '@toolflow/flow-protocol/parse';
import type { Db } from './db';
import type { DriverEvent, FlowDriver } from './driver';
import { applyEvent } from './journal';
import { CAPS, nextCap } from './caps';

type Kind = 'image' | 'video';
export type BatchStatus = 'queued' | 'running' | 'paused' | 'needs_review' | 'completed' | 'partial_failed' | 'failed' | 'stopped';
export type Runner = {
  tick(): Promise<void>;
  rerun(attemptId: string, confirmedCost: true): string;
  start(batchId: string): void; pause(batchId: string): void; resume(batchId: string): void; stop(batchId: string): void;
  confirm(attemptId: string, to: 'sent' | 'not_sent'): void; archive(batchId: string): void; recover(): void;
  inFlight(): { image: number; video: number };
  lastError(batchId: string): string | null;
  caps(): { image: number; video: number };
};
type Info = { batch: string; project: string; kind: Kind; settings: string; prompt: string; refs: string };

/** 02 §5, seven ordered steps. Downloads are not part of P1. */
export function batchStatus(db: Db, id: string): BatchStatus {
  const b = db.prepare('select status, stop_requested s from batch where id=?').get(id) as { status: string; s: number };
  const items = (db.prepare('select a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=?').all(id) as { j: string }[])
    .map((r) => (JSON.parse(r.j) as AttemptState).item);
  const has = (...k: ItemState[]) => items.some((i) => k.includes(i));
  const live = b.status === 'paused' ? 'paused' : 'running';
  if (has('needs_review')) return 'needs_review';
  if (has('submitting', 'awaiting_user', 'generating')) return live;
  if (b.s) return 'stopped';
  if (has('queued', 'preparing')) return b.status === 'queued' ? 'queued' : live;
  if (items.every((i) => i === 'ready')) return 'completed';
  return has('ready') ? 'partial_failed' : 'failed';
}

export function createRunner(o: {
  db: Db; driver: FlowDriver; clock: { now(): number }; tabs: string[]; speed: 'default' | 'fast'; autoAllowed(email: string | null): boolean;
}): Runner {
  const { db, driver, clock } = o;
  const max = CAPS[o.speed];
  const tabs = o.tabs.slice(0, max.tabs);
  const caps: Record<Kind, number> = { image: max.image, video: max.video };
  const queue: DriverEvent[] = [];
  driver.onEvent((e) => queue.push(e));
  const slot = new Map<string, string>(); // tab → attempt last given a click there
  const awaiting: { id: string; tab: string }[] = []; // sent, response not seen yet
  const paused = new Map<string, string | null>(); // authoritative even when the DB write failed; flushed each tick

  const state = (id: string) => JSON.parse((db.prepare('select state_json j from attempt where id=?').get(id) as { j: string }).j) as AttemptState;
  const info = (id: string) => db.prepare(
    `select b.id batch, b.target_project project, b.kind, b.settings_json settings, i.prompt, i.refs_json refs
     from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id where a.id=?`).get(id) as Info;
  const attempts = (batch: string) => db.prepare('select a.id, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batch) as { id: string; j: string }[];

  const flush = () => {
    for (const b of paused.keys()) {
      try { db.prepare("update batch set status='paused', revision=revision+1 where id=? and status='running'").run(b); } catch { /* retried next tick */ }
    }
  };
  const pause = (b: string, reason: string | null = null) => { paused.set(b, reason); flush(); };
  const fail = (b: string, e: unknown) => {
    const code = (e as { code?: string }).code ?? '';
    const reason = ['ILLEGAL_TRANSITION', 'CONNECTOR_LOST', 'PROTOCOL_DRIFT'].includes(code) ? code // ProtocolDrift carries code, its name is plain Error
      : code.startsWith('SQLITE_') ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR';
    if (reason === 'ILLEGAL_TRANSITION' || reason === 'INTERNAL_ERROR') console.error(`runner: ${reason}`, e);
    pause(b, reason);
  };

  /** The only caller of applyEvent: also blocks the project on needs_review and pauses on any pause-level admission. */
  const apply = (id: string, ev: AttemptEvent): AttemptState => {
    const prev = state(id);
    const s = applyEvent(db, id, ev, clock.now());
    const i = info(id);
    if (s.item === 'needs_review') db.prepare('insert or ignore into target_block(project_id, attempt_id, since) values(?,?,?)').run(i.project, id, clock.now());
    // only a change pauses: a sticky admission must not re-pause after resume
    const changed = s.admission !== prev.admission || (s.item === 'needs_review' && prev.item !== 'needs_review');
    if (changed && s.admission !== 'continue' && s.admission !== 'throttle') pause(i.batch, s.error?.code ?? s.admission);
    return s;
  };

  const inFlight = () => {
    const n = { image: 0, video: 0 };
    const rows = db.prepare('select b.kind, a.state_json j from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id where b.archived=0').all() as { kind: Kind; j: string }[];
    for (const r of rows) if (['submitting', 'awaiting_user', 'generating'].includes((JSON.parse(r.j) as AttemptState).item)) n[r.kind]++;
    return n;
  };

  // Image: a tab is free once the previous request left the page (request set); video: once the receipt arrived (no longer submitting).
  const busy = (tab: string) => {
    const id = slot.get(tab);
    if (!id) return false;
    const s = state(id);
    return (s.item === 'submitting' || s.item === 'awaiting_user') && (info(id).kind === 'video' || !s.request);
  };

  function onEvent(e: DriverEvent) {
    if (e.type === 'disconnected') { // observation lost: whatever is awaiting a response can no longer be proven either way
      const ids = new Set([slot.get(e.tabId), ...awaiting.filter((a) => a.tab === e.tabId).map((a) => a.id)]);
      for (const id of ids) if (id && state(id).item === 'submitting') apply(id, { type: 'deadline' });
      return;
    }
    if (e.type === 'sent') {
      const id = slot.get(e.tabId);
      if (!id || state(id).item === 'needs_review') return; // already uncertain: nothing legal to record
      let request;
      try { request = parseGenerateRequest(readFReq(e.request as string)); } catch (err) { // R11: journal the parsed request, never the raw body
        if (state(id).item === 'submitting') apply(id, { type: 'deadline' }); // unprovable: uncertain + project blocked
        throw err; // run() pauses the batch with PROTOCOL_DRIFT
      }
      if (apply(id, { type: 'sent', request }).request) awaiting.push({ id, tab: e.tabId });
      return;
    }
    // A response belongs to the awaiting attempt with the same rpc and batchId, on any tab; anything else never feeds an attempt.
    const req = (id: string) => state(id).request as unknown as { rpc: string; batchId: string } | null;
    const same = awaiting.filter((a) => req(a.id)?.rpc === e.rpc);
    if (!same.length) return; // not a generate response (07 §3: polls etc. never resubmit)
    let batchId: string | undefined;
    try { batchId = parseGenerateRequest(readFReq(e.request as string)).batchId; } catch { /* unmatched below */ }
    const hit = same.find((a) => req(a.id)?.batchId === batchId);
    if (!hit) { for (const b of new Set(same.map((a) => info(a.id).batch))) pause(b, 'ATTRIBUTION_AMBIGUOUS'); return; }
    const r = parseRpcResponse(e.text, e.rpc) as { error?: { grpc: number; reasons: string[] }; payload?: unknown };
    let ev: AttemptEvent;
    if (r.error) ev = { type: 'rejected', error: r.error, now: clock.now() };
    else ev = { type: 'receipt', receipt: e.rpc === 'ogiZ0b' ? parseImageReceipt(r.payload) : parseVideoReceipt(r.payload) };
    awaiting.splice(awaiting.indexOf(hit), 1);
    const kind = info(hit.id).kind;
    const s = apply(hit.id, ev);
    if (ev.type === 'rejected' && classifyGenerateError(ev.error).admission === 'throttle') caps[kind] = nextCap(caps[kind], 'throttled', max[kind]);
    else if (ev.type === 'receipt' && (s.item === 'ready' || s.item === 'generating')) caps[kind] = nextCap(caps[kind], 'ok', max[kind]);
  }

  async function dispatch(tab: string, id: string, i: Info, s0: AttemptState) {
    if (s0.item === 'queued') apply(id, { type: 'prepare', now: clock.now() });
    const settings = JSON.parse(i.settings) as { mode?: string };
    const gone = () => state(id).item === 'cancelled'; // stop() landed during an await: a normal exit
    const p = await driver.prepare(tab, { prompt: i.prompt, kind: i.kind, settings, refIds: JSON.parse(i.refs) });
    if (gone()) return;
    if (!p.ok) { apply(id, { type: 'prep_failed', error: { code: p.code, admission: 'continue' } }); return; }
    const chk = await driver.checkBeforeClick(tab, i.project);
    if (gone()) return;
    if (!chk.ok) { pause(i.batch, chk.code); return; }
    const ping = await driver.ping(tab);
    if (gone()) return;
    const manual = settings.mode === 'manual' || !o.autoAllowed(ping.email);
    const s = apply(id, manual ? { type: 'intent', ping, now: clock.now(), manual: true } : { type: 'intent', ping, now: clock.now() }); // R10: committed before click
    slot.set(tab, id);
    if (s.item === 'preparing') pause(i.batch, s.error?.code ?? 'INTENT_REFUSED'); // refused every time, not just the first
    if (!canClick(s)) return; // manual, or intent refused (observer dead → batch paused by apply)
    let result;
    try { result = await driver.click(tab, 1); } catch { apply(id, { type: 'deadline' }); return; } // shortcut: epoch fixed at 1 until the connector issues epochs
    try { apply(id, { type: 'clicked', result }); } catch { apply(id, { type: 'deadline' }); } // e.g. stop() during the click: it may have gone out, so uncertain
  }

  async function admit(tab: string) {
    const batches = db.prepare("select id, target_project p from batch where status='running' and stop_requested=0 and archived=0 order by created_at, rowid").all() as { id: string; p: string }[];
    for (const b of batches) {
      if (paused.has(b.id)) continue;
      const c = attempts(b.id).map((a) => ({ id: a.id, s: JSON.parse(a.j) as AttemptState })).find((a) => a.s.item === 'queued' || a.s.item === 'preparing');
      if (!c) continue; // nothing left to dispatch: the next batch may start (D-04)
      const i = info(c.id);
      const retry = c.s.retryAt !== null && c.s.retryAt > clock.now();
      const blocked = db.prepare('select 1 from target_block where project_id=?').get(b.p);
      if (retry || blocked || inFlight()[i.kind] >= caps[i.kind]) return; // this batch owns admission; backoff/block/cap holds it
      try { await dispatch(tab, c.id, i, c.s); } catch (e) { fail(b.id, e); }
      return;
    }
  }

  const todo = (name: string) => () => { throw new Error(`Task 6: ${name}`); };
  const setStatus = (b: string, from: string, to: string) => db.prepare('update batch set status=?, revision=revision+1 where id=? and status=?').run(to, b, from);

  let chain: Promise<unknown> = Promise.resolve();
  async function run() {
    flush();
    const drain = () => {
      while (queue.length) { // events in arrival order
        const e = queue.shift()!;
        const owner = e.type === 'disconnected' ? undefined : (slot.get(e.tabId) ?? awaiting.find((a) => a.tab === e.tabId)?.id);
        try { onEvent(e); } catch (err) { if (owner) fail(info(owner).batch, err); else console.error('runner: event without owner', err); }
      }
    };
    drain(); // 1.
    // 2. stop on an awaiting_user attempt ends with skip + a fresh ping (R18)
    const stopped = db.prepare('select id from batch where stop_requested=1').all() as { id: string }[];
    for (const b of stopped) for (const a of attempts(b.id)) {
      if ((JSON.parse(a.j) as AttemptState).item !== 'awaiting_user') continue;
      try {
        const ping = await driver.ping([...slot].find(([, v]) => v === a.id)?.[0] ?? tabs[0]);
        drain(); // R18: events that arrived during the ping come first; a late sent means it is no longer a skip
        if (state(a.id).item === 'awaiting_user') apply(a.id, { type: 'skip', ping, now: clock.now() });
      } catch (err) { fail(b.id, err); }
    }
    for (const tab of tabs) if (!busy(tab)) await admit(tab); // 3. admission
  }

  return {
    tick() { const p = chain.then(run); chain = p.catch(() => undefined); return p; },
    start(b) { paused.delete(b); setStatus(b, 'queued', 'running'); },
    pause(b) { setStatus(b, 'running', 'paused'); paused.set(b, null); },
    resume(b) { paused.delete(b); setStatus(b, 'paused', 'running'); },
    stop(b) {
      db.prepare('update batch set stop_requested=1, revision=revision+1 where id=?').run(b);
      for (const a of attempts(b)) {
        if (['ready', 'failed', 'cancelled'].includes((JSON.parse(a.j) as AttemptState).item)) continue;
        try { apply(a.id, { type: 'stop' }); } catch (e) { fail(b, e); }
      }
    },
    inFlight,
    lastError: (b) => paused.get(b) ?? null,
    caps: () => ({ ...caps }),
    rerun: todo('rerun'), confirm: todo('confirm'), archive: todo('archive'), recover: todo('recover'),
  };
}
