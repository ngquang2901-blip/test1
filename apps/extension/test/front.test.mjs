import test from 'node:test';
import assert from 'node:assert/strict';
import { frontOp } from '../ops.js';

// Chrome stand-in: records tab and window calls; the tab is on a site page.
const chromeWith = (state) => {
  const calls = [];
  return { calls, c: {
    tabs: { get: async () => ({ url: 'https://flow.google.com/project/x', windowId: 5 }), update: async (id, p) => { calls.push(['tab', p]); return { id, windowId: 5 }; } },
    windows: { get: async () => ({ id: 5, state }), update: async (id, p) => { calls.push(['win', p]); return { id }; } },
  } };
};

test('front without raise: the tab becomes the active one of its window, the window is left alone', async () => {
  const x = chromeWith('maximized');
  assert.equal(await frontOp(x.c, { tabId: 3 }), true);
  assert.deepEqual(x.calls, [['tab', { active: true }]]);
});

test('raise of a minimised window: restored and focused', async () => {
  const x = chromeWith('minimized');
  await frontOp(x.c, { tabId: 3, raise: true });
  assert.deepEqual(x.calls, [['tab', { active: true }], ['win', { state: 'normal', focused: true }]]);
});

// Measured on Windows (2026-11-24): a Chrome window merely covered by another app stays behind it on focused:true (the OS refuses a
// background app the foreground), so its page stays hidden; minimised and restored, it comes on top.
test('raise of a covered window: minimised, then put back in its own state and focused', async () => {
  for (const state of ['maximized', 'normal', 'fullscreen']) {
    const x = chromeWith(state);
    await frontOp(x.c, { tabId: 3, raise: true });
    assert.deepEqual(x.calls, [['tab', { active: true }], ['win', { state: 'minimized' }], ['win', { state, focused: true }]], state);
  }
});

test('front refuses a tab that is not a site tab', async () => {
  const x = chromeWith('normal'); x.c.tabs.get = async () => ({ url: 'https://example.com/' });
  await assert.rejects(frontOp(x.c, { tabId: 3, raise: true }), /NOT_SITE_TAB/);
  assert.deepEqual(x.calls, []);
});
