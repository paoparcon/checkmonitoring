import type { CheckStatus, Prisma, PrismaClient } from '@prisma/client'
import { LIVE_STATUSES } from '@/lib/domain/check-status'

type Db = PrismaClient | Prisma.TransactionClient

export const PLANNED_STAGE = 'PLANNED' as const
export type ForecastStage = CheckStatus | typeof PLANNED_STAGE

export type ForecastFilters = {
  /** A `Bank.code`. Matched against the checkbook's bank, else the cash account's. */
  bankCode?: string
  companyId?: string
  /** A live cheque stage, or PLANNED for the non-cheque lines alone. */
  stage?: ForecastStage
}

/** One cheque, or one planned line, of the population. `amount` is a decimal STRING — rule 8. */
export type ForecastRow = {
  id: string
  /** The cheque number, or the literal `PLANNED` for a planned line. */
  checkNumber: string
  payee: string | null
  bank: string | null
  company: string
  stage: ForecastStage
  currency: string
  amount: string
  /** The cheque's date; for a planned line, the day it leaves the bank. */
  checkDate: Date | null
  kind: 'CHECK' | 'PLANNED'
  /** Typed by Finance (2026-09-12); the forecast buckets on it when set. Always null on a planned line. */
  expectedOutflowDate: Date | null
}

/**
 * THE POPULATION, minus the amount rule: live statuses (or the one stage
 * asked for), real cheques, this bank and company — every clause both
 * `listForecastRows` and `countExcludedIncomplete` need to agree on, because
 * the exclusion a page states has to be struck over the same rows it is
 * excluding FROM. `listForecastRows` adds the amount clause on top of this;
 * `countExcludedIncomplete` adds the opposite one.
 */
function populationWhere(filters: ForecastFilters): Prisma.CheckWhereInput {
  const where: Prisma.CheckWhereInput = {
    status: filters.stage && filters.stage !== PLANNED_STAGE ? filters.stage : { in: [...LIVE_STATUSES] },
    isCheque: true,
  }
  if (filters.companyId) where.companyId = filters.companyId
  if (filters.bankCode) {
    // The bank a cheque draws on is the checkbook's when it has one — 9,072
    // cheques do — and the cash account's for the 1,342 that carry only that.
    // The filter says the same thing in Prisma's grammar: a checkbook bank
    // that matches, or no checkbook at all and a cash-account bank that does.
    where.OR = [
      { checkBook: { bank: { code: filters.bankCode } } },
      { checkBookId: null, cashAccount: { bank: { code: filters.bankCode } } },
    ]
  }
  return where
}

/**
 * THE POPULATION: written, and not yet handed over.
 *
 * Live statuses only — a released cheque has left the counter, and with
 * clearing never recorded (measured 2026-09-11: `clearingStatus = NONE` on all
 * 9,594) its fate is unknowable here; a cancelled or voided one will never
 * leave. Real checks only: a DEBIT ADV or TT payment has no paper to
 * present. And only cheques with a recorded amount, consistent with every
 * other output since the ruling of 2026-09-06 — the page states the exclusion
 * and its count.
 *
 * `amount: { not: null }` is stated as well as `isIncomplete: false`, because
 * `isIncomplete` is a stored derivation of the former and a rule about money
 * reads the fact, not the cache of it — the same reason `checkDeletable` does.
 *
 * Returned as rows, not groups: the two matrices and the DETAIL sheet are all
 * struck over this one list in the pure layer, so they cannot disagree.
 */
export async function listForecastRows(db: Db, filters: ForecastFilters = {}): Promise<ForecastRow[]> {
  if (filters.stage === PLANNED_STAGE) return []
  const where: Prisma.CheckWhereInput = {
    ...populationWhere(filters),
    isIncomplete: false,
    amount: { not: null },
  }

  const checks = await db.check.findMany({
    where,
    orderBy: [{ checkDate: { sort: 'asc', nulls: 'last' } }, { checkNumber: 'asc' }],
    select: {
      id: true, checkNumber: true, payeeName: true, currency: true, amount: true,
      checkDate: true, status: true, expectedOutflowDate: true,
      company: { select: { code: true } },
      checkBook: { select: { bank: { select: { code: true } } } },
      cashAccount: { select: { bank: { select: { code: true } } } },
      vendor: { select: { canonicalName: true } },
    },
  })

  return checks.flatMap((c) => {
    // Guarded above by the where clause; narrowed here for the type, never
    // defaulted — a cheque with no amount is not worth 0.00.
    if (c.amount === null) return []
    return [{
      id: c.id,
      checkNumber: c.checkNumber,
      payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      bank: c.checkBook?.bank.code ?? c.cashAccount?.bank.code ?? null,
      company: c.company.code,
      stage: c.status,
      currency: c.currency,
      // `.toFixed(2)`, not `.toString()`: decimal.js drops a trailing zero
      // (`Decimal('1234.50').toString()` is `'1234.5'`), and the column is
      // `Decimal(18,2)` — the two stored digits are exact, not display
      // rounding. `tests/import/bills.test.ts` and
      // `tests/admin/backfill-apv-numbers.test.ts` compare the same way.
      amount: c.amount.toFixed(2),
      checkDate: c.checkDate,
      kind: 'CHECK' as const,
      expectedOutflowDate: c.expectedOutflowDate,
    }]
  })
}

/**
 * THIS REPORT'S OWN EXCLUSION — not the database-wide count of
 * `Check.isIncomplete`. Most of the 129 incomplete cheques (measured
 * 2026-09-06: 48 CANCELLED / 29 SIGNATURE_PENDING / 25 RELEASED / 23 SIGNED /
 * 4 VOIDED) were never candidates for this report — a RELEASED or CANCELLED
 * cheque is excluded by `populationWhere` anyway, on status, before amount
 * ever enters it — and the raw count also ignores the bank, company and stage
 * filters a reader may have applied. Struck over the SAME `populationWhere`
 * as `listForecastRows`, with the amount clause inverted rather than dropped:
 * the exclusion a page states must be the exclusion the page actually
 * applied, or the number on screen is about a different report.
 */
export async function countExcludedIncomplete(db: Db, filters: ForecastFilters = {}): Promise<number> {
  if (filters.stage === PLANNED_STAGE) return 0
  return db.check.count({
    where: { ...populationWhere(filters), isIncomplete: true },
  })
}

/** Every bank, for the filter's dropdown. Never hard-coded: a new bank appears without a code change. */
export async function listBankCodes(db: Db): Promise<string[]> {
  const banks = await db.bank.findMany({ orderBy: { code: 'asc' }, select: { code: true } })
  return banks.map((b) => b.code)
}

/**
 * THE PLANNED LINES, in the same shape, so the matrices and the sheet need no
 * second path. Open lines only — PAID has left, CANCELLED never will. The bank
 * and company filters apply on the line's own bank and company; a cheque
 * stage filter excludes them entirely, and PLANNED alone includes only them.
 */
export async function listPlannedRows(db: Db, filters: ForecastFilters = {}): Promise<ForecastRow[]> {
  if (filters.stage && filters.stage !== PLANNED_STAGE) return []
  const lines = await db.plannedOutflow.findMany({
    where: {
      status: 'PLANNED',
      ...(filters.companyId ? { companyId: filters.companyId } : {}),
      ...(filters.bankCode ? { bank: { code: filters.bankCode } } : {}),
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true, date: true, amount: true, currency: true, description: true,
      bank: { select: { code: true } }, company: { select: { code: true } },
    },
  })
  return lines.map((l) => ({
    id: l.id, checkNumber: PLANNED_STAGE, payee: l.description, bank: l.bank.code, company: l.company.code,
    stage: PLANNED_STAGE, kind: 'PLANNED', currency: l.currency, amount: l.amount.toFixed(2),
    checkDate: l.date, expectedOutflowDate: null,
  }))
}
