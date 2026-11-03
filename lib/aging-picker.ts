import type { KitColumn } from '@/lib/table-kit/types'
import { amountToCentavos, formatAmount } from '@/lib/transmittal'
import { AGING_BUCKETS, AGING_LABELS, OVERDUE_BUCKETS, type AgingBucket } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'

/**
 * AGING's picker, the pure parts (spec 2026-10-15). The table kit filters,
 * sorts and lays out the rows, as on TRANSMITTAL; this module describes the
 * columns, and adds the bucket strip and the selection in centavos (rule 8).
 * Counts cover every check passed in, whatever its currency or amount, so a
 * card's count is the number of rows its table shows. Peso amounts cover PHP
 * checks with a readable amount only (totals are never mixed across
 * currencies); `nonPhp` and `unpriced` say what those amounts leave out.
 */

// v2: STATUS is a new visible column, which a layout stored under v1 would hide.
export const AGING_TABLE_ID = 'aging.by-bucket.v2'

/** One amount column per bucket: a check's amount sits under its own bucket's column. */
export const BUCKET_COLUMN_KEYS: Record<AgingBucket, string> = {
  current: 'b_current', b30: 'b_b30', b60: 'b_b60', b90: 'b_b90', b90plus: 'b_b90plus', noDue: 'b_noDue',
}

const LABELS: Record<string, string> = {
  checkNumber: 'CHECK NO.', status: 'STATUS', cvNumber: 'CV', apvNumbers: 'APV', poNumbers: 'PO NUMBER', payee: 'PAYEE',
  company: 'COMPANY', bank: 'BANK', checkDate: 'CHECK DATE', dueDate: 'DUE DATE',
  daysPastDue: 'DAYS PAST DUE', bucket: 'BUCKET', amount: 'AMOUNT',
}

const opts = (vs: readonly string[]) => vs.map((v) => ({ value: v, label: v }))

export function agingColumns(companies: readonly string[], banks: readonly string[]): KitColumn[] {
  const text = (key: string): KitColumn => ({ key, label: LABELS[key], kind: 'text' })
  return [
    { ...text('checkNumber'), className: 'font-medium', locked: true },
    {
      key: 'status', label: LABELS.status, kind: 'enum',
      options: [{ value: 'SIGNED', label: 'SIGNED' }, { value: 'READY_FOR_RELEASE', label: 'READY FOR RELEASE' }],
    },
    text('cvNumber'),
    text('apvNumbers'),
    text('poNumbers'),
    text('payee'),
    { key: 'company', label: LABELS.company, kind: 'enum', options: opts(companies) },
    { key: 'bank', label: LABELS.bank, kind: 'enum', options: opts(banks) },
    { key: 'checkDate', label: LABELS.checkDate, kind: 'date' },
    { key: 'dueDate', label: LABELS.dueDate, kind: 'date' },
    { key: 'daysPastDue', label: LABELS.daysPastDue, kind: 'amount', align: 'right', className: 'tabular-nums' },
    ...AGING_BUCKETS.map((b): KitColumn => ({
      key: BUCKET_COLUMN_KEYS[b], label: AGING_LABELS[b], kind: 'amount', align: 'right', className: 'tabular-nums',
    })),
    {
      key: 'bucket', label: LABELS.bucket, kind: 'enum', defaultHidden: true,
      options: AGING_BUCKETS.map((b) => ({ value: b, label: AGING_LABELS[b] })),
    },
    { key: 'amount', label: LABELS.amount, kind: 'amount', align: 'right', className: 'tabular-nums', defaultHidden: true },
  ]
}

const BUCKET_BY_COLUMN = new Map<string, AgingBucket>(AGING_BUCKETS.map((b) => [BUCKET_COLUMN_KEYS[b], b]))

export function agingValue(r: AgingRow, key: string): string | null {
  const columnBucket = BUCKET_BY_COLUMN.get(key)
  if (columnBucket) return columnBucket === r.bucket ? r.amount : null
  switch (key) {
    case 'apvNumbers': return r.apvNumbers.join(', ') || null
    case 'poNumbers': return r.poNumbers.join(', ') || null
    case 'daysPastDue': return r.daysPastDue === null ? null : String(r.daysPastDue)
    default: {
      const v = (r as Record<string, unknown>)[key]
      return typeof v === 'string' && v !== '' ? v : null
    }
  }
}

export type StripTotal = { count: number; amount: string }

const ZERO = BigInt(0)

/** Every row is counted; only PHP rows with a readable amount add to the sum. */
function total(rows: readonly AgingRow[]): StripTotal {
  let sum = ZERO
  for (const r of rows) {
    if (r.currency !== 'PHP' || r.amount === null) continue
    const c = amountToCentavos(r.amount)
    if (c === null) continue
    sum += c
  }
  return { count: rows.length, amount: formatAmount(centavosText(sum)) }
}

/** True when a row's amount is left out of the peso sums. */
function unpricedPhp(r: AgingRow): boolean {
  return r.currency === 'PHP' && (r.amount === null || amountToCentavos(r.amount) === null)
}

/** Centavos back to a plain decimal string (`"-1234.05"`) for `formatAmount`. */
function centavosText(c: bigint): string {
  const neg = c < ZERO
  const abs = neg ? -c : c
  return `${neg ? '-' : ''}${(abs / BigInt(100)).toString()}.${(abs % BigInt(100)).toString().padStart(2, '0')}`
}

export function stripTotals(rows: readonly AgingRow[]) {
  const buckets = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, total(rows.filter((r) => r.bucket === b))]),
  ) as Record<AgingBucket, StripTotal>
  return {
    buckets,
    overdue: total(rows.filter((r) => OVERDUE_BUCKETS.includes(r.bucket))),
    all: total(rows),
    nonPhp: rows.filter((r) => r.currency !== 'PHP').length,
    unpriced: rows.filter(unpricedPhp).length,
  }
}

/** The TOTAL row's bucket cells: every row counted, PHP readable amounts summed. */
export function bucketColumnTotals(rows: readonly AgingRow[]): Record<AgingBucket, StripTotal> {
  return Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, total(rows.filter((r) => r.bucket === b))]),
  ) as Record<AgingBucket, StripTotal>
}

export type BucketChoice = 'ALL' | 'OVERDUE' | AgingBucket

export function inBucket(rows: readonly AgingRow[], choice: BucketChoice): AgingRow[] {
  if (choice === 'ALL') return [...rows]
  if (choice === 'OVERDUE') return rows.filter((r) => OVERDUE_BUCKETS.includes(r.bucket))
  return rows.filter((r) => r.bucket === choice)
}

export function selectionTotal(rows: readonly AgingRow[], selected: ReadonlySet<string>): StripTotal {
  return total(rows.filter((r) => selected.has(r.id)))
}

/**
 * The selection as it can be submitted: only ids of SIGNED rows still on the
 * page, in the rows' order. An id whose check has left the list (readied,
 * voided, refreshed away) is dropped, never submitted — and so is a
 * READY_FOR_RELEASE row, which is already available and must never reach
 * `bulkReadyForReleaseAction` from this page.
 */
export function effectiveSelection(rows: readonly AgingRow[], selected: ReadonlySet<string>): AgingRow[] {
  return rows.filter((r) => r.status === 'SIGNED' && selected.has(r.id))
}
