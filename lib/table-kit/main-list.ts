import type { FilterOptions } from '@/lib/queries'
import { bankLabel } from '@/lib/export/report'
import { LIVE_STATUSES, CLOSED_STATUSES } from '@/lib/domain/check-status'
import { COLUMN_LABELS, COLUMN_STORAGE_KEY, type ColumnKey } from '@/lib/table-columns'
import { SORT_KEYS, type SortKey } from '@/lib/list-sort'
import { fromVisibleList, loadLayout, visibleColumns, type Layout } from './layout'
import { SERVER_AMOUNT_OPS, SERVER_DAY_OPS, type Binding } from './url-binding'
import type { KitColumn } from './types'

/**
 * The dashboard list in kit terms (spec 2026-10-13 §3). Browser-safe: the
 * table and EXPORT EXCEL's link both read it.
 */

export const MAIN_LIST_TABLE_ID = 'checks'

const day = (from: string, to: string): Binding => ({ kind: 'range', from, to, unit: 'day' })

/** The parameters `lib/column-filters.ts` and `lib/dashboard-params.ts` already parse — nothing new. */
export const MAIN_LIST_BINDINGS: Record<SortKey, Binding> = {
  checkNumber: { kind: 'text', param: 'f.checkNumber' },
  apvNumbers: { kind: 'text', param: 'f.apv' },
  poNumbers: { kind: 'text', param: 'f.po' },
  payeeName: { kind: 'text', param: 'f.payee' },
  companyCode: { kind: 'enum', param: 'company' },
  bank: { kind: 'enum', param: 'cashAccount' },
  checkDate: day('f.checkDateFrom', 'f.checkDateTo'),
  amount: { kind: 'range', from: 'f.amountMin', to: 'f.amountMax', unit: 'amount' },
  status: { kind: 'enum', param: 'f.status' },
  availablePickupDate: day('f.availablePickupDateFrom', 'f.availablePickupDateTo'),
  scheduledPickupDate: day('f.scheduledPickupDateFrom', 'f.scheduledPickupDateTo'),
  releasedAt: day('releasedFrom', 'releasedTo'),
}

const KINDS: Record<SortKey, KitColumn['kind']> = {
  checkNumber: 'text', apvNumbers: 'text', poNumbers: 'text', payeeName: 'text',
  companyCode: 'enum', bank: 'enum', checkDate: 'date', amount: 'amount', status: 'enum',
  availablePickupDate: 'date', scheduledPickupDate: 'date', releasedAt: 'date',
}

const STATUSES = [...LIVE_STATUSES, ...CLOSED_STATUSES]

export function mainListColumns(opts: {
  options: FilterOptions
  /** STATUS filters on ALL CHECKS only (the server ignores it elsewhere). */
  showStatus: boolean
  /** DATE RELEASED filters on RELEASED and ALL CHECKS only. */
  showReleasedRange: boolean
}): KitColumn[] {
  return SORT_KEYS.map((key): KitColumn => {
    const kind = KINDS[key]
    const col: KitColumn = { key, label: COLUMN_LABELS[key], kind }
    if (key === 'checkNumber' || key === 'status') col.locked = true
    if (key === 'availablePickupDate' || key === 'scheduledPickupDate') col.defaultHidden = true
    if (key === 'amount') { col.align = 'right'; col.ops = SERVER_AMOUNT_OPS }
    if (kind === 'date') col.ops = SERVER_DAY_OPS
    if (key === 'companyCode') col.options = opts.options.companies.map((c) => ({ value: c.id, label: c.code }))
    if (key === 'bank') {
      col.options = opts.options.cashAccounts.map((a) => ({ value: a.id, label: bankLabel(a.code, a.bankCode) ?? a.code }))
    }
    if (key === 'status') {
      col.options = STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))
      col.multi = true
      if (!opts.showStatus) col.noFilter = true
    }
    if (key === 'releasedAt' && !opts.showReleasedRange) col.noFilter = true
    return col
  })
}

/** The columns as far as layout goes — options do not matter for order and visibility. */
const LAYOUT_COLUMNS = mainListColumns({ options: { companies: [], cashAccounts: [] }, showStatus: true, showReleasedRange: true })

/** The pre-kit preference (`columns.v3`: the visible keys in order), read once on first load. */
export function legacyMainList(s: Pick<Storage, 'getItem'>): Layout | null {
  return fromVisibleList(s.getItem(COLUMN_STORAGE_KEY), LAYOUT_COLUMNS)
}

/** EXPORT EXCEL's `cols=`: the viewer's visible columns in order. */
export function readMainListOrder(storage: Pick<Storage, 'getItem'>): ColumnKey[] {
  const layout = loadLayout(storage, MAIN_LIST_TABLE_ID, LAYOUT_COLUMNS, legacyMainList)
  return visibleColumns(LAYOUT_COLUMNS, layout).map((c) => c.key as ColumnKey)
}
