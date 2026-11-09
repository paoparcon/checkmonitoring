import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import type { BankRecon } from '@/lib/bank-recon/recon'
import { reconHref } from '@/lib/recon-view'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'

const peso = (v: string | null) => (v === null ? <span className="text-slate-300">—</span> : <span className="tabular-nums">{formatMoney(v, 'PHP')}</span>)

function Variance({ value, ditAssumedNone }: { value: string | null; ditAssumedNone: boolean }) {
  if (value === null) return <span className="text-slate-300">—</span>
  const zero = /^-?0\.00$/.test(value)
  return (
    <span className={`tabular-nums font-semibold ${zero ? 'text-success-ink' : 'text-danger-ink'}`}>
      {zero ? 'RECONCILED' : formatMoney(value, 'PHP')}
      {ditAssumedNone && !zero && <span className="block text-[11px] font-normal text-slate-500">no deposit in transit typed</span>}
    </span>
  )
}

/**
 * One row per account of Finance's cash schedule, in the schedule's own
 * order (`lib/bank-recon/recon.ts` decides every figure): the bank balance
 * from the Cash workbook, adjusted for deposits in transit and the checks
 * still out, beside the book balance Finance types. Every amount is in
 * pesos: the schedule carries a foreign-currency account at its peso
 * equivalent, and the CUR column says which accounts those are.
 */
export function BankReconTable({ recon, asOfDay }: { recon: BankRecon; asOfDay: string }) {
  const opts = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'account', label: 'ACCOUNT', kind: 'text', locked: true, className: 'font-medium' },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: opts(recon.lines.map((l) => l.companyLabel)) },
    { key: 'currency', label: 'CUR', kind: 'enum', options: opts(recon.lines.map((l) => l.currency)) },
    { key: 'books', label: 'CHECK BOOK', kind: 'text', className: 'whitespace-nowrap' },
    { key: 'bank', label: 'BANK BALANCE', kind: 'amount', align: 'right' },
    { key: 'dit', label: '+ DEPOSITS IN TRANSIT', kind: 'amount', align: 'right' },
    { key: 'oc', label: '− OUTSTANDING CHECKS', kind: 'amount', align: 'right' },
    { key: 'adjusted', label: '= ADJUSTED BANK BALANCE', kind: 'amount', align: 'right', className: 'font-semibold' },
    { key: 'book', label: 'BOOK BALANCE', kind: 'amount', align: 'right' },
    { key: 'variance', label: 'VARIANCE', kind: 'amount', align: 'right' },
    { key: 'note', label: 'NOTE', kind: 'text', className: 'text-slate-600' },
    { key: 'source', label: 'BANK BALANCE FROM', kind: 'text', className: 'text-[11px] text-slate-500', defaultHidden: true },
  ]
  const rows: KitRow[] = recon.lines.map((l) => ({
    key: l.id,
    values: {
      account: l.label, company: l.companyLabel, currency: l.currency,
      books: l.books.map((b) => b.code).join(' '),
      bank: l.bankBalance, dit: l.depositsInTransit, oc: l.outstanding?.total ?? null,
      adjusted: l.adjustedBank, book: l.bookBalance, variance: l.variance, note: l.note, source: l.bankSource,
    },
    cells: {
      account: l.label,
      company: l.companyLabel ?? '—',
      currency: l.currency,
      books: l.books.length === 0 ? <span className="text-slate-300">—</span> : l.books.map((b) => b.code).join(', '),
      book: peso(l.bookBalance),
      oc: l.outstanding === null
        ? <span className="text-slate-300">—</span>
        : (
          <span className="tabular-nums">
            {l.outstanding.count > 0 && l.books.length === 1
              ? <Link prefetch={false} href={reconHref({ asOf: asOfDay, account: l.books[0]!.id })} className="underline underline-offset-2">{formatMoney(l.outstanding.total, 'PHP')}</Link>
              : formatMoney(l.outstanding.total, 'PHP')}
            <span className="block text-[11px] text-slate-500">{l.outstanding.count.toLocaleString('en-PH')} check{l.outstanding.count === 1 ? '' : 's'}</span>
          </span>
        ),
      dit: peso(l.depositsInTransit),
      adjusted: peso(l.adjustedBank),
      bank: peso(l.bankBalance),
      variance: <Variance value={l.variance} ditAssumedNone={l.ditAssumedNone} />,
      note: l.note ?? '',
      source: l.bankSource ?? '',
    },
  }))
  const t = recon.totals
  return (
    <KitTable
      tableId="bank-recon" columns={columns} rows={rows}
      footer={{
        account: 'TOTAL (PHP)',
        bank: peso(t.bankBalance),
        dit: peso(t.depositsInTransit),
        oc: <span className="tabular-nums">{formatMoney(t.outstanding, 'PHP')}<span className="block text-[11px] font-normal text-slate-500">{t.outstandingCount.toLocaleString('en-PH')} {t.outstandingCount === 1 ? 'check' : 'checks'}</span></span>,
        adjusted: peso(t.adjustedBank),
        book: <span className="tabular-nums">{formatMoney(t.bookBalance, 'PHP')}<span className="block text-[11px] font-normal text-slate-500">{t.bookTyped} of {t.accounts} typed</span></span>,
        variance: t.bookTyped === 0 ? <span className="text-slate-300">—</span> : peso(t.variance),
      }}
    />
  )
}
