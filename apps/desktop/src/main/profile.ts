import { checkHeartbeat } from '@toolflow/flow-protocol/heartbeat';
import type { Ping } from './driver';
import flow from '../../profiles/flow.json';

// version is the profile's identity for diagnostics.
// Static import: the profile can only change with an app restart, and that is the safe boundary (AC-18): a running attempt never sees a swap.
export const profile = flow;
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
  // shortcut: selfCheck list is editor+submit only, extend after live DOM check in P2
  for (const k of prof.selfCheck) if (p.present?.[k] !== true) reasons.push(`selector:${k}`);
  if (p.listeners !== 1) reasons.push(`listeners:${p.listeners}`);
  for (const r of checkHeartbeat(p.ping).reasons) reasons.push(`heartbeat:${r}`);
  if (!p.sawProjectLoad) reasons.push('no_project_load');
  return reasons.length ? { ok: false, code: 'PROTOCOL_DRIFT', reasons } : { ok: true };
}
