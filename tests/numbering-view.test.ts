import { describe, it, expect } from 'vitest'
import {
  numberingHref, isMissingOnly, visibleEntries, describeNumberingFilters, missingLabel, numberingFilename,
  registerOnlyLine, NUMBERING_EXPORT_PATH, NUMBERING_SCOPE_NOTE,
} from '@/lib/numbering-view'
import type { SeriesEntry } from '@/lib/numbering/series'

describe('Acumatica only (spec §G2)', () => {
  it('the scope note says each series is built from Acumatica and register-only checks are not shown', () => {
    expect(NUMBERING_SCOPE_NOTE).toContain(
      "Each series is one check book, built from Acumatica's own check numbers and cash accounts (e.g. BPI-S-4636); checks that exist only in the old register are not shown.")
    expect(NUMBERING_SCOPE_NOTE).not.toContain('CashAccount column')
  })
  it('registerOnlyLine states the count, singular and plural', () => {
    expect(registerOnlyLine(1)).toBe('1 REGISTER-ONLY CHECK (NOT IN ACUMATICA) IS NOT SHOWN.')
    expect(registerOnlyLine(1102)).toBe('1,102 REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.')
    expect(registerOnlyLine(0)).toBe('0 REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.')
  })
})

describe('numberingHref', () => {
  it('writes only what is set, in a fixed order', () => {
    expect(numberingHref({})).toBe('/numbering')
    expect(numberingHref({ company: 'c1', account: 'a1', missing: true })).toBe('/numbering?company=c1&account=a1&missing=1')
    expect(numberingHref({ account: ' ', missing: false })).toBe('/numbering')
    expect(numberingHref({ account: 'a1' }, NUMBERING_EXPORT_PATH)).toBe('/api/export/numbering?account=a1')
  })
})

describe('isMissingOnly', () => {
  it('is true only for exactly 1', () => {
    expect(isMissingOnly('1')).toBe(true)
    expect(isMissingOnly(' 1 ')).toBe(true)
    expect(isMissingOnly('true')).toBe(false)
    expect(isMissingOnly(undefined)).toBe(false)
    expect(isMissingOnly(null)).toBe(false)
  })
})

describe('visibleEntries', () => {
  const cheque: SeriesEntry = { kind: 'CHECK', duplicate: false, cheque: { id: 'x', checkNumber: '1', checkDate: null, payeeName: null, amount: null, currency: 'PHP', status: 'VOIDED', cv: null } }
  const gap: SeriesEntry = { kind: 'MISSING', from: '2', to: '3', count: '2' }
  it('keeps everything, or only the MISSING lines', () => {
    expect(visibleEntries([cheque, gap], false)).toEqual([cheque, gap])
    expect(visibleEntries([cheque, gap], true)).toEqual([gap])
  })
  it('MISSING ONLY keeps a MISSING number listed on its own line too (spec §H)', () => {
    const number = { kind: 'MISSING_NUMBER', number: '2', note: null } as const
    const staged = { kind: 'STAGED' } as const
    expect(visibleEntries([cheque, number, staged, gap], true)).toEqual([number, gap])
  })
})

describe('labels', () => {
  it('describes the filters', () => {
    expect(describeNumberingFilters({})).toBe('No filters applied')
    expect(describeNumberingFilters({ company: 'STK', account: 'BPI STK', missingOnly: true })).toBe('COMPANY: STK  ·  CHECK BOOK: BPI STK  ·  MISSING ONLY')
  })
  it('a missing run reads as a range, a single number as itself', () => {
    expect(missingLabel({ from: '6000354301', to: '6000354349', count: '49' })).toBe('6000354301 – 6000354349 · MISSING · 49')
    expect(missingLabel({ from: '102', to: '102', count: '1' })).toBe('102 · MISSING · 1')
  })
  it('names the file by the Manila day', () => {
    expect(numberingFilename('2026-10-01')).toBe('check-numbering-2026-10-01.xlsx')
  })
})
