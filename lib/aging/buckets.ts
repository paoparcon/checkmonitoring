import { manilaToday } from '@/lib/manila-day'

/**
 * AGING — the Supplier Portal's buckets (spec 2026-10-15-aging-module-design.md).
 *
 * Copied as a rule from `Supplier Portal/src/aging/store.js` (`bucketOf`) and
 * `src/data/due.js` (`neverAges`), never fetched: the portal client sends only
 * (rule 12). The axis is days past DUE DATE, not the check date, which is
 * why this is not `lib/forecast/buckets.ts`. Pure: `now` is passed in.
 */

export const AGING_BUCKETS = ['current', 'b30', 'b60', 'b90', 'b90plus', 'noDue'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'CURRENT',
  b30: '1–30 DAYS',
  b60: '31–60 DAYS',
  b90: '61–90 DAYS',
  b90plus: 'OVER 90 DAYS',
  noDue: 'NO DUE DATE',
}

export const OVERDUE_BUCKETS: readonly AgingBucket[] = ['b30', 'b60', 'b90', 'b90plus']

// The portal's user ruling of 2026-10-08: COD, PDC, dated checks and 100PBD
// are always current. Compared with every space removed, so "PDC 30" is PDC30.
const NEVER_AGES_PREFIXES = ['COD', 'PDC', 'DATCHECK', 'DATEDCHECK', '100PBD', '100BPD']

export function neverAges(terms: string | null): boolean {
  const key = (terms ?? '').toUpperCase().replace(/\s+/g, '')
  return key !== '' && NEVER_AGES_PREFIXES.some((p) => key.startsWith(p))
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Whole Manila days from the due day to today; positive once it is overdue. */
export function daysPastDue(dueDate: Date, now: Date): number {
  return Math.round((dayMs(manilaToday(now)) - dayMs(manilaToday(dueDate))) / DAY_MS)
}

export function bucketOfDays(days: number): Exclude<AgingBucket, 'noDue'> {
  if (days <= 0) return 'current'
  if (days <= 30) return 'b30'
  if (days <= 60) return 'b60'
  if (days <= 90) return 'b90'
  return 'b90plus'
}

export type BillTerms = { dueDate: Date | null; termsCode: string | null }
export type CheckAging = { dueDate: Date | null; daysPastDue: number | null; bucket: AgingBucket }

/**
 * A check pays one or more bills; the earliest due date among the bills that
 * age decides — the most overdue bill is the one that matters. A never-aging
 * bill contributes no date. Only never-aging bills: CURRENT. Nothing dated:
 * NO DUE DATE.
 */
export function ageCheck(bills: readonly BillTerms[], now: Date): CheckAging {
  let earliest: Date | null = null
  let anyNeverAges = false
  for (const b of bills) {
    if (neverAges(b.termsCode)) { anyNeverAges = true; continue }
    if (b.dueDate && (earliest === null || b.dueDate < earliest)) earliest = b.dueDate
  }
  if (earliest) {
    const days = daysPastDue(earliest, now)
    return { dueDate: earliest, daysPastDue: days, bucket: bucketOfDays(days) }
  }
  if (anyNeverAges) return { dueDate: null, daysPastDue: 0, bucket: 'current' }
  return { dueDate: null, daysPastDue: null, bucket: 'noDue' }
}
