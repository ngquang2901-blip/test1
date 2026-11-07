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
