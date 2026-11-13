// Telegram notices through the user's own bot. The token stays in <userData>/telegram.json (0600) and in this process:
// the renderer only learns whether a bot is set and a chat linked. Messages are built content-free by notify.ts.
import { readFileSync, writeFileSync } from 'node:fs';

type Saved = { token: string; chatId?: number };
const coded = (code: string): Error => Object.assign(new Error(code), { code });
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/; // BotFather's form: <bot id>:<secret>

export function createTelegram(o: { file: string; base?: string }) {
  const base = o.base ?? 'https://api.telegram.org';
  let saved: Saved | null = null;
  try { const j = JSON.parse(readFileSync(o.file, 'utf8')); if (typeof j.token === 'string' && TOKEN.test(j.token)) saved = { token: j.token, ...(Number.isInteger(j.chatId) ? { chatId: j.chatId } : {}) }; } catch { /* none yet */ }
  const write = (): void => writeFileSync(o.file, JSON.stringify(saved), { mode: 0o600 });
  const state = () => ({ configured: !!saved, linked: saved?.chatId !== undefined });
  const call = async (method: string, body: object = {}): Promise<unknown> => {
    if (!saved) throw coded('TG_NOT_CONFIGURED');
    let r: Response;
    try { r = await fetch(`${base}/bot${saved.token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) }); } catch { throw coded('TG_NETWORK'); }
    const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
    if (r.status === 401 || r.status === 404) throw coded('TG_BAD_TOKEN');
    if (r.status === 403) throw coded('TG_BLOCKED');
    if (!j?.ok) throw coded('TG_FAILED');
    return j.result;
  };
  return {
    state,
    /** A new token forgets the old chat: it belongs to another bot. */
    setToken(t: unknown) {
      if (typeof t !== 'string' || !TOKEN.test(t.trim())) throw coded('TG_BAD_TOKEN');
      saved = { token: t.trim() };
      write();
      return state();
    },
    /** The user has sent /start to his bot: the chat of the latest /start is where notices go. */
    async connect() {
      const ups = (await call('getUpdates')) as { message?: { text?: string; chat?: { id?: number } } }[];
      const m = [...(Array.isArray(ups) ? ups : [])].reverse().find((u) => /^\/start\b/.test(u.message?.text ?? '') && Number.isInteger(u.message?.chat?.id));
      if (!m) throw coded('TG_NO_START');
      saved = { ...saved!, chatId: m.message!.chat!.id };
      write();
      return state();
    },
    async send(text: string): Promise<void> {
      if (saved?.chatId === undefined) throw coded('TG_NOT_LINKED');
      await call('sendMessage', { chat_id: saved.chatId, text });
    },
  };
}
export type Telegram = ReturnType<typeof createTelegram>;
