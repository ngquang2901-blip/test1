import { test, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttemptState } from '@toolflow/flow-protocol/attempt'
import { openDb } from '../src/main/db'
import { enqueueBatch } from '../src/main/batch'
import { createAutoSaver } from '../src/main/autosave'

function rig(o: { on?: boolean } = {}) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-as-')), 't.db'))
  const clock = { t: 1_800_000_000_000 }
  const calls: string[] = []
  let on = o.on ?? true
  const saver = createAutoSaver({ db, now: () => clock.t, enabled: () => on, downloader: { batch: async (b) => { calls.push(b) } } })
  const add = (provider: 'flow' | 'chatgpt' | 'gemini', id: string): string => enqueueBatch(db, { commandId: id, kind: 'image', provider, projectId: provider === 'flow' ? 'p1' : null, settings: { provider }, prompts: ['a', 'b'], refs: [[], []], mode: 'auto' }).batchId
  const attempts = (b: string): string[] => (db.prepare('select attempt_id a from item where batch_id=? order by ord').all(b) as { a: string }[]).map((r) => r.a)
  const ready = (a: string, media: string[], at = clock.t): void => { db.prepare('insert into journal_event(attempt_id,type,at,payload_json) values(?,?,?,?)').run(a, 'receipt', at, '{}'); const s = JSON.parse((db.prepare('select state_json j from attempt where id=?').get(a) as { j: string }).j) as AttemptState; db.prepare('update attempt set state_json=? where id=?').run(JSON.stringify({ ...s, item: 'ready', stage: 'outcome_known', outputs: media.map((mediaId) => ({ mediaId })) }), a) }
  const dl = (a: string, m: string, state: string): void => { db.prepare("insert into download(id,attempt_id,media_id,planned_name,state,created_at,updated_at) values(?,?,?,?,?,?,?) on conflict(attempt_id,media_id) do update set state=excluded.state, updated_at=excluded.updated_at").run(`${a}:${m}`, a, m, 'x.png', state, clock.t, clock.t) }
  const tick = async (ms = 0): Promise<void> => { clock.t += ms; await saver.tick(); await new Promise((r) => setTimeout(r, 0)) }
  return { db, clock, calls, saver, add, attempts, ready, dl, tick, set: (v: boolean) => { on = v } }
}

test('a Flow batch saves its results by itself as they get ready: once per result, nothing for a result already saved or being saved, nothing for a chat-site batch (its runner saves in its own turn), nothing for an archived batch', async () => {
  const t = rig()
  const f = t.add('flow', 'f'), c = t.add('chatgpt', 'c'), [f1, f2] = t.attempts(f), [c1] = t.attempts(c)
  await t.tick()
  expect(t.calls).toEqual([]) // nothing ready yet
  t.ready(f1, ['m1', 'm2']); t.ready(c1, ['x1'])
  await t.tick()
  expect(t.calls).toEqual([f])
  await t.tick(60_000)
  expect(t.calls).toEqual([f]) // asked once: a save that never started is not asked for again and again
  t.dl(f1, 'm1', 'completed'); t.dl(f1, 'm2', 'started')
  t.ready(f2, ['m3'])
  await t.tick()
  expect(t.calls).toEqual([f, f]) // the new result
  const g = t.add('flow', 'g'); t.ready(t.attempts(g)[0], ['m9'])
  t.db.prepare('update batch set archived=1 where id=?').run(g)
  const old = t.add('flow', 'old'); t.ready(t.attempts(old)[0], ['m0'], t.clock.t - 3_600_000) // got ready before this app start: the user never asked for it
  await t.tick()
  expect(t.calls).toEqual([f, f])
})

test('switched off in Cài đặt: Flow results wait for the user\'s Tải; a save that failed is still tried again', async () => {
  const t = rig({ on: false })
  const f = t.add('flow', 'f'), [f1] = t.attempts(f)
  t.ready(f1, ['m1'])
  await t.tick()
  expect(t.calls).toEqual([])
  t.dl(f1, 'm1', 'failed')
  await t.tick(31_000)
  expect(t.calls).toEqual([f])
})

test('a save that failed is tried again by itself, 30 s later, twice at most; on any site; then it waits for the user\'s Thử lại', async () => {
  const t = rig()
  const g = t.add('gemini', 'g'), [g1] = t.attempts(g)
  t.ready(g1, ['x1'])
  t.dl(g1, 'x1', 'failed')
  await t.tick(10_000)
  expect(t.calls).toEqual([]) // not yet
  await t.tick(21_000)
  expect(t.calls).toEqual([g])
  await t.tick(5_000)
  expect(t.calls).toEqual([g]) // the row still says failed from before: not again at once
  t.dl(g1, 'x1', 'failed') // the second try failed too
  await t.tick(31_000)
  expect(t.calls).toEqual([g, g])
  t.dl(g1, 'x1', 'failed')
  await t.tick(120_000)
  expect(t.calls).toEqual([g, g]) // two tries were it
  t.dl(g1, 'x1', 'needs_review')
  await t.tick(120_000)
  expect(t.calls).toEqual([g, g]) // a save that needs a look is never retried here
})
