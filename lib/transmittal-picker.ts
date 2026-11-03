import type { KitColumn } from '@/lib/table-kit/types'

/**
 * The transmittal's pick list (client, 2026-10-09: "include also filter and
 * customizable and adjustable columns"). Since 2026-10-13 the filtering,
 * sorting and column layout are the table kit's (`lib/table-kit/`), the same
 * as every other table; this module describes the rows and the columns.
 * Amounts stay decimal strings and compare in centavos (rule 8).
 */

export type TransmittalStatus = 'SIGNATURE_PENDING' | 'SIGNED' | 'RELEASED'

export type TransmittalCandidate = {
  id: string
  checkNumber: string
  cashAccount: string
  poNumber: string
  voucher: string
  payee: string
  amount: string | null
  currency: string
  status: TransmittalStatus
  company: string
}

export const PICK_COLUMNS = [
  'checkNumber', 'cashAccount', 'poNumber', 'voucher', 'payee', 'company', 'status', 'amount',
] as const
export type PickColumn = (typeof PICK_COLUMNS)[number]

export const PICK_LABELS: Record<PickColumn, string> = {
  checkNumber: 'CHECK NUMBER',
  cashAccount: 'CASH ACCOUNT',
  poNumber: 'PO NUMBER / VENDOR REF',
  voucher: 'VOUCHER NUMBER',
  payee: 'PAYEE',
  company: 'COMPANY',
  status: 'STATUS',
  amount: 'AMOUNT',
}

export const TRANSMITTAL_TABLE_ID = 'transmittal'
/** The pre-kit preference; its `{ order, hidden, widths }` shape is the kit's layout, read once. */
export const LEGACY_PREFS_KEY = 'check-monitoring.transmittal.columns.v1'

/** The sheet's own order first, then the extras the sheet does not carry. */
export function pickColumns(companies: readonly string[]): KitColumn[] {
  const text = (key: PickColumn): KitColumn => ({ key, label: PICK_LABELS[key], kind: 'text' })
  return [
    { ...text('checkNumber'), className: 'font-medium' },
    text('cashAccount'),
    text('poNumber'),
    text('voucher'),
    text('payee'),
    { key: 'amount', label: PICK_LABELS.amount, kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'company', label: PICK_LABELS.company, kind: 'enum', options: companies.map((c) => ({ value: c, label: c })) },
    // The status choice is the dropdown above the table.
    { key: 'status', label: PICK_LABELS.status, kind: 'enum', noFilter: true },
  ]
}

export function pickValue(c: TransmittalCandidate, key: string): string | null {
  switch (key as PickColumn) {
    case 'amount': return c.amount
    case 'status': return c.status.replace(/_/g, ' ')
    default: return c[key as Exclude<PickColumn, 'amount' | 'status'>] || null
  }
}

export type StatusChoice = 'ALL' | TransmittalStatus

/** ALL is SIGNATURE PENDING + SIGNED — RELEASED only on its own choice. */
export function byStatus(rows: readonly TransmittalCandidate[], status: StatusChoice): TransmittalCandidate[] {
  return rows.filter((c) => (status === 'ALL' ? c.status !== 'RELEASED' : c.status === status))
}
