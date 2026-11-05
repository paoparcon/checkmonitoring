import { describe, it, expect } from 'vitest'
import { displayStatus, displayStatusWhere, DISPLAY_STATUSES, isDisplayStatus } from '@/lib/display-status'
import { ALL_STATUSES } from '@/lib/queries'

describe('displayStatus (user request 2026-11-05)', () => {
  it('shows CLEARED only for a RELEASED check the bank has cleared', () => {
    expect(displayStatus('RELEASED', 'CLEARED')).toBe('CLEARED')
    expect(displayStatus('RELEASED', 'DEPOSITED')).toBe('RELEASED')
    expect(displayStatus('RELEASED', 'NONE')).toBe('RELEASED')
    expect(displayStatus('VOIDED', 'CLEARED')).toBe('VOIDED')
  })

  it('offers every ladder status and CLEARED straight after RELEASED', () => {
    expect([...DISPLAY_STATUSES].filter((s) => s !== 'CLEARED').sort()).toEqual([...ALL_STATUSES].sort())
    expect(DISPLAY_STATUSES[DISPLAY_STATUSES.indexOf('RELEASED') + 1]).toBe('CLEARED')
    expect(isDisplayStatus('CLEARED')).toBe(true)
    expect(isDisplayStatus('STALED')).toBe(false)
  })

  it('never lets RELEASED and CLEARED match the same check', () => {
    expect(displayStatusWhere('CLEARED')).toEqual({ status: 'RELEASED', clearingStatus: 'CLEARED' })
    expect(displayStatusWhere('RELEASED')).toEqual({ status: 'RELEASED', clearingStatus: { not: 'CLEARED' } })
    expect(displayStatusWhere('SIGNED')).toEqual({ status: 'SIGNED' })
  })
})
