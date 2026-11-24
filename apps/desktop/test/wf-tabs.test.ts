import { test, expect } from 'vitest'
import { MAX_TABS, addTab, closeTab } from '../src/renderer/src/wf-tabs'

test('workflow tabs: add switches to the new tab and stops at 10; the last tab stays; closing the open tab moves to its neighbour', () => {
  let t = { ids: ['a'], active: 'a' }
  t = addTab(t, 'b')
  expect(t).toEqual({ ids: ['a', 'b'], active: 'b' })
  for (let i = 0; i < 20; i++) t = addTab(t, `x${i}`)
  expect(t.ids.length).toBe(MAX_TABS)
  expect(MAX_TABS).toBe(10)
  const three = { ids: ['a', 'b', 'c'], active: 'b' }
  expect(closeTab(three, 'b')).toEqual({ ids: ['a', 'c'], active: 'c' }) // the right neighbour
  expect(closeTab({ ids: ['a', 'b', 'c'], active: 'c' }, 'c')).toEqual({ ids: ['a', 'b'], active: 'b' }) // none on the right: the left one
  expect(closeTab(three, 'a')).toEqual({ ids: ['b', 'c'], active: 'b' }) // another tab closed: the open one stays
  expect(closeTab({ ids: ['a'], active: 'a' }, 'a')).toEqual({ ids: ['a'], active: 'a' })
})
