import type { Prisma, PrismaClient, ReconPeriod } from '@prisma/client'
import { accountWhere } from '@/lib/queries'
import { isoDay } from '@/lib/domain/details'
import {
  computeReconciliation, type ComputeInput, type ReconComputation, type ComputeLine, type ComputeBookEntry,
  type ComputeAdjustment, type ComputeCheck,
} from './compute'
import { lastDay, monthOf, sameAmount, isApproved, sub, type Month, type ReconStatus } from './period'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Reads for the monthly reconciliation. Every figure is decided in
 * `compute.ts`; this file only gathers the rows one account's month needs, and
 * reads an approved month back from its frozen snapshot instead.
 */

const money = (d: Prisma.Decimal | null | undefined): string | null => (d === null || d === undefined ? null : d.toFixed(2))
const day = (d: Date) => isoDay(d)!

export type AccountKind = 'CHECK_BOOK' | 'CASH_ACCOUNT'
export type ReconAccount = { accountKey: string; kind: AccountKind; code: string; bankCode: string; companyCode: string }

/** Every account a reconciliation can be kept for: the check books, then the cash accounts (the `accountWhere` order). */
export async function listReconAccounts(db: Db): Promise<ReconAccount[]> {
  const [books, cash] = await Promise.all([
    db.checkBook.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } }),
    db.cashAccount.findMany({ orderBy: { code: 'asc' }, select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } }),
  ])
  return [
    ...books.map((b) => ({ accountKey: b.id, kind: 'CHECK_BOOK' as const, code: b.code, bankCode: b.bank.code, companyCode: b.company.code })),
    ...cash.map((c) => ({ accountKey: c.id, kind: 'CASH_ACCOUNT' as const, code: c.code, bankCode: c.bank.code, companyCode: c.company.code })),
  ]
}

export async function findReconAccount(db: Db, accountKey: string): Promise<ReconAccount | null> {
  const book = await db.checkBook.findUnique({ where: { id: accountKey }, select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } })
  if (book) return { accountKey: book.id, kind: 'CHECK_BOOK', code: book.code, bankCode: book.bank.code, companyCode: book.company.code }
  const cash = await db.cashAccount.findUnique({ where: { id: accountKey }, select: { id: true, code: true, bank: { select: { code: true } }, company: { select: { code: true } } } })
  if (cash) return { accountKey: cash.id, kind: 'CASH_ACCOUNT', code: cash.code, bankCode: cash.bank.code, companyCode: cash.company.code }
  return null
}

/** The FK pair for a new row. */
export function accountColumns(a: Pick<ReconAccount, 'accountKey' | 'kind'>) {
  return a.kind === 'CHECK_BOOK'
    ? { accountKey: a.accountKey, checkBookId: a.accountKey, cashAccountId: null }
    : { accountKey: a.accountKey, checkBookId: null, cashAccountId: a.accountKey }
}

/** The account's RELEASED real cheques with an amount — the population `/recon` uses, narrowed to one account. */
function accountChecksWhere(accountKey: string): Prisma.CheckWhereInput {
  return { AND: [accountWhere(accountKey)], status: 'RELEASED', isCheque: true, isIncomplete: false, amount: { not: null } }
}

export async function loadAccountChecks(db: Db, accountKey: string, currency: string): Promise<{ checks: ComputeCheck[]; otherCurrency: number }> {
  const [rows, otherCurrency] = await Promise.all([
    db.check.findMany({
      where: { ...accountChecksWhere(accountKey), currency },
      select: {
        id: true, checkNumber: true, payeeName: true, amount: true, checkDate: true, releasedAt: true,
        clearingStatus: true, clearedDate: true, status: true, vendor: { select: { canonicalName: true } },
      },
    }),
    db.check.count({ where: { ...accountChecksWhere(accountKey), currency: { not: currency } } }),
  ])
  return {
    otherCurrency,
    checks: rows.map((c) => ({
      id: c.id, checkNumber: c.checkNumber, payee: c.payeeName ?? c.vendor?.canonicalName ?? null,
      amount: c.amount!.toFixed(2), checkDate: c.checkDate, releasedAt: c.releasedAt,
      clearingStatus: c.clearingStatus, clearedDate: c.clearedDate, status: c.status,
    })),
  }
}

export async function loadComputeInput(db: Db, period: ReconPeriod): Promise<{ input: ComputeInput; otherCurrency: number }> {
  const month = monthOf(period.periodStart)
  const end = new Date(`${lastDay(month)}T00:00:00.000Z`)
  const [opening, { checks, otherCurrency }, lines, entries, adjustments] = await Promise.all([
    db.reconOpeningBalance.findUnique({ where: { accountKey: period.accountKey }, select: { effectiveDate: true } }),
    loadAccountChecks(db, period.accountKey, period.currency),
    db.reconStatementLine.findMany({
      where: { accountKey: period.accountKey, period: { periodStart: { lte: period.periodStart } } },
      include: { period: { select: { periodStart: true } } },
    }),
    db.reconBookEntry.findMany({
      where: { accountKey: period.accountKey, entryDate: { lte: end } },
      include: { period: { select: { periodStart: true } }, matchedLine: { select: { id: true, lineDate: true } } },
    }),
    db.reconAdjustment.findMany({
      where: { accountKey: period.accountKey, period: { periodStart: { lte: period.periodStart } } },
      include: { period: { select: { periodStart: true } } },
    }),
  ])
  const input: ComputeInput = {
    month,
    openingMonth: opening ? monthOf(opening.effectiveDate) : month,
    beginningBank: period.beginningBankBalance.toFixed(2),
    beginningBook: period.beginningBookBalance.toFixed(2),
    statementBeginningBalance: money(period.statementBeginningBalance),
    statementEndingBalance: money(period.statementEndingBalance),
    checks,
    lines: lines.map((l): ComputeLine => ({
      id: l.id, month: monthOf(l.period.periodStart), lineDay: day(l.lineDate), description: l.description,
      reference: l.reference, checkNumber: l.checkNumber, debit: money(l.debit), credit: money(l.credit),
      kind: l.kind, matchMethod: l.matchMethod, checkId: l.checkId, bookEntryId: l.bookEntryId, remarks: l.remarks,
      resolvedMonth: l.resolvedPeriodStart ? monthOf(l.resolvedPeriodStart) : null, resolution: l.resolution,
    })),
    bookEntries: entries.map((e): ComputeBookEntry => ({
      id: e.id, month: monthOf(e.period.periodStart), kind: e.kind, entryDay: day(e.entryDate), amount: e.amount.toFixed(2),
      reference: e.reference, description: e.description,
      matchedLineDay: e.matchedLine ? day(e.matchedLine.lineDate) : null, matchedLineId: e.matchedLine?.id ?? null,
    })),
    adjustments: adjustments.map((a): ComputeAdjustment => ({
      id: a.id, month: monthOf(a.period.periodStart), side: a.side, direction: a.direction, amount: a.amount.toFixed(2),
      description: a.description, reference: a.reference,
      resolvedMonth: a.resolvedPeriodStart ? monthOf(a.resolvedPeriodStart) : null, resolution: a.resolution,
    })),
  }
  return { input, otherCurrency }
}

export async function computeLive(db: Db, period: ReconPeriod): Promise<{ computation: ReconComputation; otherCurrency: number }> {
  const { input, otherCurrency } = await loadComputeInput(db, period)
  return { computation: computeReconciliation(input), otherCurrency }
}

/** What is frozen on approval, read back exactly as it was. */
export type ReconSnapshot = { version: 1; computation: ReconComputation; otherCurrency: number; frozenAt: string }

export type CarryCheck = {
  /** The beginning balances disagree with where they should have come from. */
  mismatch: boolean
  expectedBank: string | null
  expectedBook: string | null
  source: 'OPENING' | 'PREVIOUS_PERIOD' | 'NONE'
  /** The previous month was re-opened after this one was carried from it. */
  previousReopened: boolean
  message: string | null
}

/**
 * Do this month's beginning balances still equal what they were carried from?
 * The first month is compared with the established beginning balance; every
 * other month with the previous month's frozen ending balances. A mismatch is
 * shown, never silently repaired — a DRAFT month can be re-carried by a user,
 * an approved one is left as approved.
 */
export async function checkCarry(db: Db, period: ReconPeriod): Promise<CarryCheck> {
  const bank = period.beginningBankBalance.toFixed(2)
  const book = period.beginningBookBalance.toFixed(2)
  if (period.previousPeriodId) {
    const prev = await db.reconPeriod.findUnique({ where: { id: period.previousPeriodId } })
    if (!prev) return { mismatch: false, expectedBank: null, expectedBook: null, source: 'NONE', previousReopened: false, message: null }
    const approved = isApproved(prev.status as ReconStatus)
    const eb = money(prev.endingBankBalance)
    const ek = money(prev.endingBookBalance)
    if (!approved) {
      return {
        mismatch: true, expectedBank: eb, expectedBook: ek, source: 'PREVIOUS_PERIOD', previousReopened: true,
        message: `The previous month is ${prev.status.replace('_', ' ')} again (re-opened). This month's beginning balances will be re-carried when it is approved again.`,
      }
    }
    const mismatch = eb === null || ek === null || !sameAmount(eb, bank) || !sameAmount(ek, book)
    return {
      mismatch, expectedBank: eb, expectedBook: ek, source: 'PREVIOUS_PERIOD', previousReopened: false,
      message: mismatch
        ? `The beginning balances (bank ${bank}, book ${book}) differ from the previous month's approved ending balances (bank ${eb}, book ${ek}) by bank ${eb ? sub(bank, eb) : '?'}, book ${ek ? sub(book, ek) : '?'}.`
        : null,
    }
  }
  const opening = await db.reconOpeningBalance.findUnique({ where: { accountKey: period.accountKey } })
  if (!opening) return { mismatch: false, expectedBank: null, expectedBook: null, source: 'NONE', previousReopened: false, message: null }
  const eb = opening.bankBalance.toFixed(2)
  const ek = opening.bookBalance.toFixed(2)
  const mismatch = !sameAmount(eb, bank) || !sameAmount(ek, book)
  return {
    mismatch, expectedBank: eb, expectedBook: ek, source: 'OPENING', previousReopened: false,
    message: mismatch ? `The beginning balances differ from the established beginning balance (bank ${eb}, book ${ek}).` : null,
  }
}

export type PeriodView = {
  period: ReconPeriod
  account: ReconAccount
  computation: ReconComputation
  otherCurrency: number
  /** True when the figures shown are the approval snapshot. */
  frozen: boolean
  /** For a frozen month: today's live figures differ from the snapshot (a later, back-dated clearing). Shown, never applied. */
  liveDrift: { adjustedBank: string; adjustedBook: string; totalOutstandingChecks: string } | null
  carry: CarryCheck
}

export async function loadPeriodView(db: Db, periodId: string): Promise<PeriodView | null> {
  const period = await db.reconPeriod.findUnique({ where: { id: periodId } })
  if (!period) return null
  const account = await findReconAccount(db, period.accountKey)
  if (!account) return null
  const carry = await checkCarry(db, period)
  const snap = period.snapshot as ReconSnapshot | null
  if (isApproved(period.status as ReconStatus) && snap?.version === 1) {
    const live = await computeLive(db, period)
    const f = live.computation.figures
    const s = snap.computation.figures
    const drift = !sameAmount(f.adjustedBank, s.adjustedBank) || !sameAmount(f.adjustedBook, s.adjustedBook) || !sameAmount(f.totalOutstandingChecks, s.totalOutstandingChecks)
    return {
      period, account, computation: snap.computation, otherCurrency: snap.otherCurrency, frozen: true, carry,
      liveDrift: drift ? { adjustedBank: f.adjustedBank, adjustedBook: f.adjustedBook, totalOutstandingChecks: f.totalOutstandingChecks } : null,
    }
  }
  const { computation, otherCurrency } = await computeLive(db, period)
  return { period, account, computation, otherCurrency, frozen: false, liveDrift: null, carry }
}

// ─── the dashboard ────────────────────────────────────────────────────────

export type DashboardFilters = { accountKey?: string; year?: number; month?: number; status?: ReconStatus }

export type DashboardRow = {
  account: ReconAccount
  /** Null for an account with a beginning balance and no month started yet. */
  periodId: string | null
  month: Month | null
  status: ReconStatus | null
  currency: string
  beginningBank: string | null
  beginningBook: string | null
  endingBank: string | null
  endingBook: string | null
  totalOutstandingChecks: string | null
  totalDepositsInTransit: string | null
  unidentified: number | null
  difference: string | null
  carryMismatch: boolean
  /** No bank statement ending balance entered: the difference is not yet meaningful. */
  noStatement: boolean
  /** The month after the latest approved one has begun and is not open yet. */
  canOpenNext: Month | null
}

/**
 * One row per period matching the filters. With no month or year chosen, the
 * CURRENT month of each account: its latest period, and accounts with a
 * beginning balance and none started. Approved months read their frozen
 * columns; open ones are computed live.
 */
export async function listDashboard(db: Db, filters: DashboardFilters, todayManila: string): Promise<DashboardRow[]> {
  const accounts = await listReconAccounts(db)
  const byKey = new Map(accounts.map((a) => [a.accountKey, a]))
  const where: Prisma.ReconPeriodWhereInput = {}
  if (filters.accountKey) where.accountKey = filters.accountKey
  if (filters.status) where.status = filters.status
  if (filters.year) {
    const from = filters.month ? `${filters.year}-${String(filters.month).padStart(2, '0')}` : `${filters.year}-01`
    const to = filters.month ? from : `${filters.year}-12`
    where.periodStart = { gte: new Date(`${from}-01T00:00:00.000Z`), lte: new Date(`${to}-01T00:00:00.000Z`) }
  }
  const current = !filters.year && !filters.month
  let periods = await db.reconPeriod.findMany({ where, orderBy: [{ periodStart: 'desc' }] })
  // A month without a year: that month of every year.
  if (filters.month && !filters.year) periods = periods.filter((p) => p.periodStart.getUTCMonth() + 1 === filters.month)
  if (current) {
    const latest = new Map<string, ReconPeriod>()
    for (const p of periods) if (!latest.has(p.accountKey)) latest.set(p.accountKey, p)
    periods = [...latest.values()]
  }

  const rows: DashboardRow[] = []
  for (const p of periods) {
    const account = byKey.get(p.accountKey)
    if (!account) continue
    const status = p.status as ReconStatus
    const carry = await checkCarry(db, p)
    let figures: Pick<DashboardRow, 'endingBank' | 'endingBook' | 'totalOutstandingChecks' | 'totalDepositsInTransit' | 'unidentified' | 'difference'>
    if (isApproved(status)) {
      figures = {
        endingBank: money(p.endingBankBalance), endingBook: money(p.endingBookBalance),
        totalOutstandingChecks: money(p.totalOutstandingChecks), totalDepositsInTransit: money(p.totalDepositsInTransit),
        unidentified: p.unidentifiedCount, difference: money(p.difference),
      }
    } else {
      const { computation: c } = await computeLive(db, p)
      figures = {
        endingBank: c.figures.endingBank, endingBook: c.figures.endingBook,
        totalOutstandingChecks: c.figures.totalOutstandingChecks, totalDepositsInTransit: c.figures.depositsInTransit,
        unidentified: c.counts.unidentified, difference: c.figures.difference,
      }
    }
    const month = monthOf(p.periodStart)
    const next = nextMonthOf(month)
    rows.push({
      account, periodId: p.id, month, status, currency: p.currency,
      beginningBank: p.beginningBankBalance.toFixed(2), beginningBook: p.beginningBookBalance.toFixed(2),
      ...figures, carryMismatch: carry.mismatch, noStatement: p.statementEndingBalance === null,
      canOpenNext: current && isApproved(status) && `${next}-01` <= todayManila ? next : null,
    })
  }

  if (current && !filters.status) {
    const openings = await db.reconOpeningBalance.findMany({ where: filters.accountKey ? { accountKey: filters.accountKey } : {} })
    const started = new Set(rows.map((r) => r.account.accountKey))
    const withPeriods = new Set((await db.reconPeriod.findMany({ select: { accountKey: true }, distinct: ['accountKey'] })).map((p) => p.accountKey))
    for (const o of openings) {
      const account = byKey.get(o.accountKey)
      if (!account || started.has(o.accountKey) || withPeriods.has(o.accountKey)) continue
      rows.push({
        account, periodId: null, month: monthOf(o.effectiveDate), status: null, currency: o.currency,
        beginningBank: o.bankBalance.toFixed(2), beginningBook: o.bookBalance.toFixed(2),
        endingBank: null, endingBook: null, totalOutstandingChecks: null, totalDepositsInTransit: null,
        unidentified: null, difference: null, carryMismatch: false, noStatement: true, canOpenNext: null,
      })
    }
  }
  return rows.sort((a, b) => a.account.code.localeCompare(b.account.code) || (b.month ?? '').localeCompare(a.month ?? ''))
}

function nextMonthOf(month: Month): Month {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** The approval history: every recon audit row naming this period, oldest first. */
export async function loadPeriodHistory(db: Db, periodId: string) {
  return db.auditLog.findMany({
    where: { action: { startsWith: 'recon_' }, details: { path: ['periodId'], equals: periodId } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, action: true, createdAt: true, remarks: true, details: true, user: { select: { name: true } } },
  })
}
