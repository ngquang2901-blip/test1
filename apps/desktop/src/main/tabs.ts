import type { FlowDriver, FlowTab } from './driver';
import type { Runner } from './runner';

export type TabStatus = 'ok' | 'no_project' | 'no_login';
const PROJECT = /\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export const projectIdOf = (path: string): string | null => PROJECT.exec(path)?.[1] ?? null;
/** Home page first: a login prompt is useless until a project is open. The UI maps these to Vietnamese. */
export const tabStatus = (t: FlowTab): TabStatus => (!t.projectId ? 'no_project' : !t.email ? 'no_login' : 'ok');

/** Session-only authorization (nothing persisted): the user grants tabs from the last listing, only those reach the runner. */
export function createGrants(driver: Pick<FlowDriver, 'listTabs'>, runner: Pick<Runner, 'setTabs'>) {
  let last: FlowTab[] = [];
  let granted: string[] = [];
  const set = (ids: string[]): void => { granted = ids; runner.setTabs(ids); };
  return {
    async list(): Promise<FlowTab[]> {
      last = await driver.listTabs();
      const keep = granted.filter((id) => last.some((t) => t.tabId === id && tabStatus(t) === 'ok'));
      if (keep.length !== granted.length) set(keep);
      return last;
    },
    use(ids: unknown): void {
      const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }); };
      if (!Array.isArray(ids)) bad();
      for (const id of ids as unknown[]) if (typeof id !== 'string' || !last.some((t) => t.tabId === id && tabStatus(t) === 'ok')) bad();
      set([...new Set(ids as string[])]);
    },
    projectOf: (id: string): string | null => last.find((t) => t.tabId === id)?.projectId ?? null, // per the last listing
    emailOf: (id: string): string | null => last.find((t) => t.tabId === id)?.email ?? null,
    /** Distinct projects of the granted tabs, in grant order: a new batch is split across them. */
    projects: (): string[] => [...new Set(granted.map((id) => last.find((t) => t.tabId === id)?.projectId).filter((p): p is string => !!p))],
    has: (id: string): boolean => granted.includes(id),
    granted: (): string[] => [...granted],
  };
}
export type Grants = ReturnType<typeof createGrants>;
