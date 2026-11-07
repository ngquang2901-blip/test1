import { test, expect } from 'vitest';
import { parseRpcResponse, readFReq, correlate, parseGenerateRequest, parseImageReceipt, parseVideoReceipt } from '@toolflow/flow-protocol/parse';
import { createFakeDriver } from '../src/main/fake-driver';
import { ConnectorError, type DriverEvent } from '../src/main/driver';

const PROMPT = 'Phở "bò" Hà Nội';
const CLICK = { found: true, disabled: false, listeners: 1, called: 1 };
const events = async (script: Parameters<typeof createFakeDriver>[0], kind: 'image' | 'video' = 'image') => {
  const d = createFakeDriver(script);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind, settings: {}, refIds: [] });
  expect(await d.click('t1', 1)).toEqual(CLICK);
  await new Promise((r) => setTimeout(r, 5));
  return { d, got };
};
const pair = (got: DriverEvent[]) => {
  const [sent, response] = got as [Extract<DriverEvent, { type: 'sent' }>, Extract<DriverEvent, { type: 'response' }>];
  expect(sent.type).toBe('sent');
  expect(response.type).toBe('response');
  const req = parseGenerateRequest(readFReq(sent.request as string));
  const payload = (parseRpcResponse(response.text, response.rpc) as { payload: unknown }).payload;
  return { req, payload };
};

test('image-ok: sent then response; receipt is owned and prompt is the attempt prompt', async () => {
  const { d, got } = await events(['image-ok']);
  const { req, payload } = pair(got);
  expect(req.items[0].prompt).toBe(PROMPT);
  const rec = parseImageReceipt(payload);
  expect(correlate(req, rec).owned).toBe(true);
  expect(rec.outputs[0].prompt).toBe(PROMPT);
  expect(d.ledger.clicks).toBe(1);
});

test('video-ok: parseVideoReceipt reads it and correlates', async () => {
  const { got } = await events(['video-ok']);
  const { req, payload } = pair(got);
  expect(req.items[0].prompt).toBe(PROMPT);
  const rec = parseVideoReceipt(payload);
  expect(correlate(req, rec).owned).toBe(true);
  expect(rec.operations[0].prompt).toBe(PROMPT);
});

test('throttled: response carries the throttle reason', async () => {
  const { got } = await events(['throttled']);
  const r = got[1] as Extract<DriverEvent, { type: 'response' }>;
  expect((parseRpcResponse(r.text, r.rpc) as { error: { reasons: string[] } }).error.reasons).toContain('PUBLIC_ERROR_USER_REQUESTS_THROTTLED');
});

test('no-request: click resolves, no events', async () => {
  const { got } = await events(['no-request']);
  expect(got).toEqual([]);
});

test('drop: click throws ConnectorError and emits disconnected; past end throws', async () => {
  const d = createFakeDriver(['drop']);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await expect(d.click('t1', 1)).rejects.toBeInstanceOf(ConnectorError);
  await new Promise((r) => setTimeout(r, 5));
  expect(got).toEqual([{ tabId: 't1', type: 'disconnected' }]);
  expect(d.ledger.clicks).toBe(1);
  await expect(d.click('t1', 2)).rejects.toThrow();
});

test('ping, prepare, checkBeforeClick, readProject, ledger', async () => {
  const d = createFakeDriver([]);
  expect(await d.ping('t1')).toMatchObject({ version: '0.0.0-fake', email: 'fake@example.invalid' });
  await d.prepare('t1', { prompt: 'x', kind: 'image', settings: {}, refIds: [] });
  expect(await d.checkBeforeClick('t1', 'p')).toEqual({ ok: true });
  expect(await d.readProject('p')).toMatch(/^\)\]\}'/);
  expect(d.ledger).toEqual({ clicks: 0, prepares: 1, readProject: 1 });
});

test('throttled after a video prepare: video request + YhhmEf throttle response', async () => {
  const { got } = await events(['throttled'], 'video');
  const [sent, r] = got as [Extract<DriverEvent, { type: 'sent' }>, Extract<DriverEvent, { type: 'response' }>];
  expect(parseGenerateRequest(readFReq(sent.request as string)).rpc).toBe('YhhmEf');
  expect(r.rpc).toBe('YhhmEf');
  expect((parseRpcResponse(r.text, r.rpc) as { error: { reasons: string[] } }).error.reasons).toContain('PUBLIC_ERROR_USER_REQUESTS_THROTTLED');
});

test('image-ok rotates distinct fixture pairs, then throws; script is not mutated', async () => {
  const script: Parameters<typeof createFakeDriver>[0] = ['image-ok', 'image-ok', 'image-ok', 'image-ok'];
  const d = createFakeDriver(script);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'image', settings: {}, refIds: [] });
  for (let i = 0; i < 3; i++) await d.click('t1', i + 1);
  await new Promise((r) => setTimeout(r, 5));
  const ids = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const { req, payload } = pair(got.slice(i * 2, i * 2 + 2));
    expect(correlate(req, parseImageReceipt(payload)).owned).toBe(true);
    ids.add(req.batchId);
  }
  expect(ids.size).toBe(3);
  await expect(d.click('t1', 4)).rejects.toThrow('fake: no more distinct fixture pairs for image-ok');
  expect(script).toHaveLength(4);
});
