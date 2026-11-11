import { test, expect } from 'vitest';
import { parseRpcResponse, readFReq, correlate, parseGenerateRequest, parseImageReceipt, parseVideoReceipt } from '@toolflow/flow-protocol/parse';
import { classifyGenerateError } from '@toolflow/flow-protocol/errors';
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
  expect(response.request).toBe(sent.request); // R24: the response carries the request it answers
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
  const { got } = await events(['video-ok'], 'video');
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

test('blocked: the same kind of rejection with a content reason, which the product classifies as CONTENT_BLOCKED (ends the item, never resent)', async () => {
  const { got } = await events(['blocked']);
  const r = got[1] as Extract<DriverEvent, { type: 'response' }>;
  const { error } = parseRpcResponse(r.text, r.rpc) as { error: { grpc: number; reasons: string[] } };
  expect(error.reasons).toEqual(['PUBLIC_ERROR_UNSAFE_GENERATION']);
  expect(classifyGenerateError(error)).toMatchObject({ code: 'CONTENT_BLOCKED', admission: 'continue', resubmit: false });
  expect(parseGenerateRequest(readFReq((got[0] as Extract<DriverEvent, { type: 'sent' }>).request as string)).items[0].prompt).toBe(PROMPT);
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
  expect(d.ledger).toEqual({ clicks: 0, fetches: 0, prepares: 1, checks: 1, readProject: 1, arms: 0, uploads: [], refs: [], armLog: [] });
});

test('throttled after a video prepare: video request + YhhmEf throttle response', async () => {
  const { got } = await events(['throttled'], 'video');
  const [sent, r] = got as [Extract<DriverEvent, { type: 'sent' }>, Extract<DriverEvent, { type: 'response' }>];
  expect(parseGenerateRequest(readFReq(sent.request as string)).rpc).toBe('YhhmEf');
  expect(r.rpc).toBe('YhhmEf');
  expect((parseRpcResponse(r.text, r.rpc) as { error: { reasons: string[] } }).error.reasons).toContain('PUBLIC_ERROR_USER_REQUESTS_THROTTLED');
});

test('10 image-ok clicks: fresh owned batchIds, prompt preserved; script is not mutated', async () => {
  const script: Parameters<typeof createFakeDriver>[0] = Array(10).fill('image-ok');
  const d = createFakeDriver(script);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'image', settings: {}, refIds: [] });
  for (let i = 0; i < 10; i++) await d.click('t1', i + 1);
  await new Promise((r) => setTimeout(r, 5));
  const ids = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const { req, payload } = pair(got.slice(i * 2, i * 2 + 2));
    const rec = parseImageReceipt(payload);
    expect(correlate(req, rec).owned).toBe(true);
    expect(rec.outputs[0].prompt).toBe(PROMPT);
    expect(req.items[0].prompt).toBe(PROMPT);
    ids.add(req.batchId);
  }
  expect(ids.size).toBe(10);
  expect(script).toHaveLength(10);
});

test('video-ok, throttled (video), video-ok on one driver', async () => {
  const d = createFakeDriver(['video-ok', 'throttled', 'video-ok']);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'video', settings: {}, refIds: [] });
  for (let i = 0; i < 3; i++) await d.click('t1', i + 1);
  await new Promise((r) => setTimeout(r, 5));
  const [a, b, c] = [0, 1, 2].map((i) => pair(got.slice(i * 2, i * 2 + 2)));
  for (const x of [a, c]) expect(correlate(x.req, parseVideoReceipt(x.payload)).owned).toBe(true);
  expect(a.req.batchId).not.toBe(c.req.batchId);
  expect(b.req.rpc).toBe('YhhmEf');
  expect((got[3] as Extract<DriverEvent, { type: 'response' }>).rpc).toBe('YhhmEf');
  expect((parseRpcResponse((got[3] as Extract<DriverEvent, { type: 'response' }>).text, 'YhhmEf') as { error: { reasons: string[] } }).error.reasons).toContain('PUBLIC_ERROR_USER_REQUESTS_THROTTLED');
});

test('video-ok rotation never emits ingredients: t2v only, no refIds', async () => {
  const d = createFakeDriver(Array(4).fill('video-ok'));
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'video', settings: {}, refIds: [] });
  for (let i = 0; i < 4; i++) await d.click('t1', i + 1);
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 4; i++) {
    const { req } = pair(got.slice(i * 2, i * 2 + 2));
    expect(req.items.map((it) => it.refIds ?? [])).toEqual([[]]);
    expect((got[i * 2 + 1] as Extract<DriverEvent, { type: 'response' }>).rpc).not.toBe('MZZa6b');
  }
});

test('4 consecutive image-ok clicks all have 1 output', async () => {
  const d = createFakeDriver(Array(4).fill('image-ok'));
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'image', settings: {}, refIds: [] });
  for (let i = 0; i < 4; i++) await d.click('t1', i + 1);
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 4; i++) {
    const { req, payload } = pair(got.slice(i * 2, i * 2 + 2));
    expect(req.items).toHaveLength(1);
    expect(parseImageReceipt(payload).outputs).toHaveLength(1);
  }
});

test('click before prepare throws', async () => {
  await expect(createFakeDriver(['image-ok']).click('t1', 1)).rejects.toThrow(/click before prepare/);
});

test('script kind must match prepared kind', async () => {
  for (const [step, kind] of [['image-ok', 'video'], ['video-ok', 'image']] as const) {
    const d = createFakeDriver([step]);
    await d.prepare('t1', { prompt: PROMPT, kind, settings: {}, refIds: [] });
    await expect(d.click('t1', 1)).rejects.toThrow(`fake: script kind ${step.slice(0, 5)} does not match prepared kind ${kind}`);
  }
});

test('R29: sent and response carry the epoch passed to click', async () => {
  const d = createFakeDriver(['image-ok']);
  const got: DriverEvent[] = [];
  d.onEvent((e) => got.push(e));
  await d.prepare('t1', { prompt: PROMPT, kind: 'image', settings: {}, refIds: [] });
  await d.click('t1', 7);
  await new Promise((r) => setTimeout(r, 5));
  expect(got.map((e) => (e as { epoch: number }).epoch)).toEqual([7, 7]);
});

test('probeTab: the fake tab always passes the self-check probe', async () => {
  expect(await createFakeDriver([]).probeTab!('t1')).toEqual({ present: { editor: true, submit: true }, listeners: 1, sawProjectLoad: true });
});
