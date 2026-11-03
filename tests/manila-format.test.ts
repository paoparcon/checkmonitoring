import { describe, expect, it } from 'vitest'
import { formatManila } from '@/lib/manila-format'
import { manilaDayStart } from '@/lib/manila-day'

const DT = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } as const
const DAY = { month: 'short', day: 'numeric', year: 'numeric' } as const

describe('formatManila', () => {
  it('shows an instant in Manila time, not the server clock (2026-11-03: /admin/portal said 9:23 AM for a 5:23 PM push)', () => {
    expect(formatManila(new Date('2026-11-03T09:22:15.631Z'), DT)).toBe('Nov 3, 2026, 5:22 PM')
  })

  it('shows a day stored at Manila midnight as that day, not the evening before', () => {
    expect(formatManila(manilaDayStart('2026-11-03'), DAY)).toBe('Nov 3, 2026')
  })

  it('shows a @db.Date value (UTC midnight) as the same calendar day', () => {
    expect(formatManila(new Date('2026-11-03T00:00:00.000Z'), DAY)).toBe('Nov 3, 2026')
  })

  it('crosses the date line correctly: late UTC evening is the next Manila day', () => {
    expect(formatManila(new Date('2026-11-03T20:30:00.000Z'), DT)).toBe('Nov 4, 2026, 4:30 AM')
  })
})
