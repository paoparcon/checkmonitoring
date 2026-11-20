import { OTHER_PAYMENT_METHODS, methodLabel } from '@/lib/integrations/acumatica/other-payments'
import { DISPLAY_MARKINGS } from '@/lib/payments/marking'
import type { PaymentRow } from '@/lib/payments/query'
import type { KitColumn } from '@/lib/table-kit/types'
import { totalsByCurrency, type CurrencyTotal } from '@/lib/transmittal'

/**
 * The OTHER PAYMENTS screen's columns, values and cards. Pure: the client
 * table and its tests read this; nothing here touches the database.
 */

export const PAYMENTS_TABLE_ID = 'other-payments'

const distinct = (values: readonly (string | null)[]) =>
  [...new Set(values.filter((v): v is string => v !== null && v !== ''))].sort().map((v) => ({ value: v, label: v }))

export function paymentColumns(rows: readonly PaymentRow[]): KitColumn[] {
  const methods = [...new Set([...OTHER_PAYMENT_METHODS, ...rows.map((r) => r.method)])]
  return [
    { key: 'referenceNbr', label: 'CV NO.', kind: 'text', locked: true, className: 'tabular-nums' },
    { key: 'method', label: 'METHOD', kind: 'enum', multi: true, options: methods.map((m) => ({ value: m, label: methodLabel(m) })) },
    { key: 'marking', label: 'MARKING', kind: 'enum', multi: true, options: DISPLAY_MARKINGS.map((m) => ({ value: m, label: m })) },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: distinct(rows.map((r) => r.company ?? r.branch)) },
    { key: 'paymentDate', label: 'PAYMENT DATE', kind: 'date' },
    { key: 'currency', label: 'CURRENCY', kind: 'enum', options: distinct(rows.map((r) => r.currency)) },
    { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'paymentRef', label: 'REFERENCE', kind: 'text' },
    { key: 'cashAccount', label: 'BANK ACCOUNT', kind: 'enum', options: distinct(rows.map((r) => r.cashAccount)) },
    { key: 'acumaticaStatus', label: 'ACUMATICA', kind: 'enum', options: distinct(rows.map((r) => r.acumaticaStatus)) },
    { key: 'processedDate', label: 'PROCESSED ON', kind: 'date' },
    { key: 'clearedDate', label: 'CLEARED ON', kind: 'date' },
    { key: 'bankReference', label: 'BANK REFERENCE', kind: 'text' },
    { key: 'remarks', label: 'REMARKS', kind: 'text' },
    { key: 'description', label: 'DESCRIPTION', kind: 'text', defaultHidden: true },
    { key: 'markedBy', label: 'MARKED BY', kind: 'text', defaultHidden: true },
    { key: 'tenant', label: 'TENANT', kind: 'enum', defaultHidden: true, options: distinct(rows.map((r) => r.tenant)) },
  ]
}

/** What the kit filters and sorts on: strings, dates as YYYY-MM-DD, null for nothing. */
export function paymentValue(r: PaymentRow, key: string): string | null {
  switch (key) {
    case 'marking': return r.display
    case 'company': return r.company ?? r.branch
    default: {
      const v = (r as unknown as Record<string, unknown>)[key]
      return typeof v === 'string' && v !== '' ? v : null
    }
  }
}

export type MarkingCard = { label: string; count: number; totals: CurrencyTotal[] }

/**
 * One card per marking the column can show, plus ALL. Amounts per currency,
 * never mixed; ALL's amounts leave out CANCELLED payments (voided in
 * Acumatica), which are counted.
 */
export function markingCards(rows: readonly PaymentRow[]): { all: MarkingCard; cards: MarkingCard[] } {
  const totals = (rs: readonly PaymentRow[]) =>
    totalsByCurrency(rs.filter((r) => r.currency !== null).map((r) => ({ amount: r.amount, currency: r.currency! })))
  return {
    all: { label: 'ALL', count: rows.length, totals: totals(rows.filter((r) => !r.voided)) },
    cards: DISPLAY_MARKINGS.map((label) => {
      const rs = rows.filter((r) => r.display === label)
      return { label, count: rs.length, totals: totals(rs) }
    }),
  }
}

/** The ticked payments still on the page that can take a marking (not voided). */
export function markable(rows: readonly PaymentRow[], selected: ReadonlySet<string>): PaymentRow[] {
  return rows.filter((r) => selected.has(r.id) && !r.voided)
}
