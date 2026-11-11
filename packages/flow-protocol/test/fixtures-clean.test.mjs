import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The desktop app bundles some of these captures (fake driver), so they must not carry anything of the account they were made on.
test('fixtures carry no account data: the scrub script finds nothing left to replace', () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/scrub-fixtures.mjs', import.meta.url)), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `run "node scripts/scrub-fixtures.mjs" in packages/flow-protocol\n${r.stdout}${r.stderr}`);
});
