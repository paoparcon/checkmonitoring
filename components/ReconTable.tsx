import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { ReconSummary, AccountTotal } from '@/lib/recon/summary'
import { reconHref, type ReconParams } from '@/lib/recon-view'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'

function Totals({ totals }: { totals: AccountTotal[] }) {
  if (totals.length === 0) return <span className="text-slate-300">—</span>
  return (
    <div className="space-y-0.5">
      {totals.map((t) => (
        <div key={t.currency} className="tabular-nums">
          <span className="text-slate-500">{t.count.toLocaleString('en-PH')} · </span>{formatMoney(t.total, t.currency)}
        </div>
      ))}
    </div>
  )
}

/**
 * One row per cash account, in the Cash Balance sheet's order; each links to its list.
 * On the table kit since 2026-10-13. The OUTSTANDING column sorts by the number of
 * outstanding checks and offers no filter, because an account's money is per currency
 * and a typed amount would silently mean a count; the cell still lists every
 * currency's count and total.
 */
export function ReconTable({ summary, params }: { summary: ReconSummary; params: ReconParams }) {
  const opts = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'account', label: 'ACCOUNT', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'bank', label: 'BANK', kind: 'enum', options: opts(summary.accounts.map((a) => a.bank)) },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: opts(summary.accounts.map((a) => a.company)) },
    // Several currencies per account: the cell lists them; the sort reads the count and there is no filter.
    { key: 'outstanding', label: 'OUTSTANDING · AMOUNT', kind: 'amount', align: 'right', noFilter: true },
  ]
  const rows: KitRow[] = summary.accounts.map((a) => ({
    key: a.accountId ?? a.account,
    values: {
      account: a.account, bank: a.bank, company: a.company,
      outstanding: String(a.totals.reduce((n, t) => n + t.count, 0)),
    },
    cells: {
      account: a.accountId
        ? <Link href={reconHref({ ...params, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link>
        : a.account,
      bank: a.bank ?? '—',
      company: a.company ?? '—',
      outstanding: <Totals totals={a.totals} />,
    },
  }))
  return (
    <KitTable
      tableId="recon-accounts" columns={columns} rows={rows}
      footer={{ account: 'TOTAL', outstanding: <Totals totals={summary.totals} /> }}
    />
  )
}
