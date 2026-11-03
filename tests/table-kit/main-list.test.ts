import { describe, it, expect } from 'vitest'
import { COLUMN_FILTER_PARAMS } from '@/lib/column-filters'
import { SORT_KEYS } from '@/lib/list-sort'
import { COLUMN_STORAGE_KEY } from '@/lib/table-columns'
import { bindingParams } from '@/lib/table-kit/url-binding'
import { layoutStorageKey } from '@/lib/table-kit/layout'
import { MAIN_LIST_BINDINGS, MAIN_LIST_TABLE_ID, mainListColumns, readMainListOrder } from '@/lib/table-kit/main-list'

const OPTIONS = {
  companies: [{ id: 'c1', code: 'STK', name: 'Starkson' }],
  cashAccounts: [{ id: 'b1', code: 'BPI-S-4636', bankCode: 'BPI' }],
}
const store = (v: Record<string, string>) => ({ getItem: (k: string) => v[k] ?? null })

describe('main list bindings', () => {
  it('bind exactly the parameters the server already parses, for every sortable column', () => {
    for (const key of SORT_KEYS) {
      expect(bindingParams(MAIN_LIST_BINDINGS[key])).toEqual([...COLUMN_FILTER_PARAMS[key]])
    }
  })
})

describe('mainListColumns', () => {
  it('has every data column, CHECK NUMBER and STATUS locked, the pickup dates hidden by default', () => {
    const cols = mainListColumns({ options: OPTIONS, showStatus: true, showReleasedRange: true })
    expect(cols.map((c) => c.key)).toEqual([...SORT_KEYS])
    expect(cols.filter((c) => c.locked).map((c) => c.key)).toEqual(['checkNumber', 'status'])
    expect(cols.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(['availablePickupDate', 'scheduledPickupDate'])
  })

  it('offers company and bank by id, with their codes as labels', () => {
    const cols = mainListColumns({ options: OPTIONS, showStatus: true, showReleasedRange: true })
    expect(cols.find((c) => c.key === 'companyCode')!.options).toEqual([{ value: 'c1', label: 'STK' }])
    expect(cols.find((c) => c.key === 'bank')!.options).toEqual([{ value: 'b1', label: 'BPI-S-4636' }])
  })

  it('STATUS and DATE RELEASED filter only on the views whose server honours them', () => {
    const off = mainListColumns({ options: OPTIONS, showStatus: false, showReleasedRange: false })
    expect(off.find((c) => c.key === 'status')!.noFilter).toBe(true)
    expect(off.find((c) => c.key === 'releasedAt')!.noFilter).toBe(true)
  })

  it('STATUS is ticked boxes (several at once); COMPANY and BANK stay one choice', () => {
    const cols = mainListColumns({ options: OPTIONS, showStatus: true, showReleasedRange: true })
    expect(cols.find((c) => c.key === 'status')!.multi).toBe(true)
    expect(cols.find((c) => c.key === 'companyCode')!.multi).toBeUndefined()
    expect(cols.find((c) => c.key === 'bank')!.multi).toBeUndefined()
  })

  it('offers no operator the server cannot honour', () => {
    const cols = mainListColumns({ options: OPTIONS, showStatus: true, showReleasedRange: true })
    expect(cols.find((c) => c.key === 'checkDate')!.ops).not.toContain('ne')
    expect(cols.find((c) => c.key === 'amount')!.ops).toEqual(['eq', 'ge', 'le', 'between'])
  })
})

describe('readMainListOrder', () => {
  it('reads the kit layout, then the v3 preference, then the default; ACTION is never a file column', () => {
    const kit = JSON.stringify({ order: ['payeeName', 'checkNumber', 'amount', 'status'], hidden: [], widths: {} })
    // Columns the stored order lacks are inserted beside their usual neighbour, so compare the four it names.
    const four = ['payeeName', 'checkNumber', 'amount', 'status']
    expect(readMainListOrder(store({ [layoutStorageKey(MAIN_LIST_TABLE_ID)]: kit })).filter((k) => four.includes(k)))
      .toEqual(four)
    const v3 = JSON.stringify(['amount', 'checkNumber', 'status', 'action'])
    expect(readMainListOrder(store({ [COLUMN_STORAGE_KEY]: v3 }))).toEqual(['amount', 'checkNumber', 'status'])
    expect(readMainListOrder(store({}))).not.toContain('availablePickupDate')
  })
})
