// The open workflow tabs: pure list rules (the canvases live in screens/Workflow.tsx)
export const MAX_TABS = 10
export type Tabs = { ids: string[]; active: string }

export const addTab = (t: Tabs, id: string): Tabs => (t.ids.length >= MAX_TABS ? t : { ids: [...t.ids, id], active: id })

export function closeTab(t: Tabs, id: string): Tabs {
  const at = t.ids.indexOf(id)
  if (t.ids.length < 2 || at < 0) return t
  const ids = t.ids.filter((x) => x !== id)
  return { ids, active: t.active === id ? ids[at] ?? ids[at - 1] : t.active }
}
