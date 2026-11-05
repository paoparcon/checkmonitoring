import { describe, it, expect } from 'vitest'
import { parseClearingPaste, MAX_CLEARING_LINES } from '@/lib/clearing-paste'
import { DEFAULT_MAX_BULK_SELECTION as MAX_BULK_SELECTION } from '@/lib/settings/defaults'

describe('parseClearingPaste', () => {
  it('reads a bare check number per line', () => {
    const { lines, errors } = parseClearingPaste('6000319079\n174602\n')
    expect(errors).toEqual([])
    expect(lines).toEqual([
      { line: 1, checkNumber: '6000319079', clearedDate: null, crNumber: null },
      { line: 2, checkNumber: '174602', clearedDate: null, crNumber: null },
    ])
  })

  it('reads number, date and bank reference separated by comma or tab', () => {
    const { lines, errors } = parseClearingPaste('6000319079, 2026-09-10, BPI 88123\n174602\t10/09/2026\tMBTC-77')
    expect(errors).toEqual([])
    expect(lines[0]).toEqual({ line: 1, checkNumber: '6000319079', clearedDate: new Date('2026-09-10'), crNumber: 'BPI 88123' })
    expect(lines[1]).toEqual({ line: 2, checkNumber: '174602', clearedDate: new Date('2026-09-10'), crNumber: 'MBTC-77' })
  })

  it('strips a bank prefix the way the importer does', () => {
    expect(parseClearingPaste('BPI 6000319079').lines[0].checkNumber).toBe('6000319079')
  })

  it('skips blank lines without counting them', () => {
    const { lines } = parseClearingPaste('\n\n6000319079\n   \n')
    expect(lines).toEqual([{ line: 3, checkNumber: '6000319079', clearedDate: null, crNumber: null }])
  })

  it('reports a line whose first field is not a check number', () => {
    const { lines, errors } = parseClearingPaste('HENKEL, 2026-09-10\n6000319079')
    expect(lines).toHaveLength(1)
    expect(errors).toEqual([{ line: 1, raw: 'HENKEL, 2026-09-10', message: 'Not a check number.' }])
  })

  it('reports an unreadable date rather than guessing one', () => {
    const { lines, errors } = parseClearingPaste('6000319079, 9/10/26')
    expect(lines).toEqual([])
    expect(errors[0].message).toBe('Date must be YYYY-MM-DD or DD/MM/YYYY.')
  })

  it('reports a repeated check number on its later line', () => {
    const { lines, errors } = parseClearingPaste('6000319079\n6000319079, 2026-09-10')
    expect(lines).toHaveLength(1)
    expect(errors).toEqual([{ line: 2, raw: '6000319079, 2026-09-10', message: 'Repeats line 1.' }])
  })

  it('reports a line with more than three fields', () => {
    const { errors } = parseClearingPaste('6000319079, 2026-09-10, BPI 1, extra')
    expect(errors[0].message).toBe('Too many fields: number, date, bank reference.')
  })

  it('caps at the bulk selection limit', () => {
    expect(MAX_CLEARING_LINES).toBe(MAX_BULK_SELECTION)
  })
})
