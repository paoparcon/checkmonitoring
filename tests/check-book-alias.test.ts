import { describe, expect, it } from 'vitest'
import { CHECK_BOOK_ALIASES, canonicalCheckBookCode } from '@/lib/check-book-alias'

describe('canonicalCheckBookCode', () => {
  it('MBT-S-9048 is the MBT-A-9048 book (user ruling 2026-11-03)', () => {
    expect(canonicalCheckBookCode('MBT-S-9048')).toBe('MBT-A-9048')
  })
  it('a code with no alias is its own', () => {
    expect(canonicalCheckBookCode('BPI-S-4636')).toBe('BPI-S-4636')
    expect(canonicalCheckBookCode('PAYROLL')).toBe('PAYROLL')
  })
  it('no alias points at another alias — a lookup is one step', () => {
    for (const to of Object.values(CHECK_BOOK_ALIASES)) expect(CHECK_BOOK_ALIASES[to]).toBeUndefined()
  })
})
