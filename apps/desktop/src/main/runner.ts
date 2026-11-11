import { randomUUID } from 'node:crypto';
import { canClick, initial, type AttemptEvent, type AttemptState, type ItemState } from '@toolflow/flow-protocol/attempt';
import { classifyGenerateError } from '@toolflow/flow-protocol/errors';
import { parseGenerateRequest, parseImageReceipt, parsePoll, parseRpcResponse, parseVideoReceipt, readFReq } from '@toolflow/flow-protocol/parse';
import type { Db } from './db';
import type { DriverEvent, FlowDriver } from './driver';
import { applyEvent } from './journal';
import { CAPS, nextCap } from './caps';
import { comboQualified, profile, type Combo } from './profile';
import { CLICK_MS, RECONCILE_MS, runReconcile, unblock } from './reconcile';

const SEND_DEADLINE_MS = 30_000; // a click whose request the observer never reports is uncertain after this (04 Q-09)
const GENERATING_DEADLINE_MS = 20 * 60_000; // an accepted video with no final poll by then: needs review (07 §3: a limit of watching, not proof); a poll that still comes settles it
const RESPONSE_DEADLINE_MS = 120_000; // sent recorded but no response by then: uncertain (blocks the project, reconcile later), never resent
const BEAT_MS = 5_000; // while a response is awaited the tab is pinged at most this often
const coded = (code: string) => Object.assign(new Error(code), { code });

type Kind = 'image' | 'video';
export type BatchStatus = 'queued' | 'running' | 'paused' | 'needs_review' | 'completed' | 'partial_failed' | 'failed' | 'stopped';
export type Runner = {
  tick(): Promise<void>;
  setTabs(ids: string[]): void; // dynamic tab set (session grant)
  rerun(attemptId: string, confirmedCost: true): string;
  start(batchId: string): void; pause(batchId: string): void; resume(batchId: string): void; stop(batchId: string): void;
  confirm(attemptId: string, to: 'sent' | 'not_sent'): void; archive(batchId: string): void; recover(): void;
  inFlight(): { image: number; video: number };
  lastError(batchId: string): string | null;
  caps(): { image: number; video: number; tabs: number };
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
  db: Db; driver: FlowDriver; clock: { now(): number }; tabs: string[]; speed: 'default' | 'fast'; autoAllowed(email: string | null): boolean; combos?: readonly Combo[]; // qualified combos (default: the profile's)
  selfCheckOk?(tab: string): Promise<boolean>; // false ⇒ manual; absent ⇒ ok
  projectOf?(tab: string): string | null; // the project open in that tab: it only takes batches of that project; absent ⇒ any (single-tab unit tests)
}): Runner {
  const { db, driver, clock } = o;
  const max = CAPS[o.speed];
  let tabs = o.tabs.slice(0, max.tabs);
  const caps: Record<Kind, number> = { image: max.image, video: max.video };
  const queue: DriverEvent[] = [];
  driver.onEvent((e) => queue.push(e));
  const slot = new Map<string, string>(); // tab → attempt last given a click there
  const awaiting: { id: string; tab: string; at: number }[] = []; // sent, response not seen yet
  const epochs = new Map<string, number>(); // AC-30: bumped on every disconnect; older sent/response events are ignored
  const epoch = (tab: string) => { // first epoch = clock, so a restarted app is above any epoch of its previous run (R38)
    let e = epochs.get(tab); if (e === undefined) epochs.set(tab, (e = clock.now())); return e;
  };
  // Per tab: page id + generate count at the first intent after a page change/fence (genBase) and the sends we accepted since (ours).
  // ping.gen !== genBase + ours ⇒ the page made a generate we did not account for.
  const pages = new Map<string, { id: string; genBase: number; ours: number; beat: number }>();
  const fenced = new Set<string>(); // fenced since the last click there: a stale armed tracker may remain, disarm before the next click
  const rearm = new Set<string>(); // fenced while the user was to send here: the armed tracker still stamps the old epoch
  const clicking = new Set<string>(); // attempts whose driver.click has not returned
  const paused = new Map<string, string | null>(); // authoritative even when the DB write failed; flushed each tick
  const unc = new Set<string>(); // batches whose current pause was set only because an attempt went uncertain: the only pause release() lifts

  const state = (id: string) => JSON.parse((db.prepare('select state_json j from attempt where id=?').get(id) as { j: string }).j) as AttemptState;
  const info = (id: string) => db.prepare(
    `select b.id batch, b.target_project project, b.kind, b.settings_json settings, i.prompt, i.refs_json refs
     from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id where a.id=?`).get(id) as Info;
  const attempts = (batch: string) => db.prepare('select a.id, a.state_json j from item i join attempt a on a.id=i.attempt_id where i.batch_id=? order by i.ord').all(batch) as { id: string; j: string }[];

  const flush = () => {
    for (const b of paused.keys()) {
      if (unc.has(b)) continue; // not persisted: recover() rebuilds it from target_block, so a restart still auto-resumes (R31)
      try { db.prepare("update batch set status='paused', revision=revision+1 where id=? and status='running'").run(b); } catch { /* retried next tick */ }
    }
  };
  const pause = (b: string, reason: string | null = null, uncertain = false) => { paused.set(b, reason); if (uncertain) unc.add(b); else unc.delete(b); flush(); };
  // An uncertain pause may be taken over only when the batch was running; a user/drift pause already in place keeps its own reason.
  const ownsPause = (b: string) => paused.has(b) ? unc.has(b) : (db.prepare('select status from batch where id=?').get(b) as { status: string }).status !== 'paused';
  const fail = (b: string, e: unknown) => {
    const code = (e as { code?: string }).code ?? '';
    const reason = ['ILLEGAL_TRANSITION', 'CONNECTOR_LOST', 'PROTOCOL_DRIFT'].includes(code) ? code // ProtocolDrift carries code, its name is plain Error
      : code.startsWith('SQLITE_') ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR';
    if (reason === 'ILLEGAL_TRANSITION' || reason === 'INTERNAL_ERROR') console.error(`runner: ${reason}`, e);
    pause(b, reason);
  };

  /** Runs one event through applyEvent (stop() calls it; confirm() and reconcile.ts call applyEvent directly): also blocks the project on needs_review and pauses on any pause-level admission. */
  const apply = (id: string, ev: AttemptEvent): AttemptState => {
    const prev = state(id);
    const s = applyEvent(db, id, ev, clock.now());
    const i = info(id);
    if (s.item === 'needs_review') db.prepare('insert or ignore into target_block(project_id, attempt_id, since) values(?,?,?)').run(i.project, id, clock.now());
    if (s.item === 'needs_review' && s.stage === 'uncertain' && prev.item !== 'needs_review') // R27
      db.prepare(`update attempt as a set reconcile_at=coalesce(${CLICK_MS}, ?) + ? where id=?`).run(clock.now(), RECONCILE_MS, id);
    if (prev.item === 'needs_review' && s.item !== 'needs_review') release(id); // late evidence settled it
    // only a change pauses (a sticky admission must not re-pause after resume), but a fresh error always counts
    const err = s.error as (AttemptState['error'] & { admission?: string }) | null;
    const fresh = err != null && JSON.stringify(err) !== JSON.stringify(prev.error);
    // a fresh error decides by its own admission (the sticky s.admission may be left over from an earlier pause)
    const level = fresh ? (err.admission ?? s.admission) : s.admission;
    const changed = fresh || s.admission !== prev.admission || (s.item === 'needs_review' && prev.item !== 'needs_review');
    const toReview = s.item === 'needs_review' && prev.item !== 'needs_review';
    if (changed && level !== 'continue' && level !== 'throttle') pause(i.batch, s.error?.code ?? s.admission, toReview && ownsPause(i.batch));
    return s;
  };

  const setStatus = (b: string, from: string, to: string) => db.prepare('update batch set status=?, revision=revision+1 where id=? and status=?').run(to, b, from);
  /** Unblocks the project and lets the batch go on, unless another attempt of it still needs review. */
  const release = (id: string) => {
    unblock(db, id);
    const b = info(id).batch;
    if (db.prepare("select 1 from item i join attempt a on a.id=i.attempt_id where i.batch_id=? and json_extract(a.state_json,'$.item')='needs_review'").get(b)) return;
    if (!unc.delete(b)) return; // user pause, drift, config…: only resume() lifts those
    paused.delete(b); setStatus(b, 'paused', 'running');
  };

  const inFlight = () => {
    const n = { image: 0, video: 0 };
    const rows = db.prepare('select b.kind, a.state_json j from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id').all() as { kind: Kind; j: string }[];
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

  /** Observation of this tab is lost or unproven (disconnect, send deadline, archive): older events are void and whatever awaits a response is uncertain. */
  function fence(tab: string) {
    epochs.set(tab, epoch(tab) + 1);
    pages.delete(tab); fenced.add(tab);
    const cur = slot.get(tab); if (cur && state(cur).item === 'awaiting_user') rearm.add(tab);
    const ids = new Set([slot.get(tab), ...awaiting.filter((a) => a.tab === tab).map((a) => a.id)]);
    for (let k = awaiting.length; k--;) if (awaiting[k].tab === tab) awaiting.splice(k, 1);
    for (const id of ids) if (id && state(id).item === 'submitting') apply(id, { type: 'deadline' });
  }

  /** Flow polls its videos by itself; an answer can name operations of any attempt and of the user's own videos: only attempts that own one take it. */
  function onPoll(text: string) {
    const waiting = (db.prepare("select a.id, a.state_json j from attempt a where json_extract(a.state_json,'$.item') in ('generating','needs_review')").all() as { id: string; j: string }[])
      .map((r) => ({ id: r.id, s: JSON.parse(r.j) as AttemptState })).filter((a) => a.s.operations && (a.s.item === 'generating' || a.s.stage === 'accepted'));
    if (!waiting.length) return;
    let ops: { operationId: string }[];
    try {
      const r = parseRpcResponse(text, 'jwpduf') as { error?: unknown; payload?: unknown };
      if (r.error) return; // the poll itself was refused: says nothing about a video, the next one will
      ops = (parsePoll(r.payload) as { operations: { operationId: string }[] }).operations;
    } catch (err) { for (const b of new Set(waiting.map((a) => info(a.id).batch))) fail(b, err); return; } // unreadable: every batch that waits on a poll stops (PROTOCOL_DRIFT)
    for (const a of waiting) if ((a.s.operations as { operationId: string }[]).some((o) => ops.some((p) => p.operationId === o.operationId))) apply(a.id, { type: 'poll', operations: ops } as AttemptEvent);
  }

  function onEvent(e: DriverEvent) {
    if (e.type === 'disconnected') { fence(e.tabId); return; }
    if (e.type === 'poll') { onPoll(e.text); return; }
    if (!(e.epoch >= epoch(e.tabId))) return; // answers a connection that is gone; reconcile settles what it left uncertain
    if (e.type === 'sent') {
      const pg = pages.get(e.tabId); if (pg) pg.ours++; // the page's gen counted this send
      const id = slot.get(e.tabId);
      if (!id || state(id).item === 'needs_review') return; // already uncertain: nothing legal to record
      let request;
      try { request = parseGenerateRequest(readFReq(e.request as string)); } catch (err) { // R11: journal the parsed request, never the raw body
        if (state(id).item === 'submitting') apply(id, { type: 'deadline' }); // unprovable: uncertain + project blocked
        throw err; // run() pauses the batch with PROTOCOL_DRIFT
      }
      if (apply(id, { type: 'sent', request }).request) awaiting.push({ id, tab: e.tabId, at: clock.now() });
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
    let ev: AttemptEvent;
    try { // blame the matched attempt's batch, not whoever holds the tab slot
      const r = parseRpcResponse(e.text, e.rpc) as { error?: { grpc: number; reasons: string[] }; payload?: unknown };
      if (r.error) ev = { type: 'rejected', error: r.error, now: clock.now() };
      else ev = { type: 'receipt', receipt: e.rpc === 'ogiZ0b' ? parseImageReceipt(r.payload) : parseVideoReceipt(r.payload) };
    } catch (err) {
      awaiting.splice(awaiting.indexOf(hit), 1);
      if (state(hit.id).item === 'submitting') apply(hit.id, { type: 'deadline' }); // unreadable reply: uncertain + project blocked, never resent
      fail(info(hit.id).batch, err); return;
    }
    awaiting.splice(awaiting.indexOf(hit), 1);
    const kind = info(hit.id).kind;
    const s = apply(hit.id, ev);
    if (ev.type === 'rejected' && classifyGenerateError(ev.error).admission === 'throttle') caps[kind] = nextCap(caps[kind], 'throttled', max[kind]);
    else if (ev.type === 'receipt' && (s.item === 'ready' || s.item === 'generating')) caps[kind] = nextCap(caps[kind], 'ok', max[kind]);
  }

  async function dispatch(tab: string, id: string, i: Info, s0: AttemptState) {
    const settings = JSON.parse(i.settings) as { mode?: string; combo?: unknown };
    if (!comboQualified(i.kind, settings.combo, o.combos)) { pause(i.batch, 'COMBO_NOT_QUALIFIED'); return; } // AC-03: before any state change, intent or page call
    if (s0.item === 'queued') apply(id, { type: 'prepare', now: clock.now() });
    const gone = () => state(id).item === 'cancelled'; // stop() landed during an await: a normal exit
    // Pause / stop / not running since admission: leave the attempt as it is (still preparing) so a resume prepares it again. Checked after every await up to the intent.
    const halted = () => {
      if (gone() || paused.has(i.batch)) return true;
      const b = db.prepare('select status, stop_requested s from batch where id=?').get(i.batch) as { status: string; s: number };
      return b.status !== 'running' || b.s !== 0;
    };
    const p = await driver.prepare(tab, { prompt: i.prompt, kind: i.kind, settings, refIds: JSON.parse(i.refs), projectId: i.project });
    if (gone()) return;
    if (!p.ok) { apply(id, { type: 'prep_failed', error: { code: p.code, admission: p.code === 'REF_UPLOAD_UNCERTAIN' ? 'pause' : 'continue' } }); return; } // a ref upload that may have happened waits for the user, no retry
    if (halted()) return;
    const chk = await driver.checkBeforeClick(tab, i.project, JSON.parse(i.refs));
    if (halted()) return;
    if (!chk.ok) { pause(i.batch, chk.code); return; }
    const ping = await driver.ping(tab);
    if (gone()) return;
    const pg = pages.get(tab); // double-send guard (auto and manual): nothing is written or clicked when the page sent something we did not account for
    if (pg && pg.id !== ping.id && awaiting.some((a) => a.tab === tab)) fence(tab); // reloaded under a pending response: uncertain before anything new goes out
    if (!pg || pg.id !== ping.id) pages.set(tab, { id: ping.id, genBase: ping.gen, ours: 0, beat: clock.now() });
    else if (ping.gen !== pg.genBase + pg.ours) { pg.genBase = ping.gen - pg.ours; pause(i.batch, 'UNEXPECTED_GENERATE'); return; } // rebased: resume goes on
    let manual = settings.mode === 'manual' || !o.autoAllowed(ping.email);
    if (!manual && o.selfCheckOk) { manual = !(await o.selfCheckOk(tab).catch(() => false)); if (gone()) return; } // I1: drifted/blind tab never auto-clicks
    if (fenced.delete(tab)) { // a stale armed tracker may remain: disarm (best effort) before the intent, so a stop during it still ends before any click
      await driver.arm(tab, null).catch(() => {});
    }
    if (halted()) return; // last gate before the intent: nothing is journaled or clicked for a batch that is paused / stopping / not running
    const s = apply(id, manual ? { type: 'intent', ping, now: clock.now(), profileVersion: profile.version, manual: true } : { type: 'intent', ping, now: clock.now(), profileVersion: profile.version }); // AC-18: version stamped in the journal; R10: committed before click
    slot.set(tab, id);
    if (s.item === 'preparing') pause(i.batch, s.error?.code ?? 'INTENT_REFUSED'); // refused every time, not just the first
    if (!canClick(s)) { // manual, or intent refused (observer dead → batch paused by apply)
      if (s.item !== 'awaiting_user') return;
      await driver.focusTab(tab).catch((e) => console.error('runner: focus failed', (e as { code?: string }).code)); // AC-11: the user sends in this tab; a failed focus never blocks arming
      await armTab(tab, id, i.batch);
      return;
    }
    if (!canClick(state(id))) return; // stop() may have landed since the intent
    let result;
    clicking.add(id);
    try { result = await driver.click(tab, epoch(tab)); } catch { db.prepare('update attempt set click_at=? where id=?').run(clock.now(), id); fence(tab); return; } finally { clicking.delete(id); } // a drop may still have sent it: window starts here too
    db.prepare('update attempt set click_at=? where id=?').run(clock.now(), id); // R27: the reconcile window starts here
    try { apply(id, { type: 'clicked', result }); } catch { apply(id, { type: 'deadline' }); } // e.g. stop() during the click: it may have gone out, so uncertain
  }

  // R39/R40: a blind tab must not be waited on, and the arm may have reached the page before it threw: the user may still send, so never cancelled.
  // prep_failed is illegal after intent; skip+armFailed is the legal route to uncertain. again: drop the old tracker first (arming a pending one is ambiguous).
  async function armTab(tab: string, id: string, batch: string, again = false) {
    try { if (again) await driver.arm(tab, null); await driver.arm(tab, epoch(tab)); } catch (err) {
      try { if (state(id).item === 'awaiting_user') apply(id, { type: 'skip', ping: await driver.ping(tab), now: clock.now(), armFailed: true }); } catch (e2) { fail(batch, e2); return; }
      fail(batch, err);
    }
  }

  async function admit(tab: string) {
    const batches = db.prepare("select id, target_project p from batch where status='running' and stop_requested=0 and archived=0 order by created_at, rowid").all() as { id: string; p: string }[];
    for (const b of batches) {
      if (paused.has(b.id)) continue;
      if (o.projectOf && o.projectOf(tab) !== b.p) continue; // another project's batch: never prepare it in this tab (prepare would refuse with TARGET_CHANGED)
      const c = attempts(b.id).map((a) => ({ id: a.id, s: JSON.parse(a.j) as AttemptState })).find((a) => a.s.item === 'queued' || a.s.item === 'preparing');
      if (!c) continue; // nothing left to dispatch: the next batch may start (D-04)
      const i = info(c.id);
      const retry = c.s.retryAt !== null && c.s.retryAt > clock.now();
      const blocked = db.prepare('select 1 from target_block where project_id=?').get(b.p);
      if (blocked) continue; // that project waits for its reconcile; other projects go on (D-04)
      if (retry || inFlight()[i.kind] >= caps[i.kind]) return; // this batch owns admission; backoff/cap holds it
      try { await dispatch(tab, c.id, i, c.s); } catch (e) { fail(b.id, e); }
      return;
    }
  }


  let chain: Promise<unknown> = Promise.resolve();
  async function run() {
    flush();
    const drain = () => {
      while (queue.length) { // events in arrival order
        const e = queue.shift()!;
        const owner = e.type === 'disconnected' || e.type === 'poll' ? undefined : (slot.get(e.tabId) ?? awaiting.find((a) => a.tab === e.tabId)?.id);
        try { onEvent(e); } catch (err) { if (owner) fail(info(owner).batch, err); else console.error('runner: event without owner', err); }
      }
    };
    drain(); // 1.
    // 2. stop on an awaiting_user attempt ends with skip + a fresh ping (R18)
    const stopped = db.prepare('select id from batch where stop_requested=1').all() as { id: string }[];
    for (const b of stopped) for (const a of attempts(b.id)) {
      if ((JSON.parse(a.j) as AttemptState).item !== 'awaiting_user') continue;
      const tab = [...slot].find(([, v]) => v === a.id)?.[0] ?? tabs[0];
      try {
        const ping = await driver.ping(tab);
        drain(); // R18: events that arrived during the ping come first; a late sent means it is no longer a skip
        if (state(a.id).item === 'awaiting_user') { apply(a.id, { type: 'skip', ping, now: clock.now() }); await driver.arm(tab, null); } // R39: the tab no longer awaits the user
      } catch (err) { fail(b.id, err); }
    }
    // 3. a click that left no request is uncertain after its deadline; then every due reconcile (D-11)
    for (const r of db.prepare('select a.id, a.click_at c, a.state_json j from attempt a where a.click_at is not null and json_extract(a.state_json, \'$.item\') = \'submitting\'').all() as { id: string; c: number; j: string }[]) {
      const s = JSON.parse(r.j) as AttemptState;
      if (s.item === 'submitting' && s.clicked && !s.request && clock.now() - r.c >= SEND_DEADLINE_MS && !clicking.has(r.id)) {
        try { // fence the tab: the late sent/response of this attempt must not bind to the next one clicked there
          const tab = [...slot].find(([, v]) => v === r.id)?.[0];
          if (tab) fence(tab); else apply(r.id, { type: 'deadline' });
        } catch (err) { fail(info(r.id).batch, err); }
      }
    }
    for (const r of db.prepare("select a.id from attempt a where a.click_at is not null and json_extract(a.state_json, '$.item') = 'generating' and ? - a.click_at >= ?").all(clock.now(), GENERATING_DEADLINE_MS) as { id: string }[]) {
      try { apply(r.id, { type: 'deadline' }); } catch (err) { fail(info(r.id).batch, err); }
    }
    for (const a of [...awaiting]) if (awaiting.includes(a) && clock.now() - a.at >= RESPONSE_DEADLINE_MS) { // no response in time: uncertain via the same deadline path as a lost tab
      try { fence(a.tab); } catch (err) { fail(info(a.id).batch, err); }
    }
    for (const tab of new Set(awaiting.map((a) => a.tab))) { // heartbeat after click
      const pg = pages.get(tab);
      if (!pg || clock.now() - pg.beat < BEAT_MS) continue;
      pg.beat = clock.now();
      let lost = false;
      try { const p = await driver.ping(tab); lost = p.id !== pg.id || !p.xhrSend || !p.xhrOpen || !p.fetch; } catch { lost = true; }
      drain(); // events that arrived during the ping come first
      const own = awaiting.find((a) => a.tab === tab);
      if (lost && pages.get(tab) === pg && own) try { fence(tab); } catch (err) { fail(info(own.id).batch, err); }
    }
    for (const tab of [...rearm]) { // after a fence: the awaiting_user attempt of the slot gets the new epoch
      rearm.delete(tab);
      const id = slot.get(tab);
      if (id && tabs.includes(tab) && state(id).item === 'awaiting_user') await armTab(tab, id, info(id).batch, true);
    }
    for (const r of db.prepare('select id from attempt where reconcile_at is not null and reconcile_at <= ?').all(clock.now()) as { id: string }[]) {
      try { if (await runReconcile(db, driver, r.id, clock.now()) === 'found') release(r.id); } catch (err) { fail(info(r.id).batch, err); }
    }
    for (const tab of tabs) if (!busy(tab)) await admit(tab); // 4. admission
  }

  return {
    setTabs(ids) { // a dropped tab loses observation: same fence as a disconnect, so its in-flight attempts turn uncertain instead of vanishing
      const next = ids.slice(0, max.tabs);
      for (const t of tabs) if (!next.includes(t)) fence(t);
      tabs = next;
    },
    tick() { const p = chain.then(run); chain = p.catch(() => undefined); return p; },
    start(b) { paused.delete(b); unc.delete(b); setStatus(b, 'queued', 'running'); },
    pause(b) { setStatus(b, 'running', 'paused'); paused.set(b, null); unc.delete(b); },
    resume(b) { paused.delete(b); unc.delete(b); setStatus(b, 'paused', 'running'); },
    stop(b) {
      db.prepare('update batch set stop_requested=1, revision=revision+1 where id=?').run(b);
      for (const a of attempts(b)) {
        if (['ready', 'failed', 'cancelled'].includes((JSON.parse(a.j) as AttemptState).item)) continue;
        try { apply(a.id, { type: 'stop' }); } catch (e) { fail(b, e); }
      }
    },
    inFlight,
    lastError: (b) => paused.get(b) ?? null,
    caps: () => ({ ...caps, tabs: max.tabs }),
    rerun(id, confirmedCost) {
      if (confirmedCost !== true) throw coded('COST_NOT_CONFIRMED');
      const i = info(id);
      if ((db.prepare('select archived a from batch where id=?').get(i.batch) as { a: number }).a) throw coded('BATCH_ARCHIVED'); // an archived batch keeps its record: no new paid attempt in it
      if (db.prepare('select 1 from target_block where project_id=?').get(i.project)) throw coded('TARGET_BLOCKED'); // AC-22: settle the uncertain one first
      return db.transaction(() => {
        const a = db.prepare('select item_id, ordinal from attempt where id=?').get(id) as { item_id: string; ordinal: number };
        const it = db.prepare('select attempt_id from item where id=?').get(a.item_id) as { attempt_id: string };
        if (it.attempt_id !== id) throw coded('ALREADY_RERUN'); // one paid copy per confirmation
        if (state(id).item !== 'failed') throw coded('NOT_RERUNNABLE');
        const n = randomUUID();
        db.prepare('insert into attempt(id,item_id,ordinal,state_json,revision,source_attempt_id) values(?,?,?,?,0,?)').run(n, a.item_id, a.ordinal + 1, JSON.stringify(initial(i.prompt)), id);
        db.prepare('update item set attempt_id=? where id=?').run(n, a.item_id);
        return n;
      })();
    },
    confirm(id, to) { // D-11: the user's word settles it; the attempt is never clicked again
      applyEvent(db, id, { type: 'resolve', to, evidence: { source: 'user' } }, clock.now());
      release(id);
    },
    archive(b) { // no fence: responses bind to `awaiting` by rpc+batchId, so sent attempts of an archived batch keep being followed; the block stays too
      for (const a of attempts(b)) {
        const s = JSON.parse(a.j) as AttemptState;
        if (clicking.has(a.id) || s.item === 'awaiting_user' || (s.item === 'submitting' && !s.request)) throw coded('CLICK_IN_FLIGHT');
      }
      db.prepare('update batch set archived=1, revision=revision+1 where id=?').run(b);
    },
    recover() { // D-04: every intent without a receipt is uncertain after a restart; blocks are rebuilt from the attempts themselves
      const all = db.prepare('select a.id, a.state_json j from attempt a').all() as { id: string; j: string }[];
      for (const r of all) if (['submitting', 'awaiting_user'].includes((JSON.parse(r.j) as AttemptState).item)) apply(r.id, { type: 'restart' });
      db.transaction(() => {
        db.exec('delete from target_block');
        for (const r of all) {
          const s = state(r.id);
          if (s.item !== 'needs_review') continue;
          const i = info(r.id);
          db.prepare('insert or ignore into target_block(project_id, attempt_id, since) values(?,?,?)').run(i.project, r.id, clock.now());
          if (s.stage === 'uncertain') db.prepare(`update attempt as a set reconcile_at=coalesce(${CLICK_MS}, ?) + ? where id=? and reconcile_at is null`).run(clock.now(), RECONCILE_MS, r.id);
          pause(i.batch, s.error?.code ?? 'SUBMIT_UNCERTAIN', ownsPause(i.batch));
        }
      })();
    },
  };
}
