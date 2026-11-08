import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/main/db';
import { enqueueBatch } from '../src/main/batch';
import { createFakeDriver } from '../src/main/fake-driver';
import { createRunner } from '../src/main/runner';
import { profile } from '../src/main/profile';

// AC-18: the attempt keeps the config version it was sent with
test('intent journal payload carries the profile version at intent time', async () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'tf-')), 't.db'));
  const clock = { now: () => Date.now() };
  const fake = createFakeDriver(['image-ok']);
  const runner = createRunner({ db, driver: { ...fake, ping: async (t) => ({ ...(await fake.ping(t)), t: clock.now() }) }, clock, tabs: ['t1'], speed: 'default', autoAllowed: () => true });
  const { batchId } = enqueueBatch(db, { commandId: 'c', kind: 'image', projectId: 'p', settings: {}, mode: 'auto', prompts: ['a'], refs: [[]] });
  runner.start(batchId);
  for (let i = 0; i < 20; i++) { await runner.tick(); await new Promise((r) => setTimeout(r, 0)); }
  const rows = db.prepare("select payload_json p from journal_event where type='intent'").all() as { p: string }[];
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0].p).profileVersion).toBe(profile.version);
  expect(rows[0].p).not.toMatch(/selectors|rpc/); // version only, no config body
});
