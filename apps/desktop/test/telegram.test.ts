import { test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createTelegram } from '../src/main/telegram';

const TOKEN = '123456789:AAFakeFakeFakeFakeFakeFakeFakeFake_x';
const servers: Server[] = [];
afterEach(() => { servers.splice(0).forEach((s) => s.close()); });

/** A local stand-in for api.telegram.org: answers per method, records every call. */
async function fakeApi(answer: (method: string, token: string) => { status?: number; body: unknown }) {
  const calls: { method: string; token: string; body: Record<string, unknown> }[] = [];
  const s = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const [, bot, method] = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '') ?? [];
      const token = bot ?? '';
      calls.push({ method, token, body: raw ? JSON.parse(raw) : {} });
      const a = answer(method, token);
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, calls };
}
const file = () => join(mkdtempSync(join(tmpdir(), 'tf-tg-')), 'telegram.json');
const start = (id: number, chat: number, text = '/start') => ({ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, text } });

test('a token that is not a bot token is refused before anything is stored or sent', async () => {
  const api = await fakeApi(() => ({ body: { ok: true, result: [] } }));
  const tg = createTelegram({ file: file(), base: api.base });
  for (const bad of ['', 'abc', '123:short', 42, null]) expect(() => tg.setToken(bad)).toThrow(expect.objectContaining({ code: 'TG_BAD_TOKEN' }));
  expect(tg.state()).toEqual({ configured: false, linked: false });
  await expect(tg.connect()).rejects.toMatchObject({ code: 'TG_NOT_CONFIGURED' });
  expect(api.calls).toEqual([]);
});

test('Kết nối takes the chat of the latest /start; the state never carries the token; the file keeps it for the next start', async () => {
  const api = await fakeApi((m) => ({ body: { ok: true, result: m === 'getUpdates' ? [start(1, 11), start(2, 22, 'hello'), start(3, 33, '/start'), start(4, 44, 'hi')] : true } }));
  const f = file();
  const tg = createTelegram({ file: f, base: api.base });
  expect(tg.setToken(` ${TOKEN} `)).toEqual({ configured: true, linked: false });
  expect(await tg.connect()).toEqual({ configured: true, linked: true });
  await tg.send('Lô abcd1234 đã xong');
  expect(api.calls.map((c) => [c.method, c.token])).toEqual([['getUpdates', TOKEN], ['sendMessage', TOKEN]]);
  expect(api.calls[1].body).toEqual({ chat_id: 33, text: 'Lô abcd1234 đã xong' });
  expect(JSON.stringify(tg.state())).not.toContain(TOKEN.slice(0, 12));
  expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ token: TOKEN, chatId: 33 });
  if (process.platform !== 'win32') expect(statSync(f).mode & 0o077).toBe(0);
  expect(createTelegram({ file: f, base: api.base }).state()).toEqual({ configured: true, linked: true });
  tg.setToken(TOKEN.replace('123456789', '987654321')); // another bot: the old chat is not its chat
  expect(tg.state()).toEqual({ configured: true, linked: false });
});

test('errors come back as codes: wrong token, no /start yet, bot blocked, Telegram unreachable, not linked', async () => {
  let mode = 'unauthorized';
  const api = await fakeApi(() => mode === 'unauthorized' ? { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }
    : mode === 'empty' ? { body: { ok: true, result: [start(1, 5, 'hello')] } }
    : { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } });
  const tg = createTelegram({ file: file(), base: api.base });
  tg.setToken(TOKEN);
  await expect(tg.connect()).rejects.toMatchObject({ code: 'TG_BAD_TOKEN' });
  mode = 'empty';
  await expect(tg.connect()).rejects.toMatchObject({ code: 'TG_NO_START' });
  await expect(tg.send('x')).rejects.toMatchObject({ code: 'TG_NOT_LINKED' });
  const down = createTelegram({ file: file(), base: 'http://127.0.0.1:9' });
  down.setToken(TOKEN);
  await expect(down.connect()).rejects.toMatchObject({ code: 'TG_NETWORK' });
  mode = 'blocked';
  const f = file();
  writeFileSync(f, JSON.stringify({ token: TOKEN, chatId: 7 })); // linked earlier; the user has blocked the bot since
  await expect(createTelegram({ file: f, base: api.base }).send('x')).rejects.toMatchObject({ code: 'TG_BLOCKED' });
  writeFileSync(f, '{"token": 5}'); // a damaged file means not configured
  expect(createTelegram({ file: f, base: api.base }).state()).toEqual({ configured: false, linked: false });
});
