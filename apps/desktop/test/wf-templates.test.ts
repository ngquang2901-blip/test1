import { test, expect } from 'vitest'
import { parseGraph, plan } from '../src/main/workflow'
import { TEMPLATES } from '../src/renderer/src/wf-templates'

test('every ready-made workflow is a graph the app accepts and can run as it is; names are unique', () => {
  expect(TEMPLATES.length).toBeGreaterThanOrEqual(5)
  expect(new Set(TEMPLATES.map((t) => t.name)).size).toBe(TEMPLATES.length)
  for (const t of TEMPLATES) {
    const p = plan(parseGraph({ nodes: t.nodes, edges: t.edges }))
    expect(p.errors, t.name).toEqual([])
    expect(p.steps.some((s) => s.save), t.name).toBe(true) // something is saved at the end
  }
  const kinds = (name: string): string[] => plan(parseGraph(TEMPLATES.find((t) => t.name === name)!)).steps.map((s) => s.kind)
  expect(kinds('Tạo ảnh rồi làm video từ ảnh đó')).toEqual(['image', 'video'])
  expect(kinds('Video từ chữ')).toEqual(['video'])
  expect(plan(parseGraph(TEMPLATES.find((t) => t.name === 'Ảnh tinh chỉnh 3 vòng')!)).steps.map((s) => [s.node, s.save])).toEqual([['g', false], ['l#2', false], ['l#3', true]])
  const scenes = plan(parseGraph(TEMPLATES.find((t) => t.name === 'Nối cảnh video')!))
  expect([scenes.steps.map((s) => [s.node, s.kind, s.images.length + s.deps.length]), scenes.merges]).toEqual([[['v1', 'video', 0], ['v2', 'video', 1]], [{ node: 'm', inputs: ['v1', 'v2'] }]]) // scene 2 starts from scene 1's last frames, both joined in wire order
})
