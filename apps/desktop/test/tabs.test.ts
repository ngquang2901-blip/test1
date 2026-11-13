import { expect, test } from 'vitest';
import { createGrants, projectIdOf, tabStatus } from '../src/main/tabs';
import { openDb, type Db } from '../src/main/db';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowTab } from '../src/main/driver';

const U = '0b4d3c1e-1111-4222-8333-444455556666';
const tab = (o: Partial<FlowTab> = {}): FlowTab => ({ tabId: '1', projectId: U, email: 'a@b.c', active: false, ...o });

test('tabStatus: three branches, home before login', () => {
  expect(tabStatus(tab())).toBe('ok');
  expect(tabStatus(tab({ projectId: null }))).toBe('no_project');
  expect(tabStatus(tab({ email: null }))).toBe('no_login');
  expect(tabStatus(tab({ projectId: null, email: null }))).toBe('no_project');
});

test('projectIdOf takes only a /project/<uuid> path', () => {
  expect(projectIdOf(`/fx/tools/flow/project/${U}`)).toBe(U);
  expect(projectIdOf(`/project/${U}/`)).toBe(U);
  expect(projectIdOf('/fx/tools/flow')).toBeNull();
  expect(projectIdOf('/project/not-a-uuid')).toBeNull();
});

function rig(list: FlowTab[]) {
  const set: string[][] = [];
  let tabs = list;
  const g = createGrants({ listTabs: async () => tabs }, { setTabs: (ids) => set.push(ids) });
  return { g, set, show: (l: FlowTab[]) => { tabs = l; } };
}

test('use() grants only tabs from the last listing that are ok; nothing is granted before', async () => {
  const r = rig([tab({ tabId: '1' }), tab({ tabId: '2', projectId: null }), tab({ tabId: '3', email: null })]);
  expect(r.g.has('1')).toBe(false);
  expect(() => r.g.use(['1'])).toThrow(/INVALID_ARGS/); // never listed
  await r.g.list();
  for (const bad of [['9'], ['2'], ['3'], [1 as never], 'x' as never]) expect(() => r.g.use(bad)).toThrow(/INVALID_ARGS/);
  expect(r.set.flat()).toEqual([]); // listing grants nothing by itself
  r.g.use(['1']);
  expect(r.set.at(-1)).toEqual(['1']);
  expect([r.g.has('1'), r.g.has('2')]).toEqual([true, false]);
});

test('list() revokes a grant whose tab is gone or no longer ok', async () => {
  const r = rig([tab({ tabId: '1' })]);
  await r.g.list(); r.g.use(['1']);
  r.show([tab({ tabId: '1', projectId: null })]);
  await r.g.list();
  expect(r.g.has('1')).toBe(false);
  expect(r.set.at(-1)).toEqual([]);
});

test('projects() are the granted tabs\' distinct projects in grant order; projectOf() reads the last listing', async () => {
  const V = '0b4d3c1e-9999-4222-8333-444455556666';
  const r = rig([tab({ tabId: '1', projectId: U }), tab({ tabId: '2', projectId: V }), tab({ tabId: '3', projectId: V })]);
  expect(r.g.projects()).toEqual([]);
  await r.g.list();
  expect(r.g.projects()).toEqual([]); // listed but not granted
  expect(r.g.projectOf('2')).toBe(V);
  r.g.use(['2', '1', '3']);
  expect(r.g.projects()).toEqual([V, U]); // two tabs on V count once
  expect(r.g.projectOf('9')).toBeNull();
});

// Remembered by (account, project): a tab id changes after a Chrome restart, so the same pair seen again is granted by itself.
const V = '0b4d3c1e-9999-4222-8333-444455556666';
function remembering(db: Db, list: FlowTab[], cap = 1) {
  const set: string[][] = [];
  let tabs = list;
  const g = createGrants({ listTabs: async () => tabs }, { setTabs: (ids) => set.push(ids) }, { db, cap: () => cap });
  return { g, set, show: (l: FlowTab[]) => { tabs = l; } };
}
const tmpDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));

test('a granted tab is remembered: after a restart (new tab id, same account and project) it is granted again by itself and marked so', async () => {
  const db = tmpDb();
  const a = remembering(db, [tab({ tabId: 'x:1' })]);
  await a.g.list(); a.g.use(['x:1']);
  expect(a.g.isAuto('x:1')).toBe(false); // the user's own click
  const b = remembering(db, [tab({ tabId: 'y:9', email: null }), tab({ tabId: 'y:7' })]); // Chrome restarted: other ids, one tab not logged in yet
  expect(b.g.granted()).toEqual([]);
  await b.g.list();
  expect(b.g.granted()).toEqual(['y:7']);
  expect(b.g.isAuto('y:7')).toBe(true);
  expect(b.set.at(-1)).toEqual(['y:7']);
  expect(b.g.remembered()).toBe(1);
});

test('never a tab of another account or another project; one tab per remembered pair, up to the speed cap; a tab the user did not choose is left alone', async () => {
  const db = tmpDb();
  const a = remembering(db, [tab({ tabId: '1' }), tab({ tabId: '2', projectId: V, email: 'x@y.z' })], 4);
  await a.g.list(); a.g.use(['1', '2']);
  const b = remembering(db, [tab({ tabId: '3', projectId: V }), tab({ tabId: '4', email: 'x@y.z' }), tab({ tabId: '5' }), tab({ tabId: '6' }), tab({ tabId: '7', projectId: V, email: 'x@y.z' })], 1);
  await b.g.list();
  expect(b.g.granted()).toEqual(['5']); // 3: right project, wrong account; 4: right account, wrong project; 6: a second tab of the same pair; 7: over the cap of 1
  const c = remembering(db, [tab({ tabId: '3', projectId: V }), tab({ tabId: '4', email: 'x@y.z' }), tab({ tabId: '5' }), tab({ tabId: '6' }), tab({ tabId: '7', projectId: V, email: 'x@y.z' })], 4);
  await c.g.list();
  expect(c.g.granted()).toEqual(['5', '7']);
});

test('the latest choice replaces the remembered set; un-granting forgets; "Quên" forgets everything; a tab that only went away is not forgotten', async () => {
  const db = tmpDb();
  const a = remembering(db, [tab({ tabId: '1' }), tab({ tabId: '2', projectId: V })], 4);
  await a.g.list(); a.g.use(['1', '2']);
  a.show([tab({ tabId: '2', projectId: V })]); await a.g.list(); // tab 1 closed: grant dropped, memory kept
  expect(a.g.granted()).toEqual(['2']);
  expect(a.g.remembered()).toBe(2);
  a.g.use([]); // the user lets the last one go
  expect(a.g.remembered()).toBe(0);
  a.show([tab({ tabId: '1' }), tab({ tabId: '2', projectId: V })]); await a.g.list();
  expect(a.g.granted()).toEqual([]);
  a.g.use(['1']); // remembered again: the next instance would pick tab 8
  const b = remembering(db, [tab({ tabId: '8' })]);
  b.g.forget();
  await b.g.list();
  expect(b.g.granted()).toEqual([]);
  const c = remembering(db, [tab({ tabId: '8' })]); // and after the next restart too
  await c.g.list();
  expect([c.g.granted(), c.g.remembered()]).toEqual([[], 0]);
});
