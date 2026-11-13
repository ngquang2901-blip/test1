import type { Db } from './db';
import type { FlowDriver, FlowTab } from './driver';
import type { Runner } from './runner';

export type TabStatus = 'ok' | 'no_project' | 'no_login';
const PROJECT = /\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export const projectIdOf = (path: string): string | null => PROJECT.exec(path)?.[1] ?? null;
/** Home page first: a login prompt is useless until a project is open. The UI maps these to Vietnamese. */
export const tabStatus = (t: FlowTab): TabStatus => (!t.projectId ? 'no_project' : !t.email ? 'no_login' : 'ok');

/** The user grants tabs from the last listing, only those reach the runner. With `mem` the choice is remembered by (account, project),
 * never by tab id (ids change when Chrome restarts): a listed ok tab of a remembered pair is granted again by itself, up to the speed cap. */
export function createGrants(driver: Pick<FlowDriver, 'listTabs'>, runner: Pick<Runner, 'setTabs'>, mem?: { db: Db; cap(): number }) {
  let last: FlowTab[] = [];
  let granted: string[] = [];
  const auto = new Set<string>(); // granted by the app from memory, not by the user's click
  const key = (t: FlowTab | undefined): string => JSON.stringify([t?.email, t?.projectId]);
  let pairs = new Set((mem?.db.prepare('select email, project_id p from remembered_tab').all() as { email: string; p: string }[] | undefined ?? []).map((r) => JSON.stringify([r.email, r.p]))); // read once: list() runs in a loop
  const set = (ids: string[]): void => { granted = ids; for (const id of auto) if (!ids.includes(id)) auto.delete(id); runner.setTabs(ids); };
  const tabOf = (id: string) => last.find((t) => t.tabId === id);
  return {
    async list(): Promise<FlowTab[]> {
      last = await driver.listTabs();
      const ok = last.filter((t) => tabStatus(t) === 'ok');
      const keep = granted.filter((id) => ok.some((t) => t.tabId === id));
      for (const t of ok) { // one tab per remembered pair: a second tab of the same project, or any other pair, stays the user's to choose
        if (keep.length >= (mem?.cap() ?? 0) || !pairs.has(key(t)) || keep.some((id) => key(tabOf(id)) === key(t))) continue;
        keep.push(t.tabId); auto.add(t.tabId);
      }
      set(keep); // every listing, even unchanged: the runner lets a batch that lost its tab go on once the tab answers again
      return last;
    },
    use(ids: unknown): void {
      const bad = (): never => { throw Object.assign(new Error('INVALID_ARGS'), { code: 'INVALID_ARGS' }); };
      if (!Array.isArray(ids)) bad();
      for (const id of ids as unknown[]) if (typeof id !== 'string' || !last.some((t) => t.tabId === id && tabStatus(t) === 'ok')) bad();
      set([...new Set(ids as string[])]);
      if (!mem) return;
      pairs = new Set(granted.map((id) => key(tabOf(id)))); // the latest choice replaces the old one; a tab let go is forgotten
      mem.db.transaction(() => {
        mem.db.prepare('delete from remembered_tab').run();
        for (const id of granted) { const t = tabOf(id)!; mem.db.prepare('insert or ignore into remembered_tab(email, project_id) values(?,?)').run(t.email, t.projectId); }
      })();
    },
    forget(): void { mem?.db.prepare('delete from remembered_tab').run(); pairs = new Set(); }, // the tabs in use stay for this session
    remembered: (): number => pairs.size,
    isAuto: (id: string): boolean => auto.has(id),
    projectOf: (id: string): string | null => last.find((t) => t.tabId === id)?.projectId ?? null, // per the last listing
    /** Distinct projects of the granted tabs, in grant order: a new batch is split across them. */
    projects: (): string[] => [...new Set(granted.map((id) => last.find((t) => t.tabId === id)?.projectId).filter((p): p is string => !!p))],
    has: (id: string): boolean => granted.includes(id),
    granted: (): string[] => [...granted],
  };
}
export type Grants = ReturnType<typeof createGrants>;
