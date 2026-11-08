export type Ping = { xhrSend: boolean; xhrOpen: boolean; fetch: boolean; id: string; seq: number; dropped: number; gen?: number; t: number };
export const MAX_AGE_MS: number;
export function checkHeartbeat(ping: unknown, opts?: { now?: number; baseline?: Ping | null }): { alive: boolean; reasons: string[] };
