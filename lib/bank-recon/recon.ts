import { toCentavos, fromCentavos } from '@/lib/export/report'

/**
 * THE BANK RECONCILIATION, per account, for one day (2026-11-09). Pure.
 *
 *     BANK BALANCE                 Finance's CASH schedule, in pesos (the statement)
 *   + DEPOSITS IN TRANSIT          typed by Finance
 *   − OUTSTANDING CHECKS           released, not yet cleared by the bank — computed here
 *   = ADJUSTED BANK BALANCE        the cash actually available; what the books should show
 *
 *     ADJUSTED BANK BALANCE
 *   − BOOK BALANCE                 typed by Finance, off the ledger
 *   = VARIANCE                     0.00 is reconciled
 *
 * The CASH schedule's figure is the BANK's (user ruling 2026-11-09: "those are
 * bank balance"), so the adjusted balance needs nothing typed: bank less the
 * checks this system knows are still out. Centavo arithmetic on strings
 * (rule 8). What is not known is not a figure: no bank balance, no adjusted
 * balance; no book balance, no variance. A deposit in transit nobody typed
 * counts as none — and the line says so, so a variance that is really an
 * untyped deposit is not read as a difference.
 *
 * WHICH CHECK BOOK DRAWS ON WHICH ACCOUNT is read off the book's code: a
 * check book is named for its account's last four digits (`BPI-S-4636` is
 * BPI 3373-1746-36; `MBT-A-4155` is MBTC 179-7-179604155 — all eight books
 * measured 2026-11-09 match exactly one line of the CASH sheet). A book whose
 * four digits end two accounts, or none, is matched to nothing and listed.
 */
export type ReconBook = { id: string; code: string; bank: string }
export type ReconAccount = {
  id: string
  label: string
  companyLabel: string | null
  description: string | null
  accountNumber: string | null
  currency: string
  position: number
  /** From the CASH workbook. */
  bankBalance: string | null
  bankSource: string | null
  /** Typed by Finance. */
  bookBalance: string | null
  depositsInTransit: string | null
  note: string | null
}
/** An account's outstanding checks for the day, as `summariseByAccount` strikes them. */
export type OutstandingByAccount = { accountId: string | null; account: string; count: number; totals: { currency: string; count: number; total: string }[] }

export type ReconLine = ReconAccount & {
  books: ReconBook[]
  /** Null when no check book draws on this account. PHP only. */
  outstanding: { count: number; total: string } | null
  adjustedBank: string | null
  variance: string | null
  /** True when a variance was struck with no deposit in transit typed. */
  ditAssumedNone: boolean
}
export type UnmatchedOutstanding = { accountId: string | null; account: string; count: number; total: string }
export type ReconTotals = {
  accounts: number
  bankBalance: string
  depositsInTransit: string
  outstanding: string
  outstandingCount: number
  adjustedBank: string
  /** Over the accounts with a book balance typed. */
  bookBalance: string
  bookTyped: number
  /** Over the accounts with both a bank and a book balance. */
  variance: string
  reconciled: number
}
export type BankRecon = {
  lines: ReconLine[]
  totals: ReconTotals
  /** Outstanding checks in an account no line of the CASH schedule matches (PAYROLL, a register label, no account). */
  unmatched: UnmatchedOutstanding[]
  /** Checks outstanding in a currency other than PHP, left out of every figure. */
  otherCurrencyChecks: number
}

/** `BPI-S-4636` → `4636`. Null when the code does not end in four digits. */
export function bookTail(code: string): string | null {
  return /(\d{4})$/.exec(code.trim())?.[1] ?? null
}

const BANK_WORD = /\b(BPI|MBTC|BDO|RSB)\b/i
/** The bank an account's own wording names, or null. `MBT` in a book code is MBTC. */
export function bankOf(text: string): string | null {
  return BANK_WORD.exec(text)?.[1]?.toUpperCase() ?? null
}

/**
 * Each book's account: the one whose number ends in the book's four digits,
 * when exactly one does and its wording does not name a different bank.
 */
export function matchBooks(
  accounts: readonly Pick<ReconAccount, 'id' | 'label' | 'description' | 'accountNumber'>[],
  books: readonly ReconBook[],
): { byAccount: Map<string, ReconBook[]>; unmatchedBooks: ReconBook[] } {
  const byAccount = new Map<string, ReconBook[]>()
  const unmatchedBooks: ReconBook[] = []
  for (const book of books) {
    const tail = bookTail(book.code)
    const candidates = tail === null ? [] : accounts.filter((a) => {
      if (!a.accountNumber?.endsWith(tail)) return false
      const named = bankOf(`${a.label} ${a.description ?? ''}`)
      return named === null || named === book.bank.toUpperCase()
    })
    if (candidates.length !== 1) { unmatchedBooks.push(book); continue }
    const id = candidates[0]!.id
    byAccount.set(id, [...(byAccount.get(id) ?? []), book])
  }
  return { byAccount, unmatchedBooks }
}

const cents = (s: string | null) => (s === null ? 0n : toCentavos(s))

export function buildRecon(
  accounts: readonly ReconAccount[],
  books: readonly ReconBook[],
  outstanding: readonly OutstandingByAccount[],
): BankRecon {
  const { byAccount } = matchBooks(accounts, books)
  const ocByBook = new Map<string, OutstandingByAccount>()
  for (const o of outstanding) if (o.accountId) ocByBook.set(o.accountId, o)
  const matchedBookIds = new Set([...byAccount.values()].flat().map((b) => b.id))

  let otherCurrencyChecks = 0
  const php = (o: OutstandingByAccount) => {
    let count = 0
    let total = 0n
    for (const t of o.totals) {
      if (t.currency === 'PHP') { count += t.count; total += toCentavos(t.total) } else otherCurrencyChecks += t.count
    }
    return { count, total }
  }

  const lines: ReconLine[] = [...accounts]
    .sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
    .map((a) => {
      const mine = byAccount.get(a.id) ?? []
      let oc: { count: number; total: string } | null = null
      if (mine.length > 0) {
        let count = 0
        let total = 0n
        for (const book of mine) {
          const o = ocByBook.get(book.id)
          if (o) { const p = php(o); count += p.count; total += p.total }
        }
        oc = { count, total: fromCentavos(total) }
      }
      const adjusted = a.bankBalance === null
        ? null
        : toCentavos(a.bankBalance) + cents(a.depositsInTransit) - cents(oc?.total ?? null)
      const variance = adjusted === null || a.bookBalance === null ? null : adjusted - toCentavos(a.bookBalance)
      return {
        ...a, books: mine, outstanding: oc,
        adjustedBank: adjusted === null ? null : fromCentavos(adjusted),
        variance: variance === null ? null : fromCentavos(variance),
        ditAssumedNone: variance !== null && a.depositsInTransit === null,
      }
    })

  const unmatched: UnmatchedOutstanding[] = outstanding
    .filter((o) => o.accountId === null || !matchedBookIds.has(o.accountId))
    .map((o) => { const p = php(o); return { accountId: o.accountId, account: o.account, count: p.count, total: fromCentavos(p.total) } })
    .filter((u) => u.count > 0)

  return { lines, totals: totalsOf(lines), unmatched, otherCurrencyChecks }
}

/** The totals row over the lines given — struck again when a page shows only some of them. */
export function totalsOf(lines: readonly ReconLine[]): ReconTotals {
  const sum = (pick: (l: ReconLine) => string | null) => fromCentavos(lines.reduce((n, l) => n + cents(pick(l)), 0n))
  return {
    accounts: lines.length,
    bankBalance: sum((l) => l.bankBalance),
    depositsInTransit: sum((l) => l.depositsInTransit),
    outstanding: sum((l) => l.outstanding?.total ?? null),
    outstandingCount: lines.reduce((n, l) => n + (l.outstanding?.count ?? 0), 0),
    adjustedBank: sum((l) => l.adjustedBank),
    bookBalance: sum((l) => l.bookBalance),
    bookTyped: lines.filter((l) => l.bookBalance !== null).length,
    variance: sum((l) => l.variance),
    reconciled: lines.filter((l) => l.variance !== null && toCentavos(l.variance) === 0n).length,
  }
}
