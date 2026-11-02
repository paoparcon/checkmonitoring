// tests/numbering/inventory.test.ts
import { describe, it, expect } from 'vitest'
import { buildSeries, type SeriesCheque } from '@/lib/numbering/series'
import {
  INVENTORY_LIST_MAX, inventoryKey, toInventoryLines, inventoryCounts, runNoteStale, type InventoryLine, type InventoryNote,
} from '@/lib/numbering/inventory'

let seq = 0
const c = (checkNumber: string): SeriesCheque => {
  seq += 1
  return { id: `id${seq}`, checkNumber, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP', status: 'RELEASED', cv: null }
}
const note = (checkNumber: string, o: Partial<InventoryNote> = {}): InventoryNote =>
  ({ checkNumber, runTo: null, ticked: true, remarks: null, updatedAt: new Date('2026-11-03T02:00:00Z'), updatedBy: 'Ana', ...o })
const notes = (...ns: InventoryNote[]) => new Map(ns.map((n) => [n.checkNumber, n]))
const shape = (lines: InventoryLine[]) =>
  lines.map((l) => (l.kind === 'CHECK' ? l.cheque.checkNumber
    : l.kind === 'STAGED' ? `STAGED ${l.number}`
    : l.kind === 'MISSING_NUMBER' ? `N ${l.number}`
    : `RUN ${l.from}-${l.to} (${l.count})`))

describe('inventoryKey', () => {
  it('is the number as a canonical decimal, null for anything not all digits', () => {
    expect(inventoryKey('007')).toBe('7')
    expect(inventoryKey(' 6000354301 ')).toBe('6000354301')
    expect(inventoryKey('0')).toBe('0')
    expect(inventoryKey('MEMO')).toBeNull()
    expect(inventoryKey('102.')).toBeNull()
    expect(inventoryKey('')).toBeNull()
  })
})

describe('toInventoryLines (spec §H)', () => {
  it('lists a short MISSING run one number per line, in order, between the checks', () => {
    const lines = toInventoryLines(buildSeries([c('101'), c('104')]).entries, new Map())
    expect(shape(lines)).toEqual(['101', 'N 102', 'N 103', '104'])
  })

  it('keeps a run longer than the cap as one line, keyed to its first number', () => {
    const max = INVENTORY_LIST_MAX
    const atCap = toInventoryLines(buildSeries([c('1'), c(String(max + 2))]).entries, new Map())
    expect(atCap.filter((l) => l.kind === 'MISSING_NUMBER')).toHaveLength(max)
    const over = toInventoryLines(buildSeries([c('1'), c(String(max + 3))]).entries, notes(note('2', { runTo: String(max + 2) })))
    expect(shape(over)).toEqual(['1', `RUN 2-${max + 2} (${max + 1})`, String(max + 3)])
    const run = over[1]
    expect(run.kind === 'MISSING' && run.note?.runTo).toBe(String(max + 2))
  })

  it('a billion-number jump is one line whatever the cap', () => {
    const lines = toInventoryLines(buildSeries([c('1791259553'), c('6000354350')]).entries, new Map(), 5)
    expect(shape(lines)).toEqual(['1791259553', 'RUN 1791259554-6000354349 (4209094796)', '6000354350'])
  })

  it('attaches each note by canonical number: a padded bound finds the bare key', () => {
    const lines = toInventoryLines(buildSeries([c('0098'), c('0101')]).entries, notes(note('99', { remarks: 'spoiled' }), note('100')))
    expect(shape(lines)).toEqual(['0098', 'N 0099', 'N 0100', '0101'])
    expect(lines[1].kind === 'MISSING_NUMBER' && lines[1].note?.remarks).toBe('spoiled')
    expect(lines[2].kind === 'MISSING_NUMBER' && lines[2].note?.ticked).toBe(true)
  })

  it('a check that now holds a noted number carries the note, so it is not lost', () => {
    const lines = toInventoryLines(buildSeries([c('7'), c('8')]).entries, notes(note('7', { remarks: 'was missing' })))
    expect(lines[0].kind === 'CHECK' && lines[0].note?.remarks).toBe('was missing')
    expect(lines[1].kind === 'CHECK' && lines[1].note).toBeNull()
  })

  it('a staged line is passed through and never carries a note', () => {
    const staged = { acumaticaTenant: 'GOLIVE', acumaticaRef: 'CV-1', statedCheckRef: '102.', checkDate: null, payeeName: null, amount: null, currency: null }
    const lines = toInventoryLines(buildSeries([c('101'), c('103')], [staged]).entries, notes(note('102')))
    expect(shape(lines)).toEqual(['101', 'STAGED 102', '103'])
  })
})

describe('inventoryCounts', () => {
  it('counts ticked numbers, a ticked run as every number it spans, remarked lines, and lines', () => {
    const lines: InventoryLine[] = [
      { kind: 'CHECK', cheque: c('1'), duplicate: false, note: note('1') }, // a held number's note does not count
      { kind: 'MISSING_NUMBER', number: '2', note: note('2', { remarks: 'x' }) },
      { kind: 'MISSING_NUMBER', number: '3', note: note('3', { ticked: false, remarks: 'y' }) },
      { kind: 'MISSING_NUMBER', number: '4', note: null },
      { kind: 'MISSING', from: '5', to: '204', count: '200', note: note('5', { runTo: '204' }) },
      { kind: 'MISSING', from: '300', to: '600', count: '301', note: null },
    ]
    expect(inventoryCounts(lines)).toEqual({ ticked: '201', remarked: 2, lines: 5 })
  })
  it('is zero on an empty or all-held series', () => {
    expect(inventoryCounts([])).toEqual({ ticked: '0', remarked: 0, lines: 0 })
  })
})

describe('runNoteStale', () => {
  const run = (to: string, n: InventoryNote | null): Extract<InventoryLine, { kind: 'MISSING' }> => ({ kind: 'MISSING', from: '5', to, count: '1', note: n })
  it('is false with no note or when the note still describes this run, true once the run has changed', () => {
    expect(runNoteStale(run('204', null))).toBe(false)
    expect(runNoteStale(run('204', note('5', { runTo: '204' })))).toBe(false)
    expect(runNoteStale(run('0204', note('5', { runTo: '204' })))).toBe(false)
    expect(runNoteStale(run('150', note('5', { runTo: '204' })))).toBe(true)
    expect(runNoteStale(run('204', note('5')))).toBe(true) // recorded on one number, now a run
  })
})
