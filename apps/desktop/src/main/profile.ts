import { checkHeartbeat } from '@toolflow/flow-protocol/heartbeat';
import type { Ping } from './driver';
import flow from '../../profiles/flow.json';

export const profile = flow;

export type Probe = { present: Record<string, boolean>; listeners: number; ping: Ping; sawProjectLoad: boolean; extVersion: string };
export type SelfCheck = { ok: true } | { ok: false; code: 'PROTOCOL_DRIFT' | 'CONFIG_INCOMPLETE'; reasons: string[] };

export function selfCheck(p: Probe): SelfCheck {
  // A stale extension makes every other signal meaningless, so it wins.
  if (!p.ping?.version || p.ping.version !== p.extVersion) return { ok: false, code: 'CONFIG_INCOMPLETE', reasons: ['RELOAD_TAB'] };
  const reasons: string[] = [];
  for (const k of Object.keys(profile.selectors)) if (p.present[k] !== true) reasons.push(`selector:${k}`);
  if (p.listeners !== 1) reasons.push(`listeners:${p.listeners}`);
  for (const r of checkHeartbeat(p.ping).reasons) reasons.push(`heartbeat:${r}`);
  if (!p.sawProjectLoad) reasons.push('no_project_load');
  return reasons.length ? { ok: false, code: 'PROTOCOL_DRIFT', reasons } : { ok: true };
}
