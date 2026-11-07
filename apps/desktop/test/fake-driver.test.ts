import { test, expect } from 'vitest';
import { parseRpcResponse, readFReq, parseGenerateRequest, parseImageReceipt, parseVideoReceipt } from '@toolflow/flow-protocol/parse';
import { createFakeDriver } from '../src/main/fake-driver';
import { ConnectorError, type DriverEvent } from '../src/main/driver';

const PROMPT = 'Phở "bò" Hà Nội';
const CLICK = { found: true, disabled: false, listeners: 1, called: 1 };
const events = async (script: Parameters<typeof createFakeDriver>[0]) => {
  const d = createFakeDriver(script);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'image', settings: {}, refIds: [] });
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
  const { correlate } = await import('@toolflow/flow-protocol/parse');
  expect(req.items[0].prompt).toBe(PROMPT);
  const rec = parseImageReceipt(payload);
  expect(correlate(req, rec).owned).toBe(true);
  expect(rec.outputs[0].prompt ?? PROMPT).toBe(PROMPT);
  expect(d.ledger.clicks).toBe(1);
});

test('video-ok: parseVideoReceipt reads it and correlates', async () => {
  const { got } = await events(['video-ok']);
  const { req, payload } = pair(got);
  const { correlate } = await import('@toolflow/flow-protocol/parse');
  expect(req.items[0].prompt).toBe(PROMPT);
  expect(correlate(req, parseVideoReceipt(payload)).owned).toBe(true);
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
