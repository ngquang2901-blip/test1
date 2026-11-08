import { randomUUID } from 'node:crypto';
import { initial } from '@toolflow/flow-protocol/attempt';
import type { Db } from './db';

export function parsePrompts(input: string | Uint8Array) {
  const items: { sourceLine: number; prompt: string }[] = [];
  const errors: { line: number; code: 'INVALID_UTF8' }[] = [];
  let lines: string[];
  if (typeof input === 'string') lines = input.split(/\r\n|\n/);
  else {
    // ignoreBOM: true so only the very start of the file loses its BOM (stripped below)
    const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    lines = [];
    let start = 0;
    for (let i = 0; i <= input.length; i++) {
      if (i < input.length && input[i] !== 0x0a) continue;
      try {
        lines.push(dec.decode(input.subarray(start, i)).replace(/\r$/, ''));
      } catch {
        errors.push({ line: lines.length + 1, code: 'INVALID_UTF8' });
        lines.push('');
      }
      start = i + 1;
    }
  }
  if (errors.length) return { items: [], errors };
  if (lines[0]?.startsWith('\uFEFF')) lines[0] = lines[0].slice(1);
  lines.forEach((prompt, i) => { if (prompt.trim() !== '') items.push({ sourceLine: i + 1, prompt }); });
  return { items, errors };
}

export function mapRefs(count: number, pool: string[], mode: 'none' | 'all' | 'sequential' | 'start', perItem: number) {
  const errors: { index: number; code: 'NOT_ENOUGH_REFS' | 'TOO_MANY_REFS' }[] = [];
  const refs = Array.from({ length: count }, (_, i): string[] => {
    if (mode === 'none') return [];
    if (mode === 'all') {
      if (pool.length <= perItem) return [...pool];
      errors.push({ index: i, code: 'TOO_MANY_REFS' });
      return [];
    }
    const n = mode === 'start' ? 1 : perItem;
    const slice = pool.slice(i * n, (i + 1) * n);
    if (slice.length < n) { errors.push({ index: i, code: 'NOT_ENOUGH_REFS' }); return []; }
    return slice;
  });
  return { refs, errors };
}

export function enqueueBatch(
  db: Db,
  cmd: { commandId: string; kind: 'image' | 'video'; projectId: string; settings: object; prompts: string[]; refs: string[][]; mode: 'auto' | 'manual'; sourceLines?: number[] },
): { batchId: string; revision: number } {
  if (cmd.prompts.length !== cmd.refs.length) throw new Error('prompts/refs length mismatch');
  if (cmd.sourceLines && cmd.sourceLines.length !== cmd.prompts.length) throw new Error('prompts/sourceLines length mismatch');
  return db.transaction(() => {
    const prev = db.prepare('select result_json r from command where id=?').get(cmd.commandId) as { r: string } | undefined;
    if (prev) return JSON.parse(prev.r);
    const batchId = randomUUID();
    db.prepare("insert into batch(id,kind,target_project,settings_json,status,created_at,revision) values(?,?,?,?,'queued',?,1)")
      .run(batchId, cmd.kind, cmd.projectId, JSON.stringify({ ...cmd.settings, mode: cmd.mode }), Date.now());
    cmd.prompts.forEach((prompt, i) => {
      const itemId = randomUUID();
      const attemptId = randomUUID();
      db.prepare('insert into item(id,batch_id,ord,source_line,prompt,refs_json,attempt_id) values(?,?,?,?,?,?,?)')
        .run(itemId, batchId, i, cmd.sourceLines?.[i] ?? null, prompt, JSON.stringify(cmd.refs[i]), attemptId);
      db.prepare('insert into attempt(id,item_id,ordinal,state_json,revision) values(?,?,1,?,0)')
        .run(attemptId, itemId, JSON.stringify(initial(prompt)));
    });
    const result = { batchId, revision: 1 };
    db.prepare('insert into command(id,result_json) values(?,?)').run(cmd.commandId, JSON.stringify(result));
    return result;
  })();
}
