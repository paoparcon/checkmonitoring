// components/NumberingTables.tsx
import Link from 'next/link'
import { formatMoney } from '@/lib/money'
import { StatusPill } from '@/components/StatusPill'
import { missingLabel, numberingHref } from '@/lib/numbering-view'
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
 * The inventory column (spec §H): the tick box and remarks on every line. Its
 * filter is "contains" over TICKED / UNTICKED and the remark's words, so
 * Finance can narrow to what is still unticked or to one remark; it never sorts.
 */
const INVENTORY_COLUMN: KitColumn = { key: 'inventory', label: 'INVENTORY · TICK AND REMARKS', kind: 'text', locked: true, noSort: true, className: 'py-2' }

export const toView = (n: InventoryNote): InventoryNoteView =>
  ({ ticked: n.ticked, remarks: n.remarks, updatedBy: n.updatedBy, updatedAt: n.updatedAt.toISOString() })

const inventoryValue = (n: InventoryNote | null) => [n?.ticked ? 'TICKED' : 'UNTICKED', n?.remarks ?? ''].join(' ').trim()

/** The tag on a check with no check book shown where its number falls (spec §I): names Acumatica's cash account. */
const noBookTag = (c: SeriesCheque) => `NO CHECK BOOK · ${c.cashAccount ?? 'NO CASH ACCOUNT'}`

function checkRow(c: SeriesCheque, note?: string, noBook = false): KitRow {
  const tag = noBook ? noBookTag(c) : null
  return {
    key: c.id,
    className: noBook ? 'border-b border-sky-100 bg-sky-50/70' : undefined,
    values: {
      checkNumber: c.checkNumber, checkDate: dateValue(c.checkDate), payee: c.payeeName,
      amount: c.amount === null ? null : String(c.amount),
      status: [c.status.replace(/_/g, ' '), note, tag].filter((s) => s).join(' '),
    },
    cells: {
      checkNumber: <Link prefetch={false} href={`/checks/${c.id}`} className="underline underline-offset-2">{c.checkNumber}</Link>,
      checkDate: fmtDay(c.checkDate),
      payee: c.payeeName ?? '—',
      amount: formatMoney(c.amount, c.currency),
      status: (
        <>
          <StatusPill status={c.status} />
          {note && <span className="ml-2 text-xs font-semibold text-amber-700">{note}</span>}
          {tag && <span className="ml-2 inline-block whitespace-nowrap rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold tracking-wide text-sky-800">{tag}</span>}
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
    values: { ...row.values, inventory: inventoryValue(note) },
    cells: { ...row.cells, inventory: <InventoryNoteCell checkBookId={checkBookId} checkNumber={checkNumber} note={note ? toView(note) : null} label={checkNumber} /> },
  }
}

/** One MISSING number as its own amber row (spec §H): no check, its own tick and remark. A data row, so it stays while the table is filtered or sorted. */
function missingNumberRow(checkBookId: string, number: string, note: InventoryNote | null): KitRow {
  return {
    key: `n-${number}`,
    className: 'border-b border-amber-200 bg-amber-50',
    values: { checkNumber: number, checkDate: null, payee: 'NO CHECK IN THIS SYSTEM', amount: null, status: 'MISSING', inventory: inventoryValue(note) },
    cells: {
      checkNumber: <span className="font-semibold text-amber-800">{number}</span>,
      checkDate: <span className="text-amber-800/60">—</span>,
      payee: <span className="text-amber-800/60">NO CHECK IN THIS SYSTEM</span>,
      amount: <span className="text-amber-800/60">—</span>,
      status: <MissingPill />,
      inventory: <InventoryNoteCell checkBookId={checkBookId} checkNumber={number} note={note ? toView(note) : null} label={number} />,
    },
  }
}

function entryRows(entries: readonly SeriesEntry[]): KitRow[] {
  return entries.map((e): KitRow => e.kind === 'MISSING'
    ? {
        key: `m-${e.from}`, className: 'border-b border-amber-200 bg-amber-50',
        band: <div className="px-4 py-3 font-semibold tabular-nums text-amber-800">{missingLabel(e)}</div>,
      }
    : e.kind === 'STAGED' ? stagedRow(e.staged) : checkRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : undefined, e.noBook))
}

/** One row per check book. The check book links to its own series. TICKED is the inventory's count, held and missing ticks alike. */
export function NumberingSummaryTable({ accounts, company }: { accounts: readonly NumberingAccount[]; company?: string }) {
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
    count('noBook', 'NO CHECK BOOK'),
  ]
  const rows: KitRow[] = accounts.map((a) => {
    const s = a.series.summary
    return {
      key: a.accountId,
      values: {
        account: a.account, bank: a.bank, company: a.company, first: s.first ?? null, last: s.last ?? null,
        held: String(s.held), voided: String(s.voided), cancelled: String(s.cancelled), staged: String(s.staged),
        missing: s.missingNumbers, ticked: a.inventory.ticked, notNumeric: String(s.notNumeric), outOfPattern: String(s.outOfPattern),
        noBook: String(s.noBook),
      },
      cells: {
        account: <Link prefetch={false} href={numberingHref({ company, account: a.accountId })} className="underline underline-offset-2">{a.account}</Link>,
        bank: a.bank, company: a.company, first: s.first ?? '—', last: s.last ?? '—',
        held: s.held.toLocaleString('en-PH'), voided: s.voided.toLocaleString('en-PH'),
        cancelled: s.cancelled.toLocaleString('en-PH'), staged: s.staged.toLocaleString('en-PH'),
        missing: (
          <span className={s.missingRuns ? 'font-semibold text-amber-700' : ''}>
            {fmtCount(s.missingNumbers)}{s.missingRuns ? ` (${s.missingRuns.toLocaleString('en-PH')})` : ''}
          </span>
        ),
        ticked: <span className={a.inventory.ticked !== '0' ? 'font-semibold text-success-ink' : ''}>{fmtCount(a.inventory.ticked)}</span>,
        notNumeric: s.notNumeric.toLocaleString('en-PH'), outOfPattern: s.outOfPattern.toLocaleString('en-PH'),
        noBook: <span className={s.noBook ? 'font-semibold text-sky-800' : ''}>{s.noBook.toLocaleString('en-PH')}</span>,
      },
    }
  })
  return <KitTable tableId="numbering-books-inventory" columns={columns} rows={rows} />
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
export function NumberingEntriesTable({ lines, checkBookId }: { lines: readonly InventoryLine[]; checkBookId: string }) {
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
        return withInventory(checkRow(e.cheque, e.duplicate ? 'DUPLICATE NUMBER' : undefined, e.noBook), checkBookId, e.cheque.checkNumber, e.note)
    }
  })
  return (
    <KitTable tableId="numbering-inventory" columns={[...CHECK_COLUMNS, INVENTORY_COLUMN]} rows={rows}
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
