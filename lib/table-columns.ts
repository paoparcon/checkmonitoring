/**
 * The dashboard table's column set: keys, labels, the default, and the
 * export link's column order.
 *
 * Pure: no database, no `window`, no DOM. Which columns a viewer shows, in
 * what order, is the table kit's per-browser layout
 * (`check-monitoring.table.checks.v1`, lib/table-kit/main-list.ts), migrated
 * once from the `COLUMN_STORAGE_KEY` value below. It is never written to the
 * database: which columns someone likes is not a fact about a check.
 */

export const COLUMN_KEYS = [
  'checkNumber',
  'apvNumbers',
  'poNumbers',
  'payeeName',
  'companyCode',
  'bank',
  'checkDate',
  'amount',
  'status',
  'availablePickupDate',
  'scheduledPickupDate',
  'releasedAt',
  'action',
] as const

export type ColumnKey = (typeof COLUMN_KEYS)[number]

// ALL CAPS to match every other label on the screen.
export const COLUMN_LABELS: Record<ColumnKey, string> = {
  checkNumber: 'CHECK NUMBER',
  apvNumbers: 'APV NUMBER',
  poNumbers: 'PO NUMBER',
  payeeName: 'SUPPLIER NAME',
  companyCode: 'COMPANY',
  bank: 'BANK',
  checkDate: 'CHECK DATE',
  amount: 'AMOUNT',
  status: 'STATUS',
  availablePickupDate: 'AVAILABLE DATE',
  scheduledPickupDate: 'PICKUP SCHEDULE',
  // When the release was recorded HERE. Blank on every release the register
  // load imported or a catch-up moved — that is the fact, not a gap to fill.
  releasedAt: 'DATE RELEASED',
  action: 'ACTION',
}

/**
 * Hidden until shown in Column Configuration (client, 2026-10-06: "the columns still scroll
 * sideways, hide some by default"). Still offered there and in the export;
 * only the default is narrower.
 */
const HIDDEN_BY_DEFAULT: readonly ColumnKey[] = ['availablePickupDate', 'scheduledPickupDate']

/**
 * What the table renders before any preference has loaded — every column but
 * those hidden by default.
 *
 * This matters more than it looks. The preference can only be read in an
 * effect, after the first paint, so the first render must already be a working
 * table. Defaulting to "nothing until we know" would give a fresh browser, a
 * slow one, and one with storage disabled a flash of an empty table instead.
 */
export const DEFAULT_COLUMNS: readonly ColumnKey[] = COLUMN_KEYS.filter((k) => !HIDDEN_BY_DEFAULT.includes(k))

// The pre-kit chooser's key, read once by the table kit to migrate a choice.
// Bumped if the key set ever changed shape. An older version's value simply
// is not read and the reader falls back to the full table, which is the
// correct outcome and needs no migration.
// v2 (2026-10-01): PO NUMBER added. A v1 choice was a list of the columns that
// existed then, and read under v2 it would hide the new one for everybody who
// had ever ticked a box.
// Since part C (2026-10-01) the array is the visible columns IN DISPLAY ORDER.
// v3 (2026-10-06): the default hides AVAILABLE DATE and PICKUP SCHEDULE. A v2
// choice made under the old default listed them as shown, so it is not read.
// A v2 value written before that is in canonical order and reads as the default
// order with the same visibility, so the key is not bumped again.
export const COLUMN_STORAGE_KEY = 'check-monitoring.columns.v3'

/** The export link with `cols=` in the viewer's order (ACTION is not a file column). */
export function withColumnOrder(href: string, order: readonly ColumnKey[]): string {
  const [path, query = ''] = href.split('?')
  const qs = new URLSearchParams(query)
  qs.set('cols', order.filter((k) => k !== 'action').join(','))
  return `${path}?${qs.toString()}`
}
