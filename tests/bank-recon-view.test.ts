import { describe, it, expect } from 'vitest'
import { parseReconDay, bankReconHref, dayLabel } from '@/lib/bank-recon-view'

describe('the bank recon screen parameters', () => {
  const stored = ['2026-10-30', '2026-09-30']
  it('takes a real day no later than today', () => {
    expect(parseReconDay('2026-09-30', stored, '2026-11-09')).toBe('2026-09-30')
    expect(parseReconDay('2026-11-09', stored, '2026-11-09')).toBe('2026-11-09')
  })
  it('falls back to the newest stored day for nothing, nonsense or a future day; today when nothing is stored', () => {
    expect(parseReconDay(undefined, stored, '2026-11-09')).toBe('2026-10-30')
    expect(parseReconDay('2026-02-30', stored, '2026-11-09')).toBe('2026-10-30')
    expect(parseReconDay('2026-12-31', stored, '2026-11-09')).toBe('2026-10-30')
    expect(parseReconDay('', [], '2026-11-09')).toBe('2026-11-09')
  })
  it('builds the href and labels a day with no zone to get wrong', () => {
    expect(bankReconHref()).toBe('/recon/bank')
    expect(bankReconHref('2026-10-30')).toBe('/recon/bank?asOf=2026-10-30')
    expect(dayLabel('2026-10-30')).toBe('30 Oct 2026')
    expect(dayLabel('2026-01-01')).toBe('1 Jan 2026')
  })
})
