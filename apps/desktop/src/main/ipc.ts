import type { IpcMain } from 'electron';
import type { Db } from './db';
import { MAX_REFS } from './workflow';
import { GEM_ASPECTS, GEM_MODELS } from './gpt-driver';
import { defaultCombo, findCombo } from './profile';
import { enqueueBatch, mapRefs, parsePrompts } from './batch';
import type { Runner } from './runner';
import { viewBatches } from './batch-view';
import { disableAuto, enableAuto } from './account';
import { AssetError, EXT, registerAsset, sniff } from './assets';
import type { Grants } from './tabs';
import type { Downloader } from './downloads';
import { readFileSync, statSync } from 'node:fs';
import type { Updates } from './updates';
import { randomUUID } from 'node:crypto';
import { setStart, startAtOf } from './schedule';

export type Draft = {
  text: string; kind: 'image' | 'video'; mode: 'auto' | 'manual'; speed: 'default' | 'fast'; autoSave: boolean;
  notifyApp: boolean; notifyWindows: boolean; notifyTelegram: boolean; // one switch per notice channel
  tray: boolean; openAtLogin: boolean; creditWarn: number; // closing hides to the tray; start with Windows (in the tray); warn under this many Flow credits
};
export type StateEvent = { entity: 'batch'; id: string; revision: number };
export type Emit = ((entity: 'batch', id: string) => void) & { revision(): number };
export type Deps = {
  db: Db; runner: Runner; grants: Pick<Grants, 'use'>; projects(): string[] | Promise<string[]>; clock: { now(): number }; // projects: distinct projects of the granted tabs
  email(): Promise<string | null>; emails?(): Promise<string[]>; session(): Promise<object>; pickPaths(): Promise<string[]>; getDraft(): Draft; saveDraft(d: Draft): void; emit: Emit; // emails: every account of the granted tabs (absent ⇒ just email())
  downloader: Pick<Downloader, 'batch' | 'retry' | 'file'>; reveal(path: string): void; openExtensionFolder?(): void; updates?: Pick<Updates, 'get' | 'check' | 'install'>;
  thumb(file: Buffer): Buffer | null; // a small JPEG of an image file, null when it is small already or cannot be decoded
};

const MAX_TEXT = 1_000_000;
type Preset = { kind: 'image' | 'video'; mode: 'auto' | 'manual'; combo?: object; refs: { assetIds: string[]; mode: string; perItem: number }; template: { template: string; how: 'all' | 'zip'; lists: Record<string, string> } };
const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }); };
const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : bad());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad());
const oneOf = <T extends string>(v: unknown, ...ok: T[]): T => (ok.includes(v as T) ? (v as T) : bad());
const MODES = ['none', 'all', 'sequential', 'start'] as const;
const text = (v: unknown): string => (typeof v === 'string' && v.length <= MAX_TEXT ? v : bad());

/** Monotonic revision stamped in main; the renderer drops older ones. */
export function revisioned(send: (e: StateEvent) => void): Emit {
  let rev = 0;
  return Object.assign((entity: 'batch', id: string) => send({ entity, id, revision: ++rev }), { revision: () => rev });
}

export const DEFAULT_DRAFT: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default', autoSave: true, notifyApp: true, notifyWindows: true, notifyTelegram: true, tray: true, openAtLogin: false, creditWarn: 50 };
// Validates only the fields present; throws INVALID_ARGS on a bad one.
const draftPatch = (a: unknown): Partial<Draft> => {
  const o = obj(a), p: Partial<Draft> = {};
  if (o.text !== undefined) p.text = text(o.text);
  if (o.kind !== undefined) p.kind = oneOf(o.kind, 'image', 'video');
  if (o.mode !== undefined) p.mode = oneOf(o.mode, 'auto', 'manual');
  if (o.speed !== undefined) p.speed = oneOf(o.speed, 'default', 'fast');
  for (const k of ['autoSave', 'notifyApp', 'notifyWindows', 'notifyTelegram', 'tray', 'openAtLogin'] as const) if (o[k] !== undefined) p[k] = typeof o[k] === 'boolean' ? (o[k] as boolean) : bad();
  if (o.creditWarn !== undefined) p.creditWarn = Number.isInteger(o.creditWarn) && (o.creditWarn as number) >= 0 && (o.creditWarn as number) <= 1_000_000 ? (o.creditWarn as number) : bad();
  return p;
};
/** A draft read from disk goes through the same validator as IPC; anything bad means defaults. */
export function parseDraft(v: unknown): Draft {
  try { return { ...DEFAULT_DRAFT, ...draftPatch(v) }; } catch { return DEFAULT_DRAFT; }
}

function view(db: Db, id: string) {
  const [b] = viewBatches(db, [id]);
  if (!b) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' });
  return b;
}

const PREVIEWS_KEPT = 300; // about 20 MB of 640 px thumbnails

export function createHandlers(d: Deps) {
  const previews = new Map<string, { url: string }>(); // newest last; key: file path, size, change time
  const mut = (batchId: string, f: () => void) => { f(); d.emit('batch', batchId); };
  const accounts = async (): Promise<string[]> => (d.emails ? d.emails() : [await d.email()].filter((e): e is string => !!e));
  const batchOf = (attemptId: string) => (d.db.prepare('select i.batch_id b from attempt a join item i on i.id=a.item_id where a.id=?').get(attemptId) as { b: string } | undefined)?.b ?? bad();
  return {
    async saveDraft(a: unknown) {
      d.saveDraft({ ...d.getDraft(), ...draftPatch(a) }); // merge: a speed-only save must not clobber the text
    },
    async enqueueBatch(a: unknown) {
      const o = obj(a);
      const commandId = str(o.commandId), kind = oneOf(o.kind, 'image', 'video'), mode = oneOf(o.mode, 'auto', 'manual'), src = text(o.text);
      const provider = o.provider === undefined ? 'flow' : oneOf(o.provider, 'flow', 'chatgpt', 'gemini');
      const startAt = o.startAt === undefined || o.dryRun === true ? null : startAtOf(o.startAt, d.clock.now()); // Hẹn giờ chạy: checked before anything is created
      const site = provider !== 'flow'; // ChatGPT / Gemini: images only, always sent by the app, no Flow project / settings
      if (site && (kind !== 'image' || mode !== 'auto')) bad();
      const aspect = o.aspect === undefined ? undefined : provider === 'gemini' ? oneOf(o.aspect, ...GEM_ASPECTS) : bad(); // Gemini's own ratio menu
      const model = o.model === undefined ? undefined : provider === 'gemini' ? oneOf(o.model, ...GEM_MODELS) : bad(); // …and model menu
      const combo = site ? null : o.combo === undefined ? defaultCombo(kind) : findCombo(kind, o.combo); // Tạo lô and a workflow node may pick their own model / aspect / count
      if (!site && !combo) throw Object.assign(new Error('COMBO_NOT_QUALIFIED'), { code: 'COMBO_NOT_QUALIFIED' }); // AC-03 at the door: nothing is created, no other combo is used instead
      const parsed = parsePrompts(src);
      const ra = o.refs === undefined ? { assetIds: [], mode: 'none', perItem: 1 } : obj(o.refs);
      const ids = Array.isArray(ra.assetIds) ? ra.assetIds.map(str) : bad();
      const rmode = oneOf(ra.mode, ...MODES), perItem = Number.isInteger(ra.perItem) && (ra.perItem as number) >= 1 && (ra.perItem as number) <= MAX_REFS ? (ra.perItem as number) : bad();
      if (new Set(ids).size !== ids.length) bad();
      const names = ids.map((id) => (d.db.prepare('select name from asset where id=?').get(id) as { name: string } | undefined)?.name ?? bad());
      const { refs, errors } = mapRefs(parsed.items.length, ids, rmode, perItem);
      if (kind === 'video' && refs.some((r) => r.length > 2)) throw Object.assign(new Error('REF_KIND_UNSUPPORTED'), { code: 'REF_KIND_UNSUPPORTED' }); // a video takes its start frame and, optionally, its end frame (several ingredients are not built)
      if (parsed.items.length === 0) return { rows: [], errors: [{ code: 'EMPTY' }] };
      const rows = parsed.items.map((it, i) => ({ n: i + 1, sourceLine: it.sourceLine, prompt: it.prompt, refs: refs[i].map((id) => names[ids.indexOf(id)]), error: errors.find((e) => e.index === i)?.code ?? null }));
      if (o.dryRun === true || errors.length) return { rows, errors }; // a mapping error never creates a batch: no rotation, no truncation (AC-04)
      if (site) {
        const r = enqueueBatch(d.db, { commandId, kind, provider, projectId: null, mode, settings: { provider, ...(aspect ? { aspect } : {}), ...(model ? { model } : {}) }, prompts: parsed.items.map((it) => it.prompt), refs, sourceLines: parsed.items.map((it) => it.sourceLine) });
        if (startAt !== null) setStart(d.db, r.batchId, startAt);
        d.emit('batch', r.batchId);
        return { ...r, batchIds: [r.batchId] };
      }
      const projects = await d.projects(); // read at call time: the granted tabs can change
      if (!projects.length) throw Object.assign(new Error('NO_PROJECT_TAB'), { code: 'NO_PROJECT_TAB' });
      // several projects (tabs/accounts): one batch per project, line i goes to project i mod n; each batch keeps every per-project guarantee
      const parts = projects.map((projectId, k) => ({ projectId, idx: parsed.items.map((_, i) => i).filter((i) => i % projects.length === k) })).filter((p) => p.idx.length);
      const made = parts.map((p, k) => enqueueBatch(d.db, {
        commandId: parts.length === 1 ? commandId : `${commandId}#${k}`, kind, projectId: p.projectId, mode, ords: p.idx,
        settings: { combo, ...(parts.length > 1 ? { split: { part: k + 1, of: parts.length } } : {}) },
        prompts: p.idx.map((i) => parsed.items[i].prompt), refs: p.idx.map((i) => refs[i]), sourceLines: p.idx.map((i) => parsed.items[i].sourceLine),
      }));
      made.forEach((r) => { if (startAt !== null) setStart(d.db, r.batchId, startAt); d.emit('batch', r.batchId); });
      return { ...made[0], batchIds: made.map((r) => r.batchId) };
    },
    async pickRefs() { // codes only: a path in the result would reach the renderer
      const assets: { id: string; name: string; bytes: number }[] = [], errors: { code: string }[] = [];
      for (const path of await d.pickPaths()) {
        try { const { id, name, bytes } = registerAsset(d.db, path, d.clock.now()); assets.push({ id, name, bytes }); }
        catch (e) { errors.push({ code: e instanceof AssetError ? e.code : 'ASSET_UNREADABLE' }); }
      }
      return { assets, errors };
    },
    async listPresets() { // each ref says whether its file is still registered; the renderer gets names and sizes, never paths
      const asset = d.db.prepare('select id, name, bytes from asset where id=?');
      return (d.db.prepare('select id, name, json from preset order by updated_at desc').all() as { id: string; name: string; json: string }[]).map((r) => {
        const p = JSON.parse(r.json) as Preset;
        return { id: r.id, name: r.name, ...p, refs: { ...p.refs, assets: p.refs.assetIds.map((id) => (asset.get(id) as { id: string; name: string; bytes: number } | undefined) ?? { id, name: '', bytes: 0, missing: true }) } };
      });
    },
    async savePreset(a: unknown) { // same name = update (the user re-saves an edited setup)
      const o = obj(a), name = text(o.name).trim();
      if (!name || name.length > 60) bad();
      const r = obj(o.refs), t = obj(o.template ?? { template: '', lists: {}, how: 'all' }), lists = obj(t.lists);
      const ids = Array.isArray(r.assetIds) && r.assetIds.length <= 50 ? r.assetIds.map(str) : bad();
      for (const id of ids) if (!d.db.prepare('select 1 from asset where id=?').get(id)) bad();
      const p: Preset = {
        kind: oneOf(o.kind, 'image', 'video'), mode: oneOf(o.mode, 'auto', 'manual'),
        ...(o.combo === undefined ? {} : { combo: findCombo(oneOf(o.kind, 'image', 'video'), o.combo) ?? bad() }), // only settings the profile offers, stored as its own object
        refs: { assetIds: ids, mode: oneOf(r.mode, ...MODES), perItem: Number.isInteger(r.perItem) && (r.perItem as number) >= 1 && (r.perItem as number) <= MAX_REFS ? (r.perItem as number) : bad() },
        template: { template: text(t.template), how: oneOf(t.how, 'all', 'zip'), lists: Object.fromEntries(Object.entries(lists).slice(0, 20).map(([k, v]) => [k.slice(0, 40), text(v)])) },
      };
      const id = (d.db.prepare('select id from preset where name=?').get(name) as { id: string } | undefined)?.id ?? randomUUID();
      d.db.prepare('insert into preset(id,name,json,updated_at) values(?,?,?,?) on conflict(name) do update set json=excluded.json, updated_at=excluded.updated_at').run(id, name, JSON.stringify(p), d.clock.now());
      return { id };
    },
    async deletePreset(a: unknown) { d.db.prepare('delete from preset where id=?').run(str(a)); },
    async startBatch(a: unknown) { const id = str(a); mut(id, () => { d.db.prepare('update batch set start_at=null where id=?').run(id); d.runner.start(id); }); }, // started: no time left to wait for
    async scheduleBatch(a: unknown) { // Hẹn giờ / Huỷ hẹn giờ on a batch that has not started
      const o = obj(a), id = str(o.batchId), at = o.at === null ? null : startAtOf(o.at, d.clock.now());
      mut(id, () => setStart(d.db, id, at));
    },
    async pauseBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.pause(id)); },
    async resumeBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.resume(id)); },
    async stopBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.stop(id)); },
    async archiveBatch(a: unknown) { // the renderer asks twice; main refuses without the second answer
      const o = obj(a), id = str(o.batchId);
      if (o.confirm !== true) bad();
      mut(id, () => d.runner.archive(id));
    },
    async resetAssetBinding(a: unknown) { // the user's way out of a stuck uncertain upload: forget the old attempt so the next prepare uploads again (they checked the Flow library first)
      const o = obj(a), assetId = str(o.assetId);
      if (o.confirm !== true) bad();
      const projects = await d.projects();
      if (!projects.length) throw Object.assign(new Error('NO_PROJECT_TAB'), { code: 'NO_PROJECT_TAB' });
      for (const p of projects) d.db.prepare('delete from asset_binding where asset_id=? and project_id=?').run(assetId, p); // every granted project: the stuck batch is in one of them
    },
    async rerun(a: unknown) { // spends credit again: only with the user's explicit cost confirmation
      const o = obj(a), id = str(o.attemptId);
      if (o.confirmCost !== true) bad();
      const batch = batchOf(id);
      let n = '';
      mut(batch, () => { n = d.runner.rerun(id, true); });
      return { attemptId: n };
    },
    async confirmUncertain(a: unknown) {
      const o = obj(a), id = str(o.attemptId), to = oneOf(o.to, 'sent', 'not_sent');
      mut(batchOf(id), () => d.runner.confirm(id, to));
    },
    async downloadBatch(a: unknown) { // every output of the batch that is not saved yet; never generates anything
      const id = str(a);
      await d.downloader.batch(id);
      d.emit('batch', id);
    },
    async retryDownload(a: unknown) { // the user's Thử lại on one output
      const o = obj(a), attemptId = str(o.attemptId), mediaId = str(o.mediaId);
      await d.downloader.retry(attemptId, mediaId);
      d.emit('batch', batchOf(attemptId));
    },
    async previewOutput(a: unknown) { // a saved file as a data URL for the S4 thumbnail; nothing is shown before it is on disk
      const o = obj(a), path = d.downloader.file(str(o.attemptId), str(o.mediaId));
      const st = statSync(path), key = `${path}|${st.size}|${st.mtimeMs}`, hit = previews.get(key);
      if (hit && o.play !== true) { previews.delete(key); previews.set(key, hit); return hit; } // kept: decoding a full-size image again costs 20-50 ms of the main process each time
      const buf = readFileSync(path);
      // shortcut: a video goes to the player as one data URL, only on the user's "Xem video" and only up to 64 MB (Flow's 8 s clips are 1-4 MB); serve it through a file protocol when clips get long
      if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return { url: o.play === true && buf.length <= 64_000_000 ? `data:video/mp4;base64,${buf.toString('base64')}` : null, video: true };
      const mime = sniff(buf.subarray(0, 12));
      if (!mime || !(mime in EXT)) throw Object.assign(new Error('DOWNLOAD_NOT_IMAGE'), { code: 'DOWNLOAD_NOT_IMAGE' });
      const small = d.thumb(buf);
      const out = { url: small ? `data:image/jpeg;base64,${small.toString('base64')}` : `data:${mime};base64,${buf.toString('base64')}` }; // the full file only when it cannot be shrunk
      if (small) { previews.set(key, out); if (previews.size > PREVIEWS_KEPT) previews.delete(previews.keys().next().value!); } // a full file is not kept: too big
      return out;
    },
    async revealOutput(a: unknown) { const o = obj(a); d.reveal(d.downloader.file(str(o.attemptId), str(o.mediaId))); }, // opens the OS file manager on the saved file
    async getUpdate() { return d.updates?.get() ?? { state: 'off', current: '' }; },
    async checkUpdate() { return d.updates ? d.updates.check() : { state: 'off', current: '' }; }, // the user's "Kiểm tra bản mới"
    async installUpdate() { if (!d.updates) bad(); d.updates!.install(); }, // BATCH_RUNNING while a batch is sending
    async openExtensionFolder() { d.openExtensionFolder?.(); }, // the folder the user picks in Chrome's Load unpacked
    async useTabs(a: unknown) { // validates against the last listing; session-only
      if (Array.isArray(a) && a.length > d.runner.caps().tabs) throw Object.assign(new Error('TOO_MANY_TABS'), { code: 'TOO_MANY_TABS' }); // a tab over the speed cap would never run, and its project's part of a batch would wait forever
      d.grants.use(a);
    },
    async enableAuto(a: unknown) {
      if (obj(a ?? {}).ack !== true) throw Object.assign(new Error('ACK_REQUIRED'), { code: 'ACK_REQUIRED' });
      const all = await accounts();
      if (!all.length) throw Object.assign(new Error('NO_ACCOUNT'), { code: 'NO_ACCOUNT' });
      for (const e of all) enableAuto(d.db, e, d.clock.now()); // one acknowledged warning covers the accounts the user granted right now
    },
    async disableAuto() { for (const e of await accounts()) disableAuto(d.db, e); },
    async listBatches() {
      return { batches: viewBatches(d.db).map((b) => ({ ...b, pauseReason: d.runner.lastError(b.id) })), session: await d.session() };
    },
    async getBatch(a: unknown) { const rev = d.emit.revision(); const id = str(a); return { ...view(d.db, id), pauseReason: d.runner.lastError(id), revision: rev }; }, // rev read first: never newer than the data
  };
}
export type Handlers = ReturnType<typeof createHandlers>;

export function registerIpc(ipc: Pick<IpcMain, 'handle'>, h: Record<string, (a: never) => unknown>): void {
  for (const [ch, fn] of Object.entries(h)) ipc.handle(ch, (_e, arg) => (fn as (a: unknown) => unknown)(arg));
}
