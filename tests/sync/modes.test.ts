import { describe, it, expect } from 'vitest'
import { BILLS_MODE, BILL_REFS_MODE, PORTAL_CHECKS_MODE, NON_PAYMENT_MODES } from '@/lib/sync/modes'
import { BILLS_MODE as BILLS_MODE_FROM_BILLS } from '@/lib/sync/bills'

describe('sync modes', () => {
  it('lists every read that is not the payment feed', () => {
    expect(BILLS_MODE).toBe('BILLS')
    expect(BILL_REFS_MODE).toBe('BILL_REFS')
    expect(PORTAL_CHECKS_MODE).toBe('PORTAL_CHECKS')
    expect([...NON_PAYMENT_MODES]).toEqual(['BILLS', 'BILL_REFS', 'PORTAL_CHECKS'])
    expect(BILLS_MODE_FROM_BILLS).toBe(BILLS_MODE)
  })
})
