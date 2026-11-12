import Database from 'better-sqlite3';

export type Db = Database.Database;

const MIGRATIONS = [
  `create table batch(id text primary key, kind text not null, target_project text, settings_json text not null,
     status text not null, stop_requested integer not null default 0, archived integer not null default 0,
     created_at integer not null, revision integer not null default 0);
   create table item(id text primary key, batch_id text not null references batch(id), ord integer not null,
     source_line integer, prompt text not null, refs_json text not null, attempt_id text);
   create table attempt(id text primary key, item_id text not null references item(id), ordinal integer not null,
     state_json text not null, tab_id integer, click_at integer, reconcile_at integer,
     revision integer not null default 0, source_attempt_id text);
   create table journal_event(id integer primary key autoincrement, attempt_id text not null references attempt(id),
     type text not null, at integer not null, payload_json text not null);
   create table target_block(project_id text primary key, attempt_id text not null, since integer not null);
   create table account_setting(email text primary key, auto_enabled integer not null default 0, ack_at integer);
   create table command(id text primary key, result_json text);`,
  `create table asset(id text primary key, path text not null, sha256 text not null, bytes integer not null, mime text not null,
     name text not null, created_at integer not null);
   create table asset_binding(asset_id text not null, project_id text not null, upload_name text not null, media_id text,
     state text not null check(state in ('uploading','bound','uncertain')), intent_at integer not null, primary key(asset_id, project_id));`,
  // one row per output file: planned_name is fixed at the intent, actual_name is where it really landed (never an overwrite)
  `create table download(id text primary key, attempt_id text not null, media_id text not null, planned_name text not null,
     state text not null check(state in ('intent','started','completed','failed','needs_review')), handle text, actual_name text, bytes integer,
     error_code text, created_at integer not null, updated_at integer not null, unique(attempt_id, media_id));`,
  // saved batch setups ("Mẫu lô"): kind, mode, refs and the prompt template; never prompts already sent or anything about Flow
  `create table preset(id text primary key, name text not null unique, json text not null, updated_at integer not null);`,
  // saved node workflows (the canvas graph only: node texts, asset ids, wires)
  `create table workflow(id text primary key, name text not null unique, json text not null, updated_at integer not null);`,
  // which site a batch is sent to: 'flow' (Google Flow, target_project = its project) or 'chatgpt' (no project; its own runner)
  `alter table batch add column provider text not null default 'flow';`,
  // indexes: without them every loop (runner 5x a second, auto save, the change scan, the batch list) read every row of the history
  // (measured: 300 batches of 10 prompts, the batch list took 13 s on the main process)
  `create index item_batch on item(batch_id, ord);
   create index item_attempt on item(attempt_id);
   create index attempt_item on attempt(item_id, ordinal);
   create index attempt_state on attempt(json_extract(state_json, '$.item'));
   create index attempt_reconcile on attempt(reconcile_at) where reconcile_at is not null;
   create index journal_attempt on journal_event(attempt_id, id);`,
];

export function openDb(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  const v = db.pragma('user_version', { simple: true }) as number;
  MIGRATIONS.slice(v).forEach((sql, i) => db.transaction(() => { db.exec(sql); db.pragma(`user_version = ${v + i + 1}`); })());
  return db;
}
