import type { Prisma } from '@prisma/client'
import { COLUMN_KEYS, COLUMN_LABELS, type ColumnKey } from './table-columns'

/**
 * How the LIST screen's table is ordered (spec 2026-10-01, part C1).
 *
 * Pure: no database, no clock, no `document`. The page reads `sort`/`dir` from
 * the URL, falls back to the `cm_sort` cookie, then to `DEFAULT_SORT` — and the
 * export and the printed sheet run the same resolver, so all three agree.
 *
 * Sorting is SERVER-SIDE over every matching cheque. The list shows at most
 * 200 rows; sorting them in the browser would sort the wrong set.
 *
 * Nulls go LAST in BOTH directions — the `checkDate` lesson: Postgres puts
 * NULLs first on a descending sort, and a list that opens on a screen of em
 * dashes buries the cheques somebody has to act on.
 */

export type SortKey = Exclude<ColumnKey, 'action'>
export type SortDir = 'asc' | 'desc'
export type SortSpec = { key: SortKey; dir: SortDir }

export const SORT_KEYS: readonly SortKey[] = COLUMN_KEYS.filter((k): k is SortKey => k !== 'action')

export const DEFAULT_SORT: SortSpec = { key: 'checkDate', dir: 'desc' }

/**
 * The four orders Prisma cannot express, done in `lib/queries.ts` over the full
 * matching set: APV and PO sort by their FIRST value (an array element, and a
 * union with the bills); BANK cannot put a cheque with no cash account last on
 * a descending sort (`nulls` exists only on nullable scalars); DATE RELEASED
 * shows `releasedAt`, else the register's `statedReleaseDate`, and sorts by
 * the date it shows.
 */
export const APP_SORTED_KEYS = ['apvNumbers', 'poNumbers', 'bank', 'releasedAt'] as const satisfies readonly SortKey[]
export type AppSortKey = (typeof APP_SORTED_KEYS)[number]
export type DbSortKey = Exclude<SortKey, AppSortKey>

export function isAppSorted(key: SortKey): key is AppSortKey {
  return (APP_SORTED_KEYS as readonly string[]).includes(key)
}

export const SORT_COOKIE = 'cm_sort'
export const SORT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export const isSortKey = (v: unknown): v is SortKey =>
  typeof v === 'string' && (SORT_KEYS as readonly string[]).includes(v)
const isSortDir = (v: unknown): v is SortDir => v === 'asc' || v === 'desc'

/** Both halves valid, or no sort at all — an unknown value cannot widen anything, so it falls back. */
export function parseSort(key: string | undefined, dir: string | undefined): SortSpec | null {
  const k = key?.trim()
  const d = dir?.trim()
  return isSortKey(k) && isSortDir(d) ? { key: k, dir: d } : null
}

export function formatSortCookie(s: SortSpec): string {
  return `${s.key}:${s.dir}`
}

export function parseSortCookie(raw: string | undefined | null): SortSpec | null {
  if (!raw) return null
  const parts = raw.split(':')
  return parts.length === 2 ? parseSort(parts[0], parts[1]) : null
}

/** The `document.cookie` assignment for a header click; `null` deletes the memory. */
export function sortCookieString(next: SortSpec | null): string {
  return next
    ? `${SORT_COOKIE}=${formatSortCookie(next)}; Path=/; Max-Age=${SORT_COOKIE_MAX_AGE}; SameSite=Lax`
    : `${SORT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

/** One cookie's value from a `Cookie` request header — the export route has no `cookies()`. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return undefined
}

export function sameSort(a: SortSpec, b: SortSpec): boolean {
  return a.key === b.key && a.dir === b.dir
}

export function describeSort(s: SortSpec): string {
  return `${COLUMN_LABELS[s.key]} (${s.dir === 'asc' ? 'ASCENDING' : 'DESCENDING'})`
}

export type SortValue = string | number | null

/** Nulls last in both directions; otherwise plain `<` / `>`, reversed for desc. */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const c = a < b ? -1 : a > b ? 1 : 0
  return dir === 'asc' ? c : -c
}

/**
 * The database's half. `checkNumber asc` is the tiebreak the spec names; `id
 * asc` after it because cheque numbers repeat across companies, and two rows
 * that compare equal must not swap places between the screen and the export.
 * STATUS orders by the enum's declaration order — the ladder.
 */
export function dbOrderBy(key: DbSortKey, dir: SortDir): Prisma.CheckOrderByWithRelationInput[] {
  const last = { sort: dir, nulls: 'last' } as const
  const tie: Prisma.CheckOrderByWithRelationInput[] = [{ checkNumber: 'asc' }, { id: 'asc' }]
  switch (key) {
    case 'checkNumber': return [{ checkNumber: dir }, { id: 'asc' }]
    case 'payeeName': return [{ payeeName: last }, ...tie]
    case 'companyCode': return [{ company: { code: dir } }, ...tie]
    case 'checkDate': return [{ checkDate: last }, ...tie]
    case 'amount': return [{ amount: last }, ...tie]
    case 'status': return [{ status: dir }, ...tie]
    case 'availablePickupDate': return [{ availablePickupDate: last }, ...tie]
    case 'scheduledPickupDate': return [{ scheduledPickupDate: last }, ...tie]
    default: {
      const unreachable: never = key
      throw new Error(`No database order for ${String(unreachable)}`)
    }
  }
}
