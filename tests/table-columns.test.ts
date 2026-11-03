import { describe, it, expect } from 'vitest'
import {
  COLUMN_KEYS, COLUMN_LABELS, DEFAULT_COLUMNS, COLUMN_STORAGE_KEY, withColumnOrder,
} from '@/lib/table-columns'

// Pure. No database, no localStorage, no DOM.

describe('the column set', () => {
  it('labels every column, so none can render a blank header', () => {
    for (const key of COLUMN_KEYS) {
      expect(COLUMN_LABELS[key]).toBeTruthy()
    }
    expect(Object.keys(COLUMN_LABELS).sort()).toEqual([...COLUMN_KEYS].sort())
  })

  it('defaults to every column but AVAILABLE DATE and PICKUP SCHEDULE', () => {
    expect(DEFAULT_COLUMNS).toEqual(COLUMN_KEYS.filter((k) => k !== 'availablePickupDate' && k !== 'scheduledPickupDate'))
  })
})

describe('PO NUMBER', () => {
  it('sits right after APV NUMBER, labelled PO NUMBER', () => {
    expect(COLUMN_KEYS[COLUMN_KEYS.indexOf('apvNumbers') + 1]).toBe('poNumbers')
    expect(COLUMN_LABELS.poNumbers).toBe('PO NUMBER')
  })

  it('keeps the pre-kit storage key the table kit migrates from', () => {
    expect(COLUMN_STORAGE_KEY).toBe('check-monitoring.columns.v3')
  })
})

describe('withColumnOrder', () => {
  it('writes the order onto the export link, without ACTION', () => {
    expect(withColumnOrder('/api/export?status=SIGNED', ['amount', 'checkNumber', 'status', 'action']))
      .toBe('/api/export?status=SIGNED&cols=amount%2CcheckNumber%2Cstatus')
    expect(withColumnOrder('/api/export', ['checkNumber', 'status', 'action']))
      .toBe('/api/export?cols=checkNumber%2Cstatus')
  })
})
