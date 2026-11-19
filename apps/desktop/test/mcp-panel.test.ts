import { test, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

// The chat panel (src/main/mcp-panel.html) run against a fake host: just enough DOM for its render.
const SRC = readFileSync(join(__dirname, '../src/main/mcp-panel.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]
const node = (): Record<string, unknown> => {
  const n: Record<string, unknown> = { style: {}, textContent: '', lastChild: null, setAttribute() {}, addEventListener() {}, getBoundingClientRect: () => ({ height: 100 }) }
  n.appendChild = (c: unknown) => { n.lastChild = c; return c }
  return n
}

function host() {
  const sent: { id?: string; method?: string; params?: { name?: string; arguments?: unknown } }[] = []
  let onMessage: (e: unknown) => void = () => {}
  const parent = { postMessage: (m: (typeof sent)[number]) => sent.push(m) }
  const window = { addEventListener: (_: string, f: (e: unknown) => void) => { onMessage = f } }
  const document = { documentElement: node(), getElementById: node, createElement: node }
  runInNewContext(SRC, { parent, window, document, setTimeout, clearTimeout, JSON, Promise, Error, Object, Array })
  const from = (m: object) => onMessage({ source: parent, data: { jsonrpc: '2.0', ...m } })
  const calls = (name: string) => sent.filter((m) => m.method === 'tools/call' && m.params?.name === name)
  return { sent, from, calls }
}
const text = (o: object) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })

test('panel: a poll that never answers does not stop the panel; it asks again by the workflow job', async () => {
  vi.useFakeTimers()
  try {
    const h = host()
    h.from({ id: h.sent[0].id, result: {} }) // ui/initialize answered
    await vi.advanceTimersByTimeAsync(0)
    h.from({ method: 'ui/notifications/tool-result', params: text({ batches: [{ id: 'b1', kind: 'image', site: 'flow', status: 'running', items: [] }], bulkId: 'k1', bulkRunning: true }) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.calls('toolflow_app_state').map((m) => m.params!.arguments)).toEqual([{ bulkId: 'k1' }])
    await vi.advanceTimersByTimeAsync(30_000) // the host never answered that poll
    expect(h.calls('toolflow_app_state').length).toBeGreaterThan(1)
  } finally { vi.useRealTimers() }
})
