import { expect, test } from 'vitest';
import { createGrants, projectIdOf, tabStatus } from '../src/main/tabs';
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
  expect(r.set).toEqual([]);
  r.g.use(['1']);
  expect(r.set).toEqual([['1']]);
  expect([r.g.has('1'), r.g.has('2')]).toEqual([true, false]);
});

test('list() revokes a grant whose tab is gone or no longer ok', async () => {
  const r = rig([tab({ tabId: '1' })]);
  await r.g.list(); r.g.use(['1']);
  r.show([tab({ tabId: '1', projectId: null })]);
  await r.g.list();
  expect(r.g.has('1')).toBe(false);
  expect(r.set).toEqual([['1'], []]);
});

test('projectId() is the first granted tab\'s project from the last listing; null when nothing is granted', async () => {
  const r = rig([tab({ tabId: '1', projectId: U }), tab({ tabId: '2', projectId: '0b4d3c1e-9999-4222-8333-444455556666' })]);
  expect(r.g.projectId()).toBeNull();
  await r.g.list();
  expect(r.g.projectId()).toBeNull(); // listed but not granted
  r.g.use(['2', '1']);
  expect(r.g.projectId()).toBe('0b4d3c1e-9999-4222-8333-444455556666');
});
