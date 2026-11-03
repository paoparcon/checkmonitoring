import Link from 'next/link'
import { voucherStatusPillClass } from '@/lib/status-pill'
import type { VoucherRow } from '@/lib/export/voucher-index'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

const distinct = (xs: (string | null)[]) =>
  [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().map((v) => ({ value: v, label: v }))

/**
 * One voucher per row, exactly as the Excel index lays it out, minus RELEASED
 * — not because it is empty (`markReleased` in `lib/domain/actions.ts` writes
 * it; only register- and backfill-derived releases leave it null), but because
 * a release date belongs on the cheque's own page, which the CHECK NUMBER
 * column already links to. The Excel index still carries the column, for a
 * reader with no browser open.
 *
 * Since 2026-10-13 on the table kit: the rows this page drew can be sorted,
 * filtered and arranged in the browser — `capped` says when that is fewer than
 * matched. The cheque number is a link to the cheque, the status is a pill,
 * and the remarks wrap. Not `CheckTable`, whose column picker, checkboxes and
 * bulk bar are about cheques Finance can act on — nothing on this screen is
 * acted on, it is read.
 *
 * A blank CHECK NUMBER is drawn as a dash, and the row's STATUS and REMARKS say
 * why. The explanation under the table on the page repeats it in full.
 */
export function VoucherTable({ rows, capped }: { rows: readonly VoucherRow[]; capped: boolean }) {
  const columns: KitColumn[] = [
    { key: 'voucher', label: 'VOUCHER', kind: 'text', locked: true, className: 'whitespace-nowrap font-medium' },
    { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', className: 'whitespace-nowrap' },
    { key: 'bank', label: 'BANK', kind: 'enum', options: distinct(rows.map((r) => r.bank)), className: 'whitespace-nowrap text-slate-600' },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: distinct(rows.map((r) => r.company)), className: 'whitespace-nowrap text-slate-600' },
    { key: 'status', label: 'STATUS', kind: 'enum', options: distinct(rows.map((r) => r.status)), className: 'whitespace-nowrap' },
    { key: 'checkDate', label: 'CHECK DATE', kind: 'date', className: 'whitespace-nowrap text-slate-600' },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'supersedes', label: 'SUPERSEDES', kind: 'text', className: 'text-slate-600' },
    { key: 'remarks', label: 'REMARKS', kind: 'text', className: 'min-w-[24rem] text-slate-600' },
  ]
  const kitRows: KitRow[] = rows.map((r) => ({
    key: r.voucher,
    className: 'border-b border-slate-100 last:border-0 odd:bg-white even:bg-ground hover:bg-navy-bg',
    values: {
      voucher: r.voucher, checkNumber: r.checkNumber, bank: r.bank, company: r.company, status: r.status,
      checkDate: dateValue(r.checkDate), payee: r.payee, supersedes: r.supersedes, remarks: r.remarks,
    },
    cells: {
      voucher: r.voucher,
      checkNumber: r.checkId && r.checkNumber
        ? <Link prefetch={false} href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
        : '—',
      bank: r.bank ?? '—',
      company: r.company ?? '—',
      status: (
        <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${voucherStatusPillClass(r.status)}`}>
          {r.status}
        </span>
      ),
      checkDate: fmtDate(r.checkDate),
      payee: r.payee ?? '—',
      supersedes: r.supersedes ?? '—',
      remarks: r.remarks ?? '—',
    },
  }))
  return <KitTable tableId="vouchers" columns={columns} rows={kitRows} capped={capped} />
}
