import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { OutstandingLine } from '@/lib/recon/summary'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtIso = (day: string | null) => (day ? fmtDay(new Date(`${day}T00:00:00Z`)) : '—')

/** The cheques behind one account's figure. On the table kit since 2026-10-13: sort and filter them in the browser. */
export function OutstandingList({ lines }: { lines: readonly OutstandingLine[] }) {
  const columns: KitColumn[] = [
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'tabular-nums' },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'checkDate', label: 'CHECK DATE', kind: 'date' },
    { key: 'issued', label: 'ISSUED', kind: 'date' },
    { key: 'days', label: 'DAYS', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'clearing', label: 'CLEARING', kind: 'enum',
      options: [...new Set(lines.map((l) => l.clearingStatus))].sort().map((v) => ({ value: v, label: v })) },
    { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
  ]
  const rows: KitRow[] = lines.map((l) => ({
    key: l.id,
    values: {
      checkNumber: l.checkNumber, payee: l.payee, checkDate: dateValue(l.checkDate), issued: l.issuedDay,
      days: l.days === null || l.days === undefined ? null : String(l.days), clearing: l.clearingStatus, amount: String(l.amount),
    },
    cells: {
      checkNumber: <Link prefetch={false} href={`/checks/${l.id}`} className="underline underline-offset-2">{l.checkNumber}</Link>,
      payee: l.payee ?? '—',
      checkDate: fmtDay(l.checkDate),
      issued: <>{fmtIso(l.issuedDay)}{l.basis === 'CHECK DATE' && <span className="ml-2 text-xs text-slate-500">from register</span>}</>,
      days: l.days ?? '—',
      clearing: l.clearingStatus,
      amount: formatMoney(l.amount, l.currency),
    },
  }))
  return <KitTable tableId="recon-outstanding" columns={columns} rows={rows} />
}
