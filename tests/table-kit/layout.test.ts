import { describe, it, expect } from 'vitest'
import type { KitColumn } from '@/lib/table-kit/types'
import {
  clampWidth, defaultLayout, fromVisibleList, hideColumn, layoutStorageKey, loadLayout, moveVisible,
  sanitizeLayout, setWidth, showColumn, visibleColumns,
} from '@/lib/table-kit/layout'

const COLS: KitColumn[] = [
  { key: 'a', label: 'A', kind: 'text', locked: true },
  { key: 'b', label: 'B', kind: 'text' },
  { key: 'c', label: 'C', kind: 'text', defaultHidden: true },
  { key: 'd', label: 'D', kind: 'text' },
]
const store = (v: Record<string, string>) => ({ getItem: (k: string) => v[k] ?? null })

describe('defaults and sanitising', () => {
  it('the default is every column in declared order, default-hidden ones hidden', () => {
    expect(defaultLayout(COLS)).toEqual({ order: ['a', 'b', 'c', 'd'], hidden: ['c'], widths: {} })
  })

  it('reads junk as the default', () => {
    for (const raw of [null, 'x', 42, [], { order: 'no' }]) expect(sanitizeLayout(raw, COLS)).toEqual(defaultLayout(COLS))
  })

  it('drops unknown keys, inserts new columns beside their default neighbour, unhides locked', () => {
    const l = sanitizeLayout({ order: ['d', 'zz', 'a'], hidden: ['a', 'd', 'zz'], widths: { a: 5000, zz: 90, d: 'x' } }, COLS)
    expect(l.order).toEqual(['d', 'a', 'b', 'c'])
    expect(l.hidden).toEqual(['d', 'c'])
    expect(l.widths).toEqual({ a: 800 })
  })

  it('never hides every column', () => {
    const cols: KitColumn[] = [{ key: 'x', label: 'X', kind: 'text' }, { key: 'y', label: 'Y', kind: 'text' }]
    expect(sanitizeLayout({ order: ['x', 'y'], hidden: ['x', 'y'] }, cols).hidden).toEqual([])
  })

  it('clamps widths', () => {
    expect(clampWidth(10)).toBe(60)
    expect(clampWidth(900)).toBe(800)
    expect(clampWidth(123.6)).toBe(124)
  })
})

describe('loading', () => {
  it('prefers the kit key, then the legacy reader, then the default', () => {
    const key = layoutStorageKey('t')
    expect(key).toBe('check-monitoring.table.t.v1')
    const kit = JSON.stringify({ order: ['d', 'c', 'b', 'a'], hidden: [], widths: {} })
    expect(loadLayout(store({ [key]: kit }), 't', COLS).order).toEqual(['d', 'c', 'b', 'a'])
    const legacy = () => ({ order: ['b', 'a', 'c', 'd'], hidden: ['d'], widths: { b: 200 } })
    expect(loadLayout(store({}), 't', COLS, legacy)).toEqual({ order: ['b', 'a', 'c', 'd'], hidden: ['d'], widths: { b: 200 } })
    expect(loadLayout(store({ [key]: '{broken' }), 't', COLS)).toEqual(defaultLayout(COLS))
  })

  it('migrates a visible-columns list (the main list v3 preference)', () => {
    expect(fromVisibleList(JSON.stringify(['d', 'a', 'action']), COLS)).toEqual({ order: ['d', 'a', 'b', 'c'], hidden: ['b', 'c'], widths: {} })
    expect(fromVisibleList(null, COLS)).toBeNull()
    expect(fromVisibleList('nope', COLS)).toBeNull()
    expect(fromVisibleList('[]', COLS)).toBeNull()
  })
})

describe('visible columns', () => {
  it('follows the order and hides what is hidden, except a forced (filtered) column', () => {
    const l = { order: ['d', 'a', 'b', 'c'], hidden: ['b', 'c'], widths: {} }
    expect(visibleColumns(COLS, l).map((c) => c.key)).toEqual(['d', 'a'])
    expect(visibleColumns(COLS, l, ['c']).map((c) => c.key)).toEqual(['d', 'a', 'c'])
  })
})

describe('dialog moves', () => {
  const base = defaultLayout(COLS) // a b c(hidden) d
  it('showing a column puts it at the end of the selected list', () => {
    expect(showColumn(base, 'c')).toEqual({ order: ['a', 'b', 'd', 'c'], hidden: [], widths: {} })
  })
  it('hiding refuses a locked column and the last visible one', () => {
    expect(hideColumn(base, 'a', COLS)).toEqual(base)
    expect(hideColumn(base, 'b', COLS).hidden).toEqual(['c', 'b'])
    const one = { order: ['a', 'b', 'c', 'd'], hidden: ['b', 'c', 'd'], widths: {} }
    const cols = COLS.map((c) => ({ ...c, locked: false }))
    expect(hideColumn(one, 'a', cols)).toEqual(one)
  })
  it('moves swap with the visible neighbour, skipping hidden slots', () => {
    expect(moveVisible(base, 'd', -1).order).toEqual(['a', 'd', 'c', 'b'])
    expect(moveVisible(base, 'a', -1)).toEqual(base)
    expect(moveVisible(base, 'd', 1)).toEqual(base)
  })
  it('sets and forgets a width', () => {
    expect(setWidth(base, 'b', 30).widths).toEqual({ b: 60 })
    expect(setWidth({ ...base, widths: { b: 200 } }, 'b', null).widths).toEqual({})
  })
})
