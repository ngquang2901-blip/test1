import type { AttemptState } from '@toolflow/flow-protocol/attempt';
import type { IpcMain } from 'electron';
import type { Db } from './db';
import { enqueueBatch, mapRefs, parsePrompts } from './batch';
import { batchStatus, type Runner } from './runner';
import { disableAuto, enableAuto } from './account';

export type Draft = { text: string; kind: 'image' | 'video'; mode: 'auto' | 'manual'; speed: 'default' | 'fast' };
export type StateEvent = { entity: 'batch'; id: string; revision: number };
export type Emit = ((entity: 'batch', id: string) => void) & { revision(): number };
export type Deps = {
  db: Db; runner: Runner; projectId: string; clock: { now(): number };
  email(): Promise<string | null>; session(): Promise<object>; getDraft(): Draft; saveDraft(d: Draft): void; emit: Emit;
};

const MAX_TEXT = 1_000_000;
const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }); };
const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : bad());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad());
const oneOf = <T extends string>(v: unknown, ...ok: T[]): T => (ok.includes(v as T) ? (v as T) : bad());
const text = (v: unknown): string => (typeof v === 'string' && v.length <= MAX_TEXT ? v : bad());

/** Monotonic revision stamped in main; the renderer drops older ones. */
export function revisioned(send: (e: StateEvent) => void): Emit {
  let rev = 0;
  return Object.assign((entity: 'batch', id: string) => send({ entity, id, revision: ++rev }), { revision: () => rev });
}

export const DEFAULT_DRAFT: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default' };
// Validates only the fields present; throws INVALID_ARGS on a bad one.
const draftPatch = (a: unknown): Partial<Draft> => {
  const o = obj(a), p: Partial<Draft> = {};
  if (o.text !== undefined) p.text = text(o.text);
  if (o.kind !== undefined) p.kind = oneOf(o.kind, 'image', 'video');
  if (o.mode !== undefined) p.mode = oneOf(o.mode, 'auto', 'manual');
  if (o.speed !== undefined) p.speed = oneOf(o.speed, 'default', 'fast');
  return p;
};
/** A draft read from disk goes through the same validator as IPC; anything bad means defaults. */
export function parseDraft(v: unknown): Draft {
  try { return { ...DEFAULT_DRAFT, ...draftPatch(v) }; } catch { return DEFAULT_DRAFT; }
}

function view(db: Db, id: string) {
  const b = db.prepare('select id, kind, settings_json s, archived, created_at createdAt, target_project project from batch where id=?').get(id) as
    { id: string; kind: string; s: string; archived: number; createdAt: number; project: string } | undefined;
  if (!b) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  const items = (db.prepare('select id, ord, source_line sourceLine, prompt, refs_json refs, attempt_id cur from item where batch_id=? order by ord').all(id) as
    { id: string; ord: number; sourceLine: number | null; prompt: string; refs: string; cur: string }[]).map((it) => {
    const attempts = (db.prepare('select id, ordinal, state_json j, click_at clickAt, reconcile_at reconcileAt, source_attempt_id sourceAttemptId from attempt where item_id=? order by ordinal').all(it.id) as
      { id: string; ordinal: number; j: string; clickAt: number | null; reconcileAt: number | null; sourceAttemptId: string | null }[]).map(({ j, ...a }) => {
      const s = JSON.parse(j) as AttemptState;
      return {
        ...a, item: s.item, stage: s.stage, error: s.error, creditSpent: s.creditSpent,
        outputs: ((s.outputs ?? []) as { mediaId: string }[]).map((o) => o.mediaId), // ids only: no signed urls (R54)
        journal: db.prepare('select type, at from journal_event where attempt_id=? order by id').all(a.id),
      };
    });
    return { id: it.id, ord: it.ord, sourceLine: it.sourceLine, prompt: it.prompt, refs: JSON.parse(it.refs), attemptId: it.cur, attempts };
  });
  return { id: b.id, kind: b.kind, status: batchStatus(db, id), archived: !!b.archived, createdAt: b.createdAt, settings: JSON.parse(b.s), project: b.project, items };
}

export function createHandlers(d: Deps) {
  const mut = (batchId: string, f: () => void) => { f(); d.emit('batch', batchId); };
  const batchOf = (attemptId: string) => (d.db.prepare('select i.batch_id b from attempt a join item i on i.id=a.item_id where a.id=?').get(attemptId) as { b: string } | undefined)?.b ?? bad();
  return {
    async saveDraft(a: unknown) {
      d.saveDraft({ ...d.getDraft(), ...draftPatch(a) }); // merge: a speed-only save must not clobber the text
    },
    async enqueueBatch(a: unknown) {
      const o = obj(a);
      const commandId = str(o.commandId), kind = oneOf(o.kind, 'image', 'video'), mode = oneOf(o.mode, 'auto', 'manual'), src = text(o.text);
      const parsed = parsePrompts(src);
      const { refs, errors } = mapRefs(parsed.items.length, [], 'none', 0); // shortcut: reference images arrive with uploads in P2
      if (parsed.items.length === 0) return { rows: [], errors: [{ code: 'EMPTY' }] };
      if (o.dryRun === true) return { rows: parsed.items.map((it, i) => ({ n: i + 1, sourceLine: it.sourceLine, prompt: it.prompt, refs: refs[i], error: null })), errors };
      const r = enqueueBatch(d.db, { commandId, kind, projectId: d.projectId, settings: {}, prompts: parsed.items.map((i) => i.prompt), refs, mode, sourceLines: parsed.items.map((i) => i.sourceLine) });
      d.emit('batch', r.batchId);
      return r;
    },
    async startBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.start(id)); },
    async pauseBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.pause(id)); },
    async resumeBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.resume(id)); },
    async stopBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.stop(id)); },
    async archiveBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.archive(id)); },
    async confirmUncertain(a: unknown) {
      const o = obj(a), id = str(o.attemptId), to = oneOf(o.to, 'sent', 'not_sent');
      mut(batchOf(id), () => d.runner.confirm(id, to));
    },
    async enableAuto(a: unknown) {
      if (obj(a ?? {}).ack !== true) throw Object.assign(new Error('ACK_REQUIRED'), { code: 'ACK_REQUIRED' });
      const email = await d.email();
      if (!email) throw Object.assign(new Error('NO_ACCOUNT'), { code: 'NO_ACCOUNT' });
      enableAuto(d.db, email, d.clock.now());
    },
    async disableAuto() { const email = await d.email(); if (email) disableAuto(d.db, email); },
    async listBatches() {
      const ids = d.db.prepare('select id from batch order by created_at desc, rowid desc').all() as { id: string }[];
      return { batches: ids.map((r) => view(d.db, r.id)), session: await d.session() };
    },
    async getBatch(a: unknown) { const rev = d.emit.revision(); return { ...view(d.db, str(a)), revision: rev }; }, // rev read first: never newer than the data
  };
}
export type Handlers = ReturnType<typeof createHandlers>;

export function registerIpc(ipc: Pick<IpcMain, 'handle'>, h: Handlers): void {
  for (const [ch, fn] of Object.entries(h)) ipc.handle(ch, (_e, arg) => (fn as (a: unknown) => unknown)(arg));
}
