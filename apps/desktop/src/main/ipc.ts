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
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { copyInto, csv, writeInto } from './export';
import type { Updates } from './updates';
import { randomUUID } from 'node:crypto';

export type Draft = { text: string; kind: 'image' | 'video'; mode: 'auto' | 'manual'; speed: 'default' | 'fast'; autoSave: boolean };
export type StateEvent = { entity: 'batch'; id: string; revision: number };
export type Emit = ((entity: 'batch', id: string) => void) & { revision(): number };
export type Deps = {
  db: Db; runner: Runner; grants: Pick<Grants, 'use'>; projects(): string[] | Promise<string[]>; clock: { now(): number }; // projects: distinct projects of the granted tabs
  email(): Promise<string | null>; emails?(): Promise<string[]>; session(): Promise<object>; pickPaths(): Promise<string[]>; getDraft(): Draft; saveDraft(d: Draft): void; emit: Emit; // emails: every account of the granted tabs (absent ⇒ just email())
  downloader: Pick<Downloader, 'batch' | 'retry' | 'file'>; reveal(path: string): void; openExtensionFolder?(): void; updates?: Pick<Updates, 'get' | 'check' | 'install'>;
  thumb(file: Buffer): Buffer | null; // a small JPEG of an image file, null when it is small already or cannot be decoded
  trash?(path: string): Promise<void>; // Kết quả's Xoá: a saved file goes to the Recycle Bin (shell.trashItem), never deleted for good
  pickFolder?(): Promise<string | null>; // Kết quả's Xuất file: the folder the user picks, null = cancelled
};

const MAX_TEXT = 1_000_000;
type Preset = { kind: 'image' | 'video'; mode: 'auto' | 'manual'; combo?: object; refs: { assetIds: string[]; mode: string; perItem: number }; template: { template: string; how: 'all' | 'zip'; lists: Record<string, string> } };
const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }); };
const str = (v: unknown): string => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : bad());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad());
const oneOf = <T extends string>(v: unknown, ...ok: T[]): T => (ok.includes(v as T) ? (v as T) : bad());
const MODES = ['none', 'all', 'sequential', 'start'] as const;
const text = (v: unknown): string => (typeof v === 'string' && v.length <= MAX_TEXT ? v : bad());
const coded = (code: string): Error => Object.assign(new Error(code), { code });
const MAX_OUTPUTS = 20_000, MAX_TAGS = 20;
const tagText = (v: unknown): string => { const t = typeof v === 'string' ? v.trim() : ''; return t && t.length <= 30 && !/[\u0000-\u001f\u007f]/.test(t) ? t : bad(); };
const SITE: Record<string, string> = { flow: 'Flow', chatgpt: 'ChatGPT', gemini: 'Gemini' };
type Out = { attemptId: string; mediaId: string; prompt: string; line: number; batchId: string; provider: string; kind: string };

/** Monotonic revision stamped in main; the renderer drops older ones. */
export function revisioned(send: (e: StateEvent) => void): Emit {
  let rev = 0;
  return Object.assign((entity: 'batch', id: string) => send({ entity, id, revision: ++rev }), { revision: () => rev });
}

export const DEFAULT_DRAFT: Draft = { text: '', kind: 'image', mode: 'auto', speed: 'default', autoSave: true };
// Validates only the fields present; throws INVALID_ARGS on a bad one.
const draftPatch = (a: unknown): Partial<Draft> => {
  const o = obj(a), p: Partial<Draft> = {};
  if (o.text !== undefined) p.text = text(o.text);
  if (o.kind !== undefined) p.kind = oneOf(o.kind, 'image', 'video');
  if (o.mode !== undefined) p.mode = oneOf(o.mode, 'auto', 'manual');
  if (o.speed !== undefined) p.speed = oneOf(o.speed, 'default', 'fast');
  if (o.autoSave !== undefined) p.autoSave = typeof o.autoSave === 'boolean' ? o.autoSave : bad();
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
  /** The outputs a Kết quả action names, each proven to be an output of that attempt (once each), with what the export needs. */
  const outputsArg = (v: unknown): Out[] => {
    const list = Array.isArray(v) && v.length > 0 && v.length <= MAX_OUTPUTS ? v : bad();
    const q = d.db.prepare('select a.state_json j, i.prompt, i.ord, b.id batchId, b.provider, b.kind from attempt a join item i on i.id=a.item_id join batch b on b.id=i.batch_id where a.id=?');
    const seen = new Map<string, Out>();
    for (const x of list) {
      const o = obj(x), attemptId = str(o.attemptId), mediaId = str(o.mediaId);
      const r = (q.get(attemptId) as { j: string; prompt: string; ord: number; batchId: string; provider: string; kind: string } | undefined) ?? bad();
      if (!((JSON.parse(r.j).outputs ?? []) as { mediaId: string }[]).some((m) => m.mediaId === mediaId)) bad();
      seen.set(`${attemptId}:${mediaId}`, { attemptId, mediaId, prompt: r.prompt, line: r.ord + 1, batchId: r.batchId, provider: r.provider, kind: r.kind });
    }
    return [...seen.values()];
  };
  const tagsOf = (x: Out): string[] => JSON.parse((d.db.prepare('select tags_json t from output_mark where attempt_id=? and media_id=?').get(x.attemptId, x.mediaId) as { t: string } | undefined)?.t ?? '[]');
  const touched = (outs: Out[]): void => new Set(outs.map((x) => x.batchId)).forEach((b) => d.emit('batch', b));
  const batchOf = (attemptId: string) => (d.db.prepare('select i.batch_id b from attempt a join item i on i.id=a.item_id where a.id=?').get(attemptId) as { b: string } | undefined)?.b ?? bad();
  return {
    async saveDraft(a: unknown) {
      d.saveDraft({ ...d.getDraft(), ...draftPatch(a) }); // merge: a speed-only save must not clobber the text
    },
    async enqueueBatch(a: unknown) {
      const o = obj(a);
      const commandId = str(o.commandId), kind = oneOf(o.kind, 'image', 'video'), mode = oneOf(o.mode, 'auto', 'manual'), src = text(o.text);
      const provider = o.provider === undefined ? 'flow' : oneOf(o.provider, 'flow', 'chatgpt', 'gemini');
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
      made.forEach((r) => d.emit('batch', r.batchId));
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
    async startBatch(a: unknown) { const id = str(a); mut(id, () => d.runner.start(id)); },
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
    async tagOutputs(a: unknown) { // the user's Gắn thẻ / Gỡ thẻ on the outputs picked in Kết quả
      const o = obj(a), outs = outputsArg(o.outputs);
      if ((o.add === undefined) === (o.remove === undefined)) bad();
      const add = o.add === undefined ? null : tagText(o.add), remove = o.remove === undefined ? null : tagText(o.remove);
      const put = d.db.prepare('insert into output_mark(attempt_id, media_id, tags_json) values(?,?,?) on conflict(attempt_id, media_id) do update set tags_json=excluded.tags_json');
      d.db.transaction(() => {
        for (const x of outs) {
          const tags = tagsOf(x), next = add ? (tags.includes(add) ? tags : [...tags, add]) : tags.filter((t) => t !== remove);
          if (next.length > MAX_TAGS) throw coded('TAG_LIMIT'); // nothing is tagged: the whole selection or none
          put.run(x.attemptId, x.mediaId, JSON.stringify(next));
        }
      })();
      touched(outs);
    },
    async deleteOutputs(a: unknown) { // the user's Xoá in Kết quả, asked twice; files go to the Recycle Bin, nothing is sent to Flow or any site
      const o = obj(a), outs = outputsArg(o.outputs);
      if (o.confirm !== true || !d.trash) bad();
      const r = { deleted: 0, trashed: 0, missing: 0, failed: 0 };
      const saved = d.db.prepare("select 1 from download where attempt_id=? and media_id=? and state='completed'");
      const hide = d.db.prepare('insert into output_mark(attempt_id, media_id, deleted_at) values(?,?,?) on conflict(attempt_id, media_id) do update set deleted_at=excluded.deleted_at');
      for (const x of outs) {
        if (saved.get(x.attemptId, x.mediaId)) {
          let path: string | null = null;
          try { path = d.downloader.file(x.attemptId, x.mediaId); } catch (e) { if ((e as { code?: string }).code !== 'NOT_FOUND') { r.failed++; continue; } } // PATH_ESCAPE: not ours to move
          if (!path) r.missing++;
          else try { await d.trash!(path); r.trashed++; } catch { r.failed++; continue; } // the file is still there, so the output stays shown
        }
        hide.run(x.attemptId, x.mediaId, d.clock.now());
        r.deleted++;
      }
      touched(outs);
      return r;
    },
    async exportOutputs(a: unknown) { // copies of the saved files + toolflow-export.csv in a folder the user picks; the originals stay where they are
      const outs = outputsArg(obj(a).outputs);
      const files = outs.flatMap((x) => { try { return [{ x, path: d.downloader.file(x.attemptId, x.mediaId) }]; } catch { return []; } }); // not saved, or the file is gone
      const skipped = outs.length - files.length;
      if (!files.length) return { copied: 0, skipped, csv: null };
      const dir = d.pickFolder ? await d.pickFolder() : bad();
      if (!dir) return { canceled: true };
      mkdirSync(dir, { recursive: true });
      const at = d.db.prepare('select updated_at u from download where attempt_id=? and media_id=?');
      const rows = files.map(({ x, path }) => [copyInto(path, dir, basename(path)), x.prompt, SITE[x.provider] ?? x.provider, x.kind === 'video' ? 'Video' : 'Ảnh', x.batchId, x.line, tagsOf(x).join('; '),
        new Date((at.get(x.attemptId, x.mediaId) as { u: number }).u).toLocaleString('sv-SE')]); // sv-SE: 2026-11-13 09:30:00, which Excel reads as a date
      const name = writeInto(dir, 'toolflow-export.csv', csv([['Tên tệp', 'Prompt', 'Nền tảng', 'Loại', 'Mã lô', 'Dòng', 'Thẻ', 'Lưu lúc'], ...rows]));
      return { copied: files.length, skipped, csv: name };
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
