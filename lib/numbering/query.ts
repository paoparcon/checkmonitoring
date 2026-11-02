// lib/numbering/query.ts
import type { Prisma, PrismaClient } from '@prisma/client'
import { buildSeries, stagedSeriesNumber, type AccountSeries, type SeriesCheque, type SeriesStaged } from './series'
import { toInventoryLines, inventoryCounts, type InventoryLine, type InventoryCounts } from './inventory'
import { loadInventoryNotes } from './inventory-notes'

type Db = PrismaClient | Prisma.TransactionClient

export type NumberingFilters = { companyId?: string; checkBookId?: string }
/**
 * One series. `accountId` / `account` name the cheque book (`CheckBook.id` /
 * `.code`). `company` is the companies among the series' cheques, most
 * cheques first, joined ", " — `""` for a book holding staged lines only.
 * `lines` is the same series as the inventory shows it (spec §H): a MISSING
 * run of at most INVENTORY_LIST_MAX numbers listed one per line, each with
 * Finance's tick and remark; `inventory` counts what is recorded.
 */
export type NumberingAccount = {
  accountId: string; account: string; bank: string; company: string; series: AccountSeries
  lines: InventoryLine[]; inventory: InventoryCounts
}

type Group = { account: string; bank: string; companies: Map<string, number>; cheques: SeriesCheque[]; staged: SeriesStaged[] }
type BookRef = { id: string; code: string; bank: { code: string } }

/** The series' companies, most cheques first, then by code. */
function companyLabel(counts: Map<string, number>): string {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code]) => code)
    .join(', ')
}

/**
 * Every cheque that holds a number in a cheque book's series: `isCheque`, an
 * Acumatica payment (`acumaticaPaymentId` — register-only cheques are not
 * shown, spec §G2, and do not select a company's books), a cheque book, and EVERY status — VOIDED, CANCELLED and no-amount cheques
 * included, because the number was used whatever happened to it (spec
 * 2026-10-01-cheque-numbering-and-cancel-guard-design §B1). The series key is
 * the cheque book (`CheckBook`) — the bank account Acumatica states in its
 * CashAccount column, e.g. `BPI-S-4636` (spec §D). The register's cash-account
 * label is not the series: most cheques carry none. ~13,000 rows.
 *
 * A cheque book is a bank account SHARED across companies (spec §E, measured
 * 2026-10-05), so a series holds every company's cheques in that book. The
 * company filter therefore selects BOOKS — those at least one of the
 * company's cheques uses — and shows each whole: narrowing to the company's
 * own cheques would turn every other company's number in the book into a
 * fake MISSING line. With a cheque book named, that book is shown whole and
 * the company is not applied to its cheques.
 *
 * Plus the staged Acumatica payments that re-used a cheque number with a
 * trailing dot (spec §C): not promoted, joined to their cheque book by
 * `CheckBook.code = StagedCheck.cashAccountCode` within the same book set,
 * qualifying by `stagedSeriesNumber`. Read only.
 */
export async function listNumberingAccounts(db: Db, f: NumberingFilters): Promise<NumberingAccount[]> {
  // The book set: the one named book, the books the company uses, or every book (undefined).
  let bookIds: string[] | undefined
  if (f.checkBookId) {
    bookIds = [f.checkBookId]
  } else if (f.companyId) {
    const used = await db.check.findMany({
      where: { isCheque: true, acumaticaPaymentId: { not: null }, companyId: f.companyId, checkBookId: { not: null } },
      select: { checkBookId: true },
      distinct: ['checkBookId'],
    })
    bookIds = used.map((r) => r.checkBookId!)
  }

  const rows = await db.check.findMany({
    where: { isCheque: true, acumaticaPaymentId: { not: null }, checkBookId: bookIds ? { in: bookIds } : { not: null } },
    select: {
      id: true, checkNumber: true, checkDate: true, payeeName: true, amount: true, currency: true, status: true, acumaticaPaymentId: true,
      company: { select: { code: true } },
      checkBook: { select: { id: true, code: true, bank: { select: { code: true } } } },
    },
  })

  const byBook = new Map<string, Group>()
  const groupFor = (b: BookRef): Group => {
    let g = byBook.get(b.id)
    if (!g) {
      g = { account: b.code, bank: b.bank.code, companies: new Map(), cheques: [], staged: [] }
      byBook.set(b.id, g)
    }
    return g
  }
  for (const r of rows) {
    if (!r.checkBook) continue
    const g = groupFor(r.checkBook)
    g.companies.set(r.company.code, (g.companies.get(r.company.code) ?? 0) + 1)
    g.cheques.push({
      id: r.id, checkNumber: r.checkNumber, checkDate: r.checkDate, payeeName: r.payeeName,
      amount: r.amount?.toFixed(2) ?? null, currency: r.currency, status: r.status, cv: r.acumaticaPaymentId,
    })
  }

  const stagedRows = await db.stagedCheck.findMany({
    where: { source: 'ACUMATICA', reason: 'NO_CHECK_NUMBER', promotedCheckId: null, cashAccountCode: { not: null } },
    orderBy: [{ acumaticaTenant: 'asc' }, { acumaticaRef: 'asc' }],
    select: { acumaticaTenant: true, acumaticaRef: true, statedCheckRef: true, checkDate: true, payeeName: true, amount: true, currency: true, cashAccountCode: true },
  })
  const dotted = stagedRows.filter((s) => s.acumaticaTenant && s.acumaticaRef && stagedSeriesNumber(s.statedCheckRef) !== null)
  const codes = [...new Set(dotted.map((s) => s.cashAccountCode!))]
  const books = codes.length
    ? await db.checkBook.findMany({
      where: { code: { in: codes }, ...(bookIds ? { id: { in: bookIds } } : {}) },
      select: { id: true, code: true, bank: { select: { code: true } } },
    })
    : []
  const bookByCode = new Map(books.map((b) => [b.code, b]))
  for (const s of dotted) {
    const b = bookByCode.get(s.cashAccountCode!)
    if (!b) continue
    groupFor(b).staged.push({
      acumaticaTenant: s.acumaticaTenant!, acumaticaRef: s.acumaticaRef!, statedCheckRef: s.statedCheckRef!, checkDate: s.checkDate, payeeName: s.payeeName,
      amount: s.amount?.toFixed(2) ?? null, currency: s.currency,
    })
  }

  // Finance's inventory notes, one query for the books shown (spec §H).
  const notes = await loadInventoryNotes(db, bookIds ?? [...byBook.keys()])

  return [...byBook.entries()]
    .map(([accountId, g]) => {
      const series = buildSeries(g.cheques, g.staged)
      const lines = toInventoryLines(series.entries, notes.get(accountId) ?? new Map())
      return { accountId, account: g.account, bank: g.bank, company: companyLabel(g.companies), series, lines, inventory: inventoryCounts(lines) }
    })
    .sort((a, b) => a.account.localeCompare(b.account) || a.accountId.localeCompare(b.accountId))
}

/** Acumatica cheques in no series because they carry no cheque book — stated on the page, not listed. */
export async function countChequesWithoutCheckBook(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({
    where: { isCheque: true, acumaticaPaymentId: { not: null }, checkBookId: null, ...(f.companyId ? { companyId: f.companyId } : {}) },
  })
}

/**
 * Cheques Acumatica does not know — no payment reference, so they exist only
 * in the old register (spec §G2). NUMBERING follows Acumatica's data and does
 * not show them; the page and the file state how many there are.
 */
export async function countRegisterOnlyCheques(db: Db, f: { companyId?: string }): Promise<number> {
  return db.check.count({ where: { isCheque: true, acumaticaPaymentId: null, ...(f.companyId ? { companyId: f.companyId } : {}) } })
}

/** The cheque books, by code — the series the NUMBERING page and export accept as `account`. */
export async function listCheckBookOptions(db: Db): Promise<{ id: string; code: string; bankCode: string }[]> {
  const books = await db.checkBook.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, bank: { select: { code: true } } } })
  return books.map((b) => ({ id: b.id, code: b.code, bankCode: b.bank.code }))
}
