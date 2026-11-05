// components/NumberingTables.tsx
import Link from 'next/link'
import type { ReactNode } from 'react'
import { formatMoney } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { missingLabel, numberingHref, numberingTotals } from '@/lib/numbering-view'
import type { NumberingAccount } from '@/lib/numbering/query'
import type { SeriesCheque, SeriesEntry, SeriesStaged } from '@/lib/numbering/series'
import { runNoteStale, type InventoryLine, type InventoryNote } from '@/lib/numbering/inventory'
import { InventoryNoteCell, type InventoryNoteView } from '@/components/InventoryNoteCell'
import { MissingRunBand } from '@/components/MissingRunRows'
import { MissingPill } from '@/components/numbering-cells'
import { KitTable, type KitRow } from './table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { dateValue } from '@/lib/table-kit/match'

const fmtDay = (d: Date | null) =>
  d ? d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '—'
const fmtCount = (s: string) => (s.length <= 15 ? Number(s).toLocaleString('en-PH') : s)

const CHECK_COLUMNS: KitColumn[] = [
  { key: 'checkNumber', label: 'CHECK NUMBER', kind: 'text', locked: true, className: 'tabular-nums' },
  { key: 'checkDate', label: 'CHECK DATE', kind: 'date' },
  { key: 'payee', label: 'PAYEE', kind: 'text' },
  { key: 'amount', label: 'AMOUNT', kind: 'amount', align: 'right', className: 'tabular-nums' },
  { key: 'status', label: 'STATUS', kind: 'text' },
]

/**
 * The inventory columns (spec §H). INVENTORY holds the tick box and remarks on
 * every line; its filter is a dropdown, TICKED or UNTICKED (user request
 * 2026-11-03: "the ticked should have filter" — the old "contains" over the
 * words matched UNTICKED on TICKED), and it never sorts. REMARKS, hidden by
 * default, is the remark's text for a "contains" search; filtering on it
 * shows it beside the box.
 */
const TICK_OPTIONS = [{ value: 'TICKED', label: 'TICKED' }, { value: 'UNTICKED', label: 'UNTICKED' }] as const
const INVENTORY_COLUMN: KitColumn = { key: 'inventory', label: 'INVENTORY · TICK AND REMARKS', kind: 'enum', options: TICK_OPTIONS, locked: true, noSort: true, className: 'py-2' }
const REMARKS_COLUMN: KitColumn = { key: 'remarks', label: 'REMARKS (SEARCH)', kind: 'text', defaultHidden: true, noSort: true, className: 'max-w-xs text-xs text-slate-600' }

export const toView = (n: InventoryNote): InventoryNoteView =>
  ({ ticked: n.ticked, remarks: n.remarks, updatedBy: n.updatedBy, updatedAt: n.updatedAt.toISOString() })

const inventoryValue = (n: InventoryNote | null) => (n?.ticked ? 'TICKED' : 'UNTICKED')
const remarksValue = (n: InventoryNote | null) => n?.remarks ?? null

/** The tag on a check with no check book shown where its number falls (spec §I): names Acumatica's cash account. */
const noBookTag = (c: SeriesCheque) => `NO CHECK BOOK · ${c.cashAccount ?? 'NO CASH ACCOUNT'}`

/** The tag on another book's check shown where this book is missing the number (2026-11-05). */
const otherBookTag = (book: string) => `IN ANOTHER BOOK · ${book}`

function checkRow(c: SeriesCheque, note?: string, noBook = false, otherBook?: string): KitRow {
  const tag = otherBook ? otherBookTag(otherBook) : noBook ? noBookTag(c) : null
  return {
    key: otherBook ? `${c.id}@${otherBook}` : c.id,
    className: otherBook ? 'border-b border-violet-100 bg-violet-50/70' : noBook ? 'border-b border-sky-100 bg-sky-50/70' : undefined,
    values: {
      checkNumber: c.checkNumber, checkDate: dateValue(c.checkDate), payee: c.payeeName,
      amount: c.amount === null ? null : String(c.amount),
      status: [(c.cleared ? 'CLEARED' : c.status).replace(/_/g, ' '), note, tag].filter((s) => s).join(' '),
    },
    cells: {
      checkNumber: <Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link>,
      checkDate: fmtDay(c.checkDate),
      payee: c.payeeName ?? '—',
      amount: formatMoney(c.amount, c.currency),
      status: (
        <>
          <StatusPill status={c.cleared ? 'CLEARED' : c.status} />
          {note && <span className="ml-2 text-xs font-semibold text-amber-700">{note}</span>}
          {tag && <span className={`ml-2 inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold tracking-wide ${otherBook ? 'bg-violet-100 text-violet-800' : 'bg-sky-100 text-sky-800'}`}>{tag}</span>}
        </>
      ),
    },
  }
}

function stagedRow(s: SeriesStaged): KitRow {
  return {
    key: `s-${s.acumaticaTenant}-${s.acumaticaRef}`,
    className: 'border-b border-slate-100 bg-slate-50 text-slate-600',
    values: {
      checkNumber: s.statedCheckRef, checkDate: dateValue(s.checkDate), payee: s.payeeName,
      amount: s.currency && s.amount !== null ? String(s.amount) : null, status: `STAGED ${s.acumaticaRef}`,
    },
    cells: {
      checkNumber: s.statedCheckRef,
      checkDate: fmtDay(s.checkDate),
      payee: s.payeeName ?? '—',
      amount: s.currency ? formatMoney(s.amount, s.currency) : '—',
      status: (
        <>
          <span className="inline-block whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold tracking-wide text-slate-700">STAGED</span>
          <span className="ml-2 text-xs text-slate-500">Acumatica {s.acumaticaRef}</span>
        </>
      ),
    },
  }
}

/** A data row with the inventory cell added: a held check's or a staged line's own tick and remarks. */
function withInventory(row: KitRow, checkBookId: string, checkNumber: string, note: InventoryNote | null): KitRow {
  if (!('values' in row)) return row
  return {
    ...row,
    values: { ...row.values, inventory: inventoryValue(note), remarks: remarksValue(note) },
    cells: {
      ...row.cells,
      inventory: <InventoryNoteCell checkBookId={checkBookId} checkNumber={checkNumber} note={note ? toView(note) : null} label={checkNumber} />,
      remarks: note?.remarks ?? '—',
    },
  }
}

/** One MISSING number as its own amber row (spec §H): no check, its own tick and remark. A data row, so it stays while the table is filtered or sorted. */
function missingNumberRow(checkBookId: string, number: string, note: InventoryNote | null): KitRow {
  return {
    key: `n-${number}`,
    className: 'border-b border-amber-200 bg-amber-50',
    values: {
      checkNumber: number, checkDate: null, payee: 'NO CHECK IN THIS SYSTEM', amount: null, status: 'MISSING',
      inventory: inventoryValue(note), remarks: remarksValue(note),
    },
    cells: {
      checkNumber: <span className="font-semibold text-amber-800">{number}</span>,
      checkDate: <span className="text-amber-800/60">—</span>,
      payee: <span className="text-amber-800/60">NO CHECK IN THIS SYSTEM</span>,
      amount: <span className="text-amber-800/60">—</span>,
      status: <MissingPill />,
      inventory: <InventoryNoteCell checkBookId={checkBookId} checkNumber={number} note={note ? toView(note) : null} label={number} />,
      remarks: note?.remarks ?? '—',
    },
  }
}

function entryRows(entries: readonly SeriesEntry[]): KitRow[] {
  return entries.map((e): KitRow => e.kind === 'MISSING'
    ? {
        key: `m-${e.from}`, className: 'border-b border-amber-200 bg-amber-50',
        band: <div className="px-4 py-3 font-semibold tabular-nums text-amber-800">{missingLabel(e)}</div>,
      }
    : e.kind === 'STAGED' ? stagedRow(e.staged) : checkRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : undefined, e.noBook, e.otherBook))
}

/** A non-zero count is a link into the book's lines with that set in force (user request 2026-11-03: "those numbers should be clickable"). */
const countLink = (href: string, node: ReactNode, nonZero: boolean) =>
  nonZero ? <Link prefetch={false} href={href} className="underline underline-offset-2">{node}</Link> : node

/**
 * One row per check book, and a TOTAL row over the books shown (user request
 * 2026-11-03). The check book links to its own series, and every non-zero
 * count links to the lines it counts: HELD opens the book, MISSING its MISSING
 * ONLY view, VOIDED / CANCELLED / STAGED / NO CHECK BOOK the lines with that
 * STATUS filter in force, TICKED the inventory filter, NOT NUMERIC and OUT OF
 * PATTERN their own tables below. TICKED is the inventory's count, held and
 * missing ticks alike.
 */
export function NumberingSummaryTable({ accounts, company }: { accounts: readonly NumberingAccount[]; company?: string }) {
  const t = numberingTotals(accounts)
  const count = (key: string, label: string): KitColumn => ({ key, label, kind: 'amount', align: 'right', className: 'tabular-nums' })
  const opts = (xs: string[]) => [...new Set(xs)].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'account', label: 'CHECK BOOK', kind: 'text', locked: true },
    { key: 'bank', label: 'BANK', kind: 'enum', options: opts(accounts.map((a) => a.bank)) },
    { key: 'company', label: 'COMPANY', kind: 'enum', options: opts(accounts.map((a) => a.company)) },
    { key: 'first', label: 'FIRST', kind: 'text', className: 'tabular-nums' },
    { key: 'last', label: 'LAST', kind: 'text', className: 'tabular-nums' },
    count('held', 'HELD'), count('voided', 'VOIDED'), count('cancelled', 'CANCELLED'), count('staged', 'STAGED'),
    count('missing', 'MISSING'), count('ticked', 'TICKED'), count('notNumeric', 'NOT NUMERIC'), count('outOfPattern', 'OUT OF PATTERN'),
    count('noBook', 'NO CHECK BOOK'), count('otherBook', 'IN ANOTHER BOOK'),
  ]
  const rows: KitRow[] = accounts.map((a) => {
    const s = a.series.summary
    const base = numberingHref({ company, account: a.accountId })
    const show = (show: 'voided' | 'cancelled' | 'staged' | 'ticked' | 'noBook' | 'otherBook') => numberingHref({ company, account: a.accountId, show })
    return {
      key: a.accountId,
      values: {
        account: a.account, bank: a.bank, company: a.company, first: s.first ?? null, last: s.last ?? null,
        held: String(s.held), voided: String(s.voided), cancelled: String(s.cancelled), staged: String(s.staged),
        missing: s.missingNumbers, ticked: a.inventory.ticked, notNumeric: String(s.notNumeric), outOfPattern: String(s.outOfPattern),
        noBook: String(s.noBook), otherBook: String(s.otherBook),
      },
      cells: {
        account: <Link prefetch={false} href={base} className="underline underline-offset-2">{a.account}</Link>,
        bank: a.bank, company: a.company, first: s.first ?? '—', last: s.last ?? '—',
        held: countLink(base, s.held.toLocaleString('en-PH'), s.held > 0),
        voided: countLink(show('voided'), s.voided.toLocaleString('en-PH'), s.voided > 0),
        cancelled: countLink(show('cancelled'), s.cancelled.toLocaleString('en-PH'), s.cancelled > 0),
        staged: countLink(show('staged'), s.staged.toLocaleString('en-PH'), s.staged > 0),
        missing: countLink(numberingHref({ company, account: a.accountId, missing: true }), (
          <span className={s.missingRuns ? 'font-semibold text-amber-700' : ''}>
            {fmtCount(s.missingNumbers)}{s.missingRuns ? ` (${s.missingRuns.toLocaleString('en-PH')})` : ''}
          </span>
        ), s.missingNumbers !== '0'),
        ticked: countLink(show('ticked'), <span className={a.inventory.ticked !== '0' ? 'font-semibold text-success-ink' : ''}>{fmtCount(a.inventory.ticked)}</span>, a.inventory.ticked !== '0'),
        notNumeric: countLink(`${base}#not-numeric`, s.notNumeric.toLocaleString('en-PH'), s.notNumeric > 0),
        outOfPattern: countLink(`${base}#out-of-pattern`, s.outOfPattern.toLocaleString('en-PH'), s.outOfPattern > 0),
        noBook: countLink(show('noBook'), <span className={s.noBook ? 'font-semibold text-sky-800' : ''}>{s.noBook.toLocaleString('en-PH')}</span>, s.noBook > 0),
        otherBook: countLink(show('otherBook'), <span className={s.otherBook ? 'font-semibold text-violet-800' : ''}>{s.otherBook.toLocaleString('en-PH')}</span>, s.otherBook > 0),
      },
    }
  })
  const footer = {
    account: `TOTAL · ${t.books.toLocaleString('en-PH')} CHECK BOOK${t.books === 1 ? '' : 'S'}`,
    held: t.held.toLocaleString('en-PH'), voided: t.voided.toLocaleString('en-PH'), cancelled: t.cancelled.toLocaleString('en-PH'),
    staged: t.staged.toLocaleString('en-PH'),
    missing: <span className={t.missingRuns ? 'text-amber-700' : ''}>{fmtCount(t.missingNumbers)}{t.missingRuns ? ` (${t.missingRuns.toLocaleString('en-PH')})` : ''}</span>,
    ticked: <span className={t.ticked !== '0' ? 'text-success-ink' : ''}>{fmtCount(t.ticked)}</span>,
    notNumeric: t.notNumeric.toLocaleString('en-PH'), outOfPattern: t.outOfPattern.toLocaleString('en-PH'), noBook: t.noBook.toLocaleString('en-PH'),
    otherBook: t.otherBook.toLocaleString('en-PH'),
  }
  return <KitTable tableId="numbering-books-inventory" columns={columns} rows={rows} footer={footer} stickyHead />
}

/**
 * One check book's series in number order as the inventory (spec §H), on the
 * table kit: every held check and every MISSING number is a data row with
 * Finance's tick box and remarks, so it stays while the table is filtered or
 * sorted; a run too long to list is a band — one line with one tick and remark
 * for the whole run, which opens on a click — and bands hide while a filter or
 * sort is in force, as the kit's bands do. A number Acumatica re-used with a
 * trailing dot is a grey STAGED line; a check with no check book whose number
 * falls inside the sequence is a blue-tinted line tagged NO CHECK BOOK with its
 * cash account (spec §I). The page wraps this in `InventoryForm`,
 * whose SAVE INVENTORY records every change at once.
 */
export function NumberingEntriesTable({ lines, checkBookId, initialFilters }: { lines: readonly InventoryLine[]; checkBookId: string; initialFilters?: Readonly<Record<string, string>> }) {
  const rows = lines.map((e): KitRow => {
    switch (e.kind) {
      case 'MISSING_NUMBER':
        return missingNumberRow(checkBookId, e.number, e.note)
      case 'MISSING': {
        const stale = e.note && runNoteStale(e) ? { from: e.note.checkNumber, to: e.note.runTo ?? e.note.checkNumber } : null
        const notes: Record<string, InventoryNoteView> = {}
        for (const n of e.notes) notes[n.checkNumber] = toView(n)
        return {
          key: `m-${e.from}`, className: 'border-b border-amber-200 bg-amber-50',
          band: (
            <MissingRunBand
              checkBookId={checkBookId} from={e.from} to={e.to} count={e.count} label={missingLabel(e)}
              runNote={e.note ? toView(e.note) : null} stale={stale} notes={notes}
            />
          ),
        }
      }
      case 'STAGED':
        return withInventory(stagedRow(e.staged), checkBookId, e.number, null)
      case 'CHECK':
        return withInventory(checkRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : undefined, e.noBook, e.otherBook), checkBookId, e.cheque.checkNumber, e.note)
    }
  })
  return (
    <KitTable tableId="numbering-inventory" columns={[...CHECK_COLUMNS, INVENTORY_COLUMN, REMARKS_COLUMN]} rows={rows} stickyHead initialFilters={initialFilters}
      bandsNote="LONG MISSING RUNS ARE HIDDEN WHILE A FILTER OR SORT IS IN FORCE; EVERY LISTED NUMBER STAYS." />
  )
}

/** Checks whose number cannot be placed in the sequence. */
export function NotNumericTable({ cheques }: { cheques: readonly SeriesCheque[] }) {
  return <KitTable tableId="numbering-not-numeric" columns={CHECK_COLUMNS} rows={cheques.map((c) => checkRow(c))} />
}

/** Checks and staged lines whose number breaks the book's pattern (spec §F): listed, not in the sequence. */
export function OutOfPatternTable({ entries }: { entries: readonly SeriesEntry[] }) {
  return <KitTable tableId="numbering-out-of-pattern" columns={CHECK_COLUMNS} rows={entryRows(entries.filter((e) => e.kind !== 'MISSING'))} />
}
