import { checkHeartbeat } from '@toolflow/flow-protocol/heartbeat';
import type { FlowDriver, Ping, TabProbe } from './driver';
import flow from '../../profiles/flow.json';

// version is the profile's identity for diagnostics.
// Static import: the profile can only change with an app restart, and that is the safe boundary (AC-18): a running attempt never sees a swap.
export const profile = flow;
export type Combo = { kind: 'image' | 'video'; mode: string; model: string; aspect: string; quality: string; count: number };
/** The only live-tested combo; a batch whose settings.combo is not one of profile.combos never reaches the page (AC-03). */
export const DEFAULT_COMBO = flow.combos[0] as Combo;
const norm = (o: unknown) => JSON.stringify(Object.entries((o && typeof o === 'object' ? o : {}) as object).sort(([a], [b]) => (a < b ? -1 : 1)));
export const comboQualified = (kind: string, combo: unknown, list: readonly Combo[] = flow.combos as Combo[]): boolean => list.some((c) => c.kind === kind && norm(c) === norm(combo));
export const PROFILE_PATH = 'profiles/flow.json';
const SELECTORS = ['editor', 'submit', 'clear', 'chip', 'tile', 'creditWarning', 'assetSearch', 'assetItem'];
const RPC = ['image', 't2v', 'poll', 'upload', 'project'];

/** Pure: null when the profile is usable, else the first problem found. */
export function validateProfile(p: unknown): string | null {
  const o = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const root = o(p);
  if (!root) return 'not an object';
  if (!str(root.version)) return 'version';
  const sel = o(root.selectors), rpc = o(root.rpc);
  if (!sel) return 'selectors';
  for (const k of SELECTORS) if (!str(sel[k])) return `selectors.${k}`;
  if (!Array.isArray(root.selfCheck)) return 'selfCheck';
  for (const k of root.selfCheck) if (typeof k !== 'string' || !SELECTORS.includes(k)) return `selfCheck.${String(k)}`;
  if (!Array.isArray(root.combos) || root.combos.length === 0) return 'combos';
  for (const c of root.combos) {
    const x = o(c);
    if (!x || !['kind', 'mode', 'model', 'aspect', 'quality'].every((k) => str(x[k])) || !Number.isInteger(x.count) || (x.count as number) < 1) return 'combos';
  }
  if (!rpc) return 'rpc';
  for (const k of RPC) if (!str(rpc[k])) return `rpc.${k}`;
  return null;
}

export type Probe = { present: Record<string, boolean>; listeners: number; ping: Ping; sawProjectLoad: boolean; extVersion: string };
export type SelfCheck = { ok: true } | { ok: false; code: 'PROTOCOL_DRIFT' | 'CONFIG_INCOMPLETE'; reasons: string[] };

export function selfCheck(p: Probe, prof: typeof profile = profile): SelfCheck {
  if (validateProfile(prof)) return { ok: false, code: 'CONFIG_INCOMPLETE', reasons: [`PROFILE_INVALID:${PROFILE_PATH}`] }; // blocks auto too (index.ts)
  // A stale extension makes every other signal meaningless, so it wins.
  if (!p.ping?.version || p.ping.version !== p.extVersion) return { ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] };
  const reasons: string[] = [];
  // the selfCheck list is the profile's (editor + submit, measured live); every listed selector must be present
  for (const k of prof.selfCheck) if (p.present?.[k] !== true) reasons.push(`selector:${k}`);
  if (p.listeners !== 1) reasons.push(`listeners:${p.listeners}`);
  for (const r of checkHeartbeat(p.ping).reasons) reasons.push(`heartbeat:${r}`);
  if (!p.sawProjectLoad) reasons.push('no_project_load');
  return reasons.length ? { ok: false, code: 'PROTOCOL_DRIFT', reasons } : { ok: true };
}

/** Probe one tab (read-only) and judge it. A driver without probeTab, or one that throws, gives an empty probe ⇒ never ok. */
export async function selfCheckTab(driver: Pick<FlowDriver, 'probeTab'>, ping: Ping, tab: string, extVersion: string): Promise<SelfCheck> {
  let probe: TabProbe = { present: {}, listeners: 0, sawProjectLoad: false };
  try { probe = (await driver.probeTab?.(tab)) ?? probe; } catch { /* fail closed */ }
  return selfCheck({ ...probe, ping, extVersion });
}
