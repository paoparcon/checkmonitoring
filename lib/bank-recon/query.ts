import type { Prisma, PrismaClient } from '@prisma/client'
import { dayToDate } from '@/lib/domain/details'
import { listOutstandingCandidates } from '@/lib/recon/query'
import { summariseByAccount } from '@/lib/recon/summary'
import { buildRecon, totalsOf, type BankRecon, type ReconAccount } from './recon'

type Db = PrismaClient | Prisma.TransactionClient

/** A day the store holds a bank balance for: how many accounts, and their peso total. Newest first. */
export type BalanceDay = { day: string; accounts: number; total: string }

export async function listBalanceDays(db: Db): Promise<BalanceDay[]> {
  const groups = await db.cashBalance.groupBy({
    by: ['asOf'], where: { bankBalance: { not: null } },
    _count: { _all: true }, _sum: { bankBalance: true },
    orderBy: { asOf: 'desc' },
  })
  return groups.map((g) => ({
    day: g.asOf.toISOString().slice(0, 10), accounts: g._count._all, total: g._sum.bankBalance?.toFixed(2) ?? '0.00',
  }))
}

/**
 * The reconciliation for a day: every account with a figure on that day —
 * a bank balance, or a book balance or deposit typed — beside the outstanding checks
 * struck for the same day by the rule `/recon` uses, over the same rows.
 * `silent` is how many accounts of the schedule have nothing on the day.
 */
export async function loadBankRecon(db: Db, asOfDay: string): Promise<{ recon: BankRecon; silent: number }> {
  const [accounts, books, rows] = await Promise.all([
    db.cashLedgerAccount.findMany({
      include: { balances: { where: { asOf: dayToDate(asOfDay) } } },
    }),
    db.checkBook.findMany({ select: { id: true, code: true, bank: { select: { code: true } } } }),
    listOutstandingCandidates(db),
  ])
  const summary = summariseByAccount(rows, asOfDay)
  // Books are matched against the WHOLE schedule, so an account with no figure
  // on the day still claims its book and its outstanding checks are not "unmatched".
  const hasFigure = new Set<string>()
  const all: ReconAccount[] = accounts.map((a) => {
    const b = a.balances[0]
    if (b && (b.bookBalance !== null || b.bankBalance !== null || b.depositsInTransit !== null || b.note !== null)) hasFigure.add(a.id)
    return {
      id: a.id, label: a.label, companyLabel: a.companyLabel, description: a.description,
      accountNumber: a.accountNumber, currency: a.currency, position: a.position,
      bankBalance: b?.bankBalance?.toFixed(2) ?? null, bankSource: b?.bankSource ?? null,
      bookBalance: b?.bookBalance?.toFixed(2) ?? null,
      depositsInTransit: b?.depositsInTransit?.toFixed(2) ?? null, note: b?.note ?? null,
    }
  })
  const whole = buildRecon(all, books.map((b) => ({ id: b.id, code: b.code, bank: b.bank.code })), summary.accounts)
  // Shown: an account with a figure on the day, or with checks outstanding on it.
  const lines = whole.lines.filter((l) => hasFigure.has(l.id) || (l.outstanding !== null && l.outstanding.count > 0))
  return { recon: { ...whole, lines, totals: totalsOf(lines) }, silent: accounts.length - lines.length }
}
