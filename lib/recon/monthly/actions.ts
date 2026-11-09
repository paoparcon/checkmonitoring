import type { Prisma, PrismaClient, ReconPeriod } from '@prisma/client'
import { writeAudit } from '@/lib/audit'
import { DomainError } from '@/lib/domain/errors'
import { recordClearing } from '@/lib/domain/actions'
import { isIsoDay, dayToDate } from '@/lib/domain/details'
import { sheetsFromWorkbook } from '@/lib/admin/ready-upload'
import { frozenColumns, type LineKind } from './compute'
import {
  workflowVerdict, reopenRequestVerdict, reopenDecisionVerdict, parseAmount, monthOf, monthStart, nextMonth,
  monthHasBegun, isApproved, firstDay, lastDay, inMonth, monthLabel,
  type ReconActor, type ReconStatus, type WorkflowAction,
} from './period'
import { parseStatement, csvRows, type ParsedStatement, type StatementSheet } from './statement'
import { proposeMatches, classificationsFor, lineCheckNumbers, stripZeros, type Proposal, type MatchCheck } from './match'
import { findReconAccount, accountColumns, computeLive, loadAccountChecks, type ReconAccount, type ReconSnapshot } from './query'

/**
 * THE MONTHLY RECONCILIATION'S WRITES. The only module that changes a
 * reconciliation row. Each action runs in one transaction with its audit row
 * (`writeAudit`, append-only — rule 7); every row's `details` carry
 * `periodId` (where there is one) and `accountKey`, which is how the period
 * page reads its approval history back.
 *
 * Refusals are `DomainError`s with copy a Finance user reads. A DRAFT month is
 * the only editable one; a status move is a conditional `updateMany` on the
 * status that was read, so two people pressing at once cannot both win.
 *
 * Clearing a cheque from a statement line goes through `recordClearing` — the
 * same domain action as the check page and /clearing, its own audit row and
 * guards — so a reconciliation can never clear a cheque some other way.
 */

type Db = PrismaClient | Prisma.TransactionClient
const TX = { timeout: 30_000, maxWait: 15_000 }

async function inTx<T>(db: Db, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if ('$transaction' in db && typeof db.$transaction === 'function') return (db as PrismaClient).$transaction(fn, TX)
  return fn(db as Prisma.TransactionClient)
}

const fail = (code: string, message: string): never => { throw new DomainError(code, message) }
const req = (s: string | null | undefined) => (s ?? '').trim()

function amountOrFail(raw: string, label: string, opts: { allowNegative?: boolean; positive?: boolean } = {}): string {
  const a = parseAmount(raw, opts)
  if (a === null) return fail('BAD_AMOUNT', `${label} is not an amount (digits, at most two decimals).`)
  if (opts.positive && (a === '0.00' || a.startsWith('-'))) return fail('BAD_AMOUNT', `${label} must be more than zero.`)
  return a
}

function dayOrFail(raw: string, label: string): Date {
  const s = req(raw)
  if (!isIsoDay(s)) return fail('BAD_DATE', `${label} is not a real day.`)
  return dayToDate(s)
}

async function accountOrFail(db: Db, accountKey: string): Promise<ReconAccount> {
  const a = await findReconAccount(db, accountKey)
  return a ?? fail('NO_ACCOUNT', 'That bank account is not a check book or cash account of this system.')
}

async function draftOrFail(tx: Prisma.TransactionClient, periodId: string): Promise<ReconPeriod> {
  const p = await tx.reconPeriod.findUnique({ where: { id: periodId } })
  if (!p) return fail('NO_PERIOD', 'That reconciliation does not exist.')
  if (p.status !== 'DRAFT') {
    return fail('LOCKED', `This reconciliation is ${p.status.replace('_', ' ')} and cannot be changed. ${isApproved(p.status as ReconStatus) ? 'Re-opening it needs a second Finance Admin\'s approval.' : 'Return it to DRAFT first.'}`)
  }
  return p
}

const audit = (tx: Prisma.TransactionClient, actor: ReconActor, action: string, details: Prisma.InputJsonObject, remarks?: string, checkId?: string) =>
  writeAudit(tx, { actorType: 'USER', userId: actor.id, action, details, remarks, checkId })

// ─── 1. beginning balances ────────────────────────────────────────────────

export type BeginningInput = {
  accountKey: string
  effectiveDate: string
  bankBalance: string
  bookBalance: string
  currency?: string
  reference: string
  supportingDocument?: string
}

/**
 * Establish an account's beginning balance — FINANCE_ADMIN, once per account.
 * The effective date is the 1st of the first month to reconcile: the balance
 * is as at the start of that day. Bank and book are separate figures; both
 * may be negative (an overdraft), and both are required with a reference.
 */
export async function establishBeginningBalance(db: Db, input: BeginningInput & { actor: ReconActor }) {
  if (input.actor.role !== 'FINANCE_ADMIN') fail('ADMIN_ONLY', 'Only a Finance Admin can establish a beginning balance.')
  const effective = dayOrFail(input.effectiveDate, 'The effective date')
  if (effective.getUTCDate() !== 1) fail('NOT_MONTH_START', 'The beginning balance is as at the start of a reconciliation month — use the 1st of the month.')
  const bank = amountOrFail(input.bankBalance, 'The beginning bank balance', { allowNegative: true })
  const book = amountOrFail(input.bookBalance, 'The beginning book balance', { allowNegative: true })
  const reference = req(input.reference)
  if (!reference) fail('REFERENCE_REQUIRED', 'Give the reference or supporting document the balances were taken from.')
  const currency = (req(input.currency) || 'PHP').toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) fail('BAD_CURRENCY', 'The currency is a three-letter code (PHP, USD).')
  return inTx(db, async (tx) => {
    const account = await accountOrFail(tx, input.accountKey)
    if (await tx.reconOpeningBalance.findUnique({ where: { accountKey: account.accountKey } })) {
      fail('ALREADY_ESTABLISHED', `${account.code} already has a beginning balance. Correct it instead (a reason is required).`)
    }
    const row = await tx.reconOpeningBalance.create({
      data: {
        ...accountColumns(account), effectiveDate: effective, currency, bankBalance: bank, bookBalance: book,
        reference, supportingDocument: req(input.supportingDocument) || null, createdById: input.actor.id,
      },
    })
    await audit(tx, input.actor, 'recon_opening_established', {
      accountKey: account.accountKey, account: account.code, effectiveDate: firstDay(monthOf(effective)),
      currency, bankBalance: bank, bookBalance: book, reference, supportingDocument: row.supportingDocument,
    })
    return row
  })
}

/**
 * Correct an established beginning balance — FINANCE_ADMIN, reason required,
 * the old and new figures on the audit row. Allowed only while the first month
 * has not left DRAFT; that month's beginning balances follow the correction.
 * Once the first month is under review or approved the balance is locked: it
 * must be returned to DRAFT, or re-opened with a second admin's approval, first.
 */
export async function correctBeginningBalance(
  db: Db,
  input: { accountKey: string; bankBalance: string; bookBalance: string; reference: string; supportingDocument?: string; reason: string; actor: ReconActor },
) {
  if (input.actor.role !== 'FINANCE_ADMIN') fail('ADMIN_ONLY', 'Only a Finance Admin can correct a beginning balance.')
  const reason = req(input.reason)
  if (!reason) fail('REASON_REQUIRED', 'Say why the beginning balance is being corrected.')
  const bank = amountOrFail(input.bankBalance, 'The beginning bank balance', { allowNegative: true })
  const book = amountOrFail(input.bookBalance, 'The beginning book balance', { allowNegative: true })
  const reference = req(input.reference)
  if (!reference) fail('REFERENCE_REQUIRED', 'Give the reference or supporting document the balances were taken from.')
  return inTx(db, async (tx) => {
    const opening = await tx.reconOpeningBalance.findUnique({ where: { accountKey: input.accountKey } })
    if (!opening) return fail('NOT_ESTABLISHED', 'This account has no beginning balance yet.')
    const first = await tx.reconPeriod.findFirst({ where: { accountKey: input.accountKey }, orderBy: { periodStart: 'asc' } })
    if (first && first.status !== 'DRAFT') {
      fail('FIRST_PERIOD_LOCKED', `The first month (${monthLabel(monthOf(first.periodStart))}) is ${first.status.replace('_', ' ')}. Return it to DRAFT — or, if approved, have it re-opened with a second Finance Admin's approval — before correcting its beginning balance.`)
    }
    const before = { bankBalance: opening.bankBalance.toFixed(2), bookBalance: opening.bookBalance.toFixed(2), reference: opening.reference, supportingDocument: opening.supportingDocument }
    const updated = await tx.reconOpeningBalance.update({
      where: { id: opening.id },
      data: { bankBalance: bank, bookBalance: book, reference, supportingDocument: req(input.supportingDocument) || null, updatedById: input.actor.id },
    })
    if (first) {
      await tx.reconPeriod.update({ where: { id: first.id }, data: { beginningBankBalance: bank, beginningBookBalance: book } })
    }
    await audit(tx, input.actor, 'recon_opening_corrected', {
      accountKey: input.accountKey, ...(first ? { periodId: first.id } : {}),
      before, after: { bankBalance: bank, bookBalance: book, reference, supportingDocument: updated.supportingDocument },
    }, reason)
    return updated
  })
}

// ─── 2. opening a month ───────────────────────────────────────────────────

/**
 * Open the account's next month. The first one starts from the established
 * beginning balance; every later one is CARRIED FORWARD from the month before,
 * which must be approved: beginning bank = that month's statement ending
 * balance, beginning book = its ending book balance after the reconciliation's
 * adjustments. Outstanding checks, deposits in transit and open adjustments
 * need no copying — they are decided by their own dates (`compute.ts`).
 */
export async function openNextPeriod(db: Db, input: { accountKey: string; actor: ReconActor; todayManila: string }) {
  return inTx(db, async (tx) => {
    const account = await accountOrFail(tx, input.accountKey)
    const opening = await tx.reconOpeningBalance.findUnique({ where: { accountKey: account.accountKey } })
    if (!opening) return fail('NOT_ESTABLISHED', `Establish ${account.code}'s beginning balance first.`)
    const latest = await tx.reconPeriod.findFirst({ where: { accountKey: account.accountKey }, orderBy: { periodStart: 'desc' } })
    if (!latest) {
      const month = monthOf(opening.effectiveDate)
      if (!monthHasBegun(month, input.todayManila)) fail('NOT_BEGUN', `${monthLabel(month)} has not begun.`)
      const period = await tx.reconPeriod.create({
        data: {
          ...accountColumns(account), periodStart: opening.effectiveDate, currency: opening.currency, beginningSource: 'OPENING',
          beginningBankBalance: opening.bankBalance, beginningBookBalance: opening.bookBalance, createdById: input.actor.id,
        },
      })
      await audit(tx, input.actor, 'recon_period_started', {
        periodId: period.id, accountKey: account.accountKey, account: account.code, month,
        beginningBank: opening.bankBalance.toFixed(2), beginningBook: opening.bookBalance.toFixed(2), source: 'OPENING',
      })
      return period
    }
    return carryForward(tx, latest, account, input.actor, input.todayManila)
  })
}

async function carryForward(tx: Prisma.TransactionClient, prev: ReconPeriod, account: ReconAccount, actor: ReconActor, todayManila: string): Promise<ReconPeriod> {
  if (!isApproved(prev.status as ReconStatus)) {
    return fail('PREVIOUS_OPEN', `${monthLabel(monthOf(prev.periodStart))} is ${prev.status.replace('_', ' ')}. The next month opens once it is approved.`)
  }
  const month = nextMonth(monthOf(prev.periodStart))
  if (!monthHasBegun(month, todayManila)) return fail('NOT_BEGUN', `${monthLabel(month)} has not begun.`)
  if (prev.endingBankBalance === null || prev.endingBookBalance === null) {
    return fail('NO_ENDING', 'The previous month has no frozen ending balances.')
  }
  const existing = await tx.reconPeriod.findUnique({ where: { accountKey_periodStart: { accountKey: account.accountKey, periodStart: monthStart(month) } } })
  if (existing) return fail('ALREADY_OPEN', `${monthLabel(month)} is already open.`)
  const period = await tx.reconPeriod.create({
    data: {
      ...accountColumns(account), periodStart: monthStart(month), currency: prev.currency, beginningSource: 'CARRIED_FORWARD',
      previousPeriodId: prev.id, beginningBankBalance: prev.endingBankBalance, beginningBookBalance: prev.endingBookBalance,
      createdById: actor.id,
    },
  })
  await audit(tx, actor, 'recon_period_carried_forward', {
    periodId: period.id, previousPeriodId: prev.id, accountKey: account.accountKey, account: account.code, month,
    beginningBank: prev.endingBankBalance.toFixed(2), beginningBook: prev.endingBookBalance.toFixed(2),
  })
  return period
}

/** A DRAFT month whose previous month was re-approved with other figures takes them again, audited. */
export async function recarryBeginning(db: Db, input: { periodId: string; actor: ReconActor }) {
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    let bank: string, book: string
    if (p.previousPeriodId) {
      const prev = await tx.reconPeriod.findUniqueOrThrow({ where: { id: p.previousPeriodId } })
      if (!isApproved(prev.status as ReconStatus) || prev.endingBankBalance === null || prev.endingBookBalance === null) {
        return fail('PREVIOUS_OPEN', 'The previous month is not approved; there is nothing to carry yet.')
      }
      bank = prev.endingBankBalance.toFixed(2); book = prev.endingBookBalance.toFixed(2)
    } else {
      const o = await tx.reconOpeningBalance.findUniqueOrThrow({ where: { accountKey: p.accountKey } })
      bank = o.bankBalance.toFixed(2); book = o.bookBalance.toFixed(2)
    }
    const before = { beginningBank: p.beginningBankBalance.toFixed(2), beginningBook: p.beginningBookBalance.toFixed(2) }
    const updated = await tx.reconPeriod.update({ where: { id: p.id }, data: { beginningBankBalance: bank, beginningBookBalance: book } })
    await audit(tx, input.actor, 'recon_beginning_recarried', { periodId: p.id, accountKey: p.accountKey, before, after: { beginningBank: bank, beginningBook: book } })
    return updated
  })
}

// ─── 3. the month's own figures ───────────────────────────────────────────

export async function setStatementBalances(db: Db, input: { periodId: string; statementEnding: string; statementBeginning: string; actor: ReconActor }) {
  const ending = req(input.statementEnding) === '' ? null : amountOrFail(input.statementEnding, 'The statement ending balance', { allowNegative: true })
  const beginning = req(input.statementBeginning) === '' ? null : amountOrFail(input.statementBeginning, 'The statement beginning balance', { allowNegative: true })
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    const updated = await tx.reconPeriod.update({ where: { id: p.id }, data: { statementEndingBalance: ending, statementBeginningBalance: beginning } })
    await audit(tx, input.actor, 'recon_statement_balances_set', {
      periodId: p.id, accountKey: p.accountKey,
      before: { ending: p.statementEndingBalance?.toFixed(2) ?? null, beginning: p.statementBeginningBalance?.toFixed(2) ?? null },
      after: { ending, beginning },
    })
    return updated
  })
}

export async function addBookEntry(
  db: Db,
  input: { periodId: string; kind: 'DEPOSIT' | 'DISBURSEMENT'; entryDate: string; amount: string; reference: string; description?: string; actor: ReconActor },
) {
  const amount = amountOrFail(input.amount, 'The amount', { positive: true })
  const date = dayOrFail(input.entryDate, 'The date')
  const reference = req(input.reference)
  if (!reference) fail('REFERENCE_REQUIRED', 'Give the book reference (OR, deposit slip, JV number).')
  if (input.kind !== 'DEPOSIT' && input.kind !== 'DISBURSEMENT') fail('BAD_KIND', 'A book entry is a DEPOSIT or a DISBURSEMENT.')
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    const month = monthOf(p.periodStart)
    const day = date.toISOString().slice(0, 10)
    // Inside the month — except the first month, which also takes items open at the beginning balance date.
    if (!inMonth(day, month) && !(p.beginningSource === 'OPENING' && day < firstDay(month))) {
      fail('OUTSIDE_MONTH', p.beginningSource === 'OPENING'
        ? `A book entry for ${monthLabel(month)} is dated in it, or before it for an item open at the beginning balance date.`
        : `A book entry for ${monthLabel(month)} is dated in ${monthLabel(month)}.`)
    }
    const entry = await tx.reconBookEntry.create({
      data: { periodId: p.id, accountKey: p.accountKey, kind: input.kind, entryDate: date, amount, reference, description: req(input.description) || null, createdById: input.actor.id },
    })
    await audit(tx, input.actor, 'recon_book_entry_added', { periodId: p.id, accountKey: p.accountKey, entryId: entry.id, kind: input.kind, entryDate: day, amount, reference })
    return entry
  })
}

export async function removeBookEntry(db: Db, input: { entryId: string; reason: string; actor: ReconActor }) {
  const reason = req(input.reason)
  if (!reason) fail('REASON_REQUIRED', 'Say why the entry is removed.')
  return inTx(db, async (tx) => {
    const e = await tx.reconBookEntry.findUnique({ where: { id: input.entryId }, include: { matchedLine: true } })
    if (!e) return fail('NOT_FOUND', 'That entry does not exist.')
    await draftOrFail(tx, e.periodId)
    if (e.matchedLine) fail('MATCHED', 'This entry is matched to a statement line. Re-classify the line first.')
    await tx.reconBookEntry.delete({ where: { id: e.id } })
    await audit(tx, input.actor, 'recon_book_entry_removed', {
      periodId: e.periodId, accountKey: e.accountKey,
      entry: { id: e.id, kind: e.kind, entryDate: e.entryDate.toISOString().slice(0, 10), amount: e.amount.toFixed(2), reference: e.reference, description: e.description },
    }, reason)
  })
}

export async function addAdjustment(
  db: Db,
  input: { periodId: string; side: 'BANK' | 'BOOK'; direction: 'ADD' | 'LESS'; amount: string; description: string; reference?: string; actor: ReconActor },
) {
  const amount = amountOrFail(input.amount, 'The amount', { positive: true })
  const description = req(input.description)
  if (!description) fail('DESCRIPTION_REQUIRED', 'Describe the adjustment.')
  if (!['BANK', 'BOOK'].includes(input.side) || !['ADD', 'LESS'].includes(input.direction)) fail('BAD_KIND', 'Choose the side and whether it adds or deducts.')
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    const a = await tx.reconAdjustment.create({
      data: { periodId: p.id, accountKey: p.accountKey, side: input.side, direction: input.direction, amount, description, reference: req(input.reference) || null, createdById: input.actor.id },
    })
    await audit(tx, input.actor, 'recon_adjustment_added', { periodId: p.id, accountKey: p.accountKey, adjustmentId: a.id, side: input.side, direction: input.direction, amount, description })
    return a
  })
}

export async function removeAdjustment(db: Db, input: { adjustmentId: string; reason: string; actor: ReconActor }) {
  const reason = req(input.reason)
  if (!reason) fail('REASON_REQUIRED', 'Say why the adjustment is removed.')
  return inTx(db, async (tx) => {
    const a = await tx.reconAdjustment.findUnique({ where: { id: input.adjustmentId } })
    if (!a) return fail('NOT_FOUND', 'That adjustment does not exist.')
    await draftOrFail(tx, a.periodId)
    await tx.reconAdjustment.delete({ where: { id: a.id } })
    await audit(tx, input.actor, 'recon_adjustment_removed', {
      periodId: a.periodId, accountKey: a.accountKey,
      adjustment: { id: a.id, side: a.side, direction: a.direction, amount: a.amount.toFixed(2), description: a.description, reference: a.reference },
    }, reason)
  })
}

/**
 * Mark an open item resolved IN this (DRAFT) month: a BANK adjustment, a
 * BANK_ERROR line, or an UNIDENTIFIED line explained. From this month on it no
 * longer counts or carries; the months before keep it as they had it.
 */
export async function resolveItem(db: Db, input: { periodId: string; lineId?: string; adjustmentId?: string; resolution: string; actor: ReconActor; now: Date }) {
  const resolution = req(input.resolution)
  if (!resolution) fail('REMARKS_REQUIRED', 'Say how the item was resolved.')
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    const data = { resolvedPeriodStart: p.periodStart, resolvedById: input.actor.id, resolvedAt: input.now, resolution }
    if (input.lineId) {
      const l = await tx.reconStatementLine.findUnique({ where: { id: input.lineId }, include: { period: true } })
      if (!l || l.accountKey !== p.accountKey) return fail('NOT_FOUND', 'That line is not on this account.')
      if (!['BANK_ERROR', 'UNIDENTIFIED_DEBIT', 'UNIDENTIFIED_CREDIT'].includes(l.kind)) fail('NOT_OPEN_ITEM', 'Only bank errors and unidentified lines are resolved.')
      if (l.period.periodStart > p.periodStart) fail('LATER_MONTH', 'That line belongs to a later month.')
      if (l.resolvedPeriodStart) fail('ALREADY_RESOLVED', 'That line is already resolved.')
      await tx.reconStatementLine.update({ where: { id: l.id }, data })
      await audit(tx, input.actor, 'recon_item_resolved', { periodId: p.id, accountKey: p.accountKey, lineId: l.id, kind: l.kind, lineMonth: monthOf(l.period.periodStart) }, resolution)
      return
    }
    if (input.adjustmentId) {
      const a = await tx.reconAdjustment.findUnique({ where: { id: input.adjustmentId }, include: { period: true } })
      if (!a || a.accountKey !== p.accountKey) return fail('NOT_FOUND', 'That adjustment is not on this account.')
      if (a.side !== 'BANK') fail('NOT_OPEN_ITEM', 'Only bank-side adjustments carry forward and are resolved.')
      if (a.period.periodStart > p.periodStart) fail('LATER_MONTH', 'That adjustment belongs to a later month.')
      if (a.resolvedPeriodStart) fail('ALREADY_RESOLVED', 'That adjustment is already resolved.')
      await tx.reconAdjustment.update({ where: { id: a.id }, data })
      await audit(tx, input.actor, 'recon_item_resolved', { periodId: p.id, accountKey: p.accountKey, adjustmentId: a.id, adjustmentMonth: monthOf(a.period.periodStart) }, resolution)
      return
    }
    fail('NOTHING', 'Choose the item to resolve.')
  })
}

// ─── 4. the bank statement ────────────────────────────────────────────────

export const MAX_STATEMENT_BYTES = 4 * 1024 * 1024
export const STATEMENT_APPLY_BUDGET_MS = 30_000

export async function readStatementFile(name: string, buffer: Buffer): Promise<{ ok: true; sheets: StatementSheet[] } | { ok: false; message: string }> {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (ext === 'xlsx' || ext === 'xlsm') return { ok: true, sheets: await sheetsFromWorkbook(buffer) }
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') return { ok: true, sheets: [{ name: name, rows: csvRows(buffer.toString('utf8').replace(/^﻿/, '')) }] }
  return { ok: false, message: 'Upload the statement as Excel (.xlsx) or CSV. An old .xls must be saved as .xlsx first.' }
}

export type PlannedLine = ParsedStatement['lines'][number] & {
  proposal: Proposal
  duplicate: boolean
  checkLabel: string | null
}

export type StatementPlan = {
  fileName: string
  month: string
  parsed: Omit<ParsedStatement, 'lines'>
  lines: PlannedLine[]
  newLines: number
  duplicates: number
  autoChecks: number
  autoEntries: number
}

async function matchCandidates(tx: Db, period: ReconPeriod, numbers: string[]): Promise<MatchCheck[]> {
  const account = await accountOrFail(tx, period.accountKey)
  const { checks } = await loadAccountChecks(tx, period.accountKey, period.currency)
  const mine: MatchCheck[] = checks.map((c) => ({ ...c, currency: period.currency, inAccount: true, accountCode: account.code }))
  const known = new Set(mine.map((c) => stripZeros(c.checkNumber)))
  const others = numbers.filter((n) => !known.has(n))
  if (others.length > 0) {
    const elsewhere = await tx.check.findMany({
      where: { checkNumber: { in: others }, isCheque: true },
      select: {
        id: true, checkNumber: true, payeeName: true, amount: true, currency: true, checkDate: true, releasedAt: true,
        clearingStatus: true, clearedDate: true, status: true, checkBook: { select: { code: true } }, cashAccount: { select: { code: true } },
      },
    })
    for (const c of elsewhere) {
      mine.push({
        id: c.id, checkNumber: c.checkNumber, payee: c.payeeName, amount: c.amount?.toFixed(2) ?? null, currency: c.currency,
        checkDate: c.checkDate, releasedAt: c.releasedAt, clearingStatus: c.clearingStatus, clearedDate: c.clearedDate, status: c.status,
        inAccount: false, accountCode: c.checkBook?.code ?? c.cashAccount?.code ?? null,
      })
    }
  }
  return mine
}

/** Read and match a statement file against a DRAFT month. Writes nothing. */
export async function planStatementUpload(db: Db, input: { periodId: string; fileName: string; sheets: StatementSheet[] }): Promise<StatementPlan> {
  const period = await db.reconPeriod.findUnique({ where: { id: input.periodId } })
  if (!period) return fail('NO_PERIOD', 'That reconciliation does not exist.')
  if (period.status !== 'DRAFT') return fail('LOCKED', 'Only a DRAFT reconciliation takes a statement.')
  const month = monthOf(period.periodStart)
  const parsed = parseStatement(input.sheets, month)
  const existing = new Set((await db.reconStatementLine.findMany({
    where: { accountKey: period.accountKey, fingerprint: { in: parsed.lines.map((l) => l.fingerprint) } }, select: { fingerprint: true },
  })).map((l) => l.fingerprint))
  const fresh = parsed.lines.filter((l) => !existing.has(l.fingerprint))
  const numbers = [...new Set(fresh.flatMap((l) => lineCheckNumbers(l)))]
  const checks = await matchCandidates(db, period, numbers)
  const linkedChecks = new Set((await db.reconStatementLine.findMany({ where: { checkId: { in: checks.map((c) => c.id) } }, select: { checkId: true } })).map((l) => l.checkId))
  const entries = (await db.reconBookEntry.findMany({
    where: { accountKey: period.accountKey, matchedLine: null, entryDate: { lte: new Date(`${lastDay(month)}T00:00:00.000Z`) } },
  })).map((e) => ({ id: e.id, kind: e.kind, entryDay: e.entryDate.toISOString().slice(0, 10), amount: e.amount.toFixed(2), reference: e.reference }))
  // A cheque already on a statement line (an earlier upload) is not offered again.
  const proposals = proposeMatches(fresh, checks.filter((c) => !linkedChecks.has(c.id)), entries, period.currency)
  const byId = new Map(checks.map((c) => [c.id, c]))
  let i = 0
  const lines: PlannedLine[] = parsed.lines.map((l) => {
    if (existing.has(l.fingerprint)) {
      return { ...l, duplicate: true, checkLabel: null, proposal: { kind: 'UNIDENTIFIED_DEBIT', method: null, checkId: null, bookEntryId: null, note: 'Already uploaded — left alone.', suggestedCheckId: null, alreadyCleared: false, payeeOnLine: null } }
    }
    const proposal = proposals[i++]
    const c = byId.get(proposal.checkId ?? proposal.suggestedCheckId ?? '')
    return { ...l, duplicate: false, proposal, checkLabel: c ? `${c.checkNumber} · ${c.payee ?? '—'} · ${c.amount ?? '—'}` : null }
  })
  const { lines: _omit, ...rest } = parsed
  void _omit
  return {
    fileName: input.fileName, month, parsed: rest, lines,
    newLines: fresh.length, duplicates: parsed.lines.length - fresh.length,
    autoChecks: proposals.filter((p) => p.kind === 'CHECK').length,
    autoEntries: proposals.filter((p) => p.kind === 'BOOK_ENTRY').length,
  }
}

export type StatementApplied = { inserted: number; checksCleared: number; checksLinked: number; notReached: number; refused: { place: string; message: string }[]; balancesSet: boolean }

/**
 * Apply a statement plan: re-planned here from the same file, never trusted
 * from the browser. Each AUTO cheque line is inserted and its cheque cleared
 * (`recordClearing`, cleared date = the line's day, the line's reference as
 * the bank's clearing reference) in ONE transaction; the other lines go in
 * one transaction together. Stops at the deadline; the same file uploaded
 * again finishes the rest (what was inserted reads "already uploaded").
 */
export async function applyStatementUpload(
  db: PrismaClient,
  input: { periodId: string; fileName: string; sheets: StatementSheet[]; setBalances: boolean; actor: ReconActor; now: Date; deadline: Date },
): Promise<StatementApplied> {
  const plan = await planStatementUpload(db, input)
  const fresh = plan.lines.filter((l) => !l.duplicate)
  const out: StatementApplied = { inserted: 0, checksCleared: 0, checksLinked: 0, notReached: 0, refused: [], balancesSet: false }
  const period = await db.reconPeriod.findUniqueOrThrow({ where: { id: input.periodId } })
  const row = (l: PlannedLine) => ({
    periodId: period.id, accountKey: period.accountKey, lineDate: dayToDate(l.lineDay), description: l.description.slice(0, 500),
    reference: l.reference?.slice(0, 200) ?? null, checkNumber: l.checkNumber, debit: l.debit, credit: l.credit, balance: l.balance,
    sourceFile: input.fileName.slice(0, 200), sourcePlace: l.place, fingerprint: l.fingerprint,
    kind: l.proposal.kind, matchMethod: l.proposal.method, checkId: l.proposal.checkId, bookEntryId: l.proposal.bookEntryId,
    remarks: l.proposal.method ? null : l.proposal.note.slice(0, 500), createdById: input.actor.id,
  })

  const others = fresh.filter((l) => l.proposal.kind !== 'CHECK')
  await inTx(db, async (tx) => {
    await draftOrFail(tx, period.id)
    if (others.length > 0) await tx.reconStatementLine.createMany({ data: others.map(row) })
    out.inserted += others.length
    if (input.setBalances && (plan.parsed.statementEnding !== null || plan.parsed.statementBeginning !== null)) {
      await tx.reconPeriod.update({
        where: { id: period.id },
        data: {
          ...(plan.parsed.statementEnding !== null ? { statementEndingBalance: plan.parsed.statementEnding } : {}),
          ...(plan.parsed.statementBeginning !== null ? { statementBeginningBalance: plan.parsed.statementBeginning } : {}),
        },
      })
      out.balancesSet = true
    }
  })

  for (const l of fresh.filter((x) => x.proposal.kind === 'CHECK')) {
    if (Date.now() > input.deadline.getTime()) { out.notReached++; continue }
    try {
      await inTx(db, async (tx) => {
        await draftOrFail(tx, period.id)
        await tx.reconStatementLine.create({ data: row(l) })
        if (!l.proposal.alreadyCleared) {
          await recordClearing(tx, {
            checkId: l.proposal.checkId!, userId: input.actor.id, clearingStatus: 'CLEARED',
            crNumber: l.reference ?? undefined, clearedDate: dayToDate(l.lineDay), now: input.now,
            source: { file: input.fileName, place: `${l.place} (reconciliation ${monthLabel(plan.month)})` },
          })
        }
      })
      out.inserted++
      if (l.proposal.alreadyCleared) out.checksLinked++; else out.checksCleared++
    } catch (e) {
      out.refused.push({ place: l.place, message: e instanceof DomainError ? e.message : 'could not be written' })
      if (!(e instanceof DomainError)) console.error('statement line failed:', e instanceof Error ? e.message : e)
    }
  }

  await inTx(db, (tx) => audit(tx, input.actor, 'recon_statement_uploaded', {
    periodId: period.id, accountKey: period.accountKey, file: input.fileName, month: plan.month,
    inserted: out.inserted, duplicates: plan.duplicates, checksCleared: out.checksCleared, checksLinked: out.checksLinked,
    autoEntries: plan.autoEntries, notReached: out.notReached, refused: out.refused.length,
    skipped: plan.parsed.skipped.length, balancesSet: out.balancesSet,
    statementEnding: plan.parsed.statementEnding, statementBeginning: plan.parsed.statementBeginning,
  }))
  return out
}

/**
 * Take an uploaded file's lines back out of a DRAFT month (the wrong file, the
 * wrong account). Cleared-cheque lines stay — a clearing is never undone
 * (`assertClearing`) — and the result says how many.
 */
export async function removeStatementUpload(db: Db, input: { periodId: string; sourceFile: string; reason: string; actor: ReconActor }) {
  const reason = req(input.reason)
  if (!reason) fail('REASON_REQUIRED', 'Say why the file is removed.')
  return inTx(db, async (tx) => {
    const p = await draftOrFail(tx, input.periodId)
    const lines = await tx.reconStatementLine.findMany({ where: { periodId: p.id, sourceFile: input.sourceFile } })
    const removable = lines.filter((l) => l.kind !== 'CHECK')
    await tx.reconStatementLine.deleteMany({ where: { id: { in: removable.map((l) => l.id) } } })
    await audit(tx, input.actor, 'recon_statement_upload_removed', {
      periodId: p.id, accountKey: p.accountKey, file: input.sourceFile, removed: removable.length, keptClearedChecks: lines.length - removable.length,
      lines: removable.map((l) => ({ id: l.id, day: l.lineDate.toISOString().slice(0, 10), debit: l.debit?.toFixed(2) ?? null, credit: l.credit?.toFixed(2) ?? null, description: l.description, kind: l.kind })),
    }, reason)
    return { removed: removable.length, kept: lines.length - removable.length }
  })
}

// ─── 5. manual matching and classification (remarks mandatory) ─────────────

async function editableLine(tx: Prisma.TransactionClient, lineId: string) {
  const l = await tx.reconStatementLine.findUnique({ where: { id: lineId } })
  if (!l) return fail('NOT_FOUND', 'That statement line does not exist.')
  const p = await draftOrFail(tx, l.periodId)
  if (l.kind === 'CHECK') fail('CHECK_MATCHED', 'This line has cleared a check, and a clearing cannot be undone.')
  return { line: l, period: p }
}

/** Match a debit line to a cheque of this account by number, by hand. Clears the cheque on the line's day. */
export async function matchLineToCheck(db: Db, input: { lineId: string; checkNumber: string; remarks: string; actor: ReconActor; now: Date }) {
  const remarks = req(input.remarks)
  if (!remarks) fail('REMARKS_REQUIRED', 'A manual match needs a remark saying why.')
  const number = stripZeros(req(input.checkNumber).replace(/\s/g, ''))
  if (!/^\d{4,}$/.test(number)) fail('BAD_NUMBER', 'Type the check number (digits).')
  return inTx(db, async (tx) => {
    const { line, period } = await editableLine(tx, input.lineId)
    if (!line.debit) fail('NOT_DEBIT', 'Only a debit line can clear a check.')
    const candidates = (await tx.check.findMany({
      where: { AND: [{ OR: [{ checkNumber: number }, { checkNumber: { endsWith: number } }] }, { OR: [{ checkBookId: period.accountKey }, { checkBookId: null, cashAccountId: period.accountKey }] }], isCheque: true },
    })).filter((c) => stripZeros(c.checkNumber) === number)
    if (candidates.length === 0) fail('NOT_IN_ACCOUNT', `No check ${number} is held on this account.`)
    if (candidates.length > 1) fail('AMBIGUOUS', `Check ${number} names ${candidates.length} checks on this account.`)
    const c = candidates[0]
    if (c.status !== 'RELEASED') fail('NOT_RELEASED', `Check ${c.checkNumber} is ${c.status}, not RELEASED.`)
    if (c.currency !== period.currency) fail('CURRENCY', `Check ${c.checkNumber} is in ${c.currency}.`)
    if (await tx.reconStatementLine.findUnique({ where: { checkId: c.id } })) fail('ALREADY_ON_LINE', `Check ${c.checkNumber} is already matched to another statement line.`)
    const lineDay = line.lineDate.toISOString().slice(0, 10)
    await tx.reconStatementLine.update({ where: { id: line.id }, data: { kind: 'CHECK', matchMethod: 'MANUAL', checkId: c.id, bookEntryId: null, remarks } })
    if (c.clearingStatus !== 'CLEARED') {
      await recordClearing(tx, {
        checkId: c.id, userId: input.actor.id, clearingStatus: 'CLEARED', crNumber: line.reference ?? undefined,
        clearedDate: line.lineDate, now: input.now,
        source: { file: line.sourceFile, place: `${line.sourcePlace} (reconciliation ${monthLabel(monthOf(period.periodStart))}, manual match)` },
      })
    }
    await audit(tx, input.actor, 'recon_line_matched', {
      periodId: period.id, accountKey: period.accountKey, lineId: line.id, lineDay, debit: line.debit!.toFixed(2),
      checkId: c.id, checkNumber: c.checkNumber, checkAmount: c.amount?.toFixed(2) ?? null, method: 'MANUAL',
      alreadyCleared: c.clearingStatus === 'CLEARED', previousKind: line.kind,
    }, remarks, c.id)
  })
}

export async function matchLineToEntry(db: Db, input: { lineId: string; bookEntryId: string; remarks: string; actor: ReconActor }) {
  const remarks = req(input.remarks)
  if (!remarks) fail('REMARKS_REQUIRED', 'A manual match needs a remark saying why.')
  return inTx(db, async (tx) => {
    const { line, period } = await editableLine(tx, input.lineId)
    const e = await tx.reconBookEntry.findUnique({ where: { id: input.bookEntryId }, include: { matchedLine: true } })
    if (!e || e.accountKey !== period.accountKey) return fail('NOT_FOUND', 'That book entry is not on this account.')
    if (e.matchedLine && e.matchedLine.id !== line.id) fail('ALREADY_MATCHED', 'That book entry is already matched to another line.')
    if ((e.kind === 'DEPOSIT') !== Boolean(line.credit)) fail('DIRECTION', 'A deposit matches a credit line; a disbursement matches a debit line.')
    if (e.entryDate > line.lineDate) fail('BEFORE_ENTRY', 'The bank cannot show an entry before the books record it.')
    await tx.reconStatementLine.update({ where: { id: line.id }, data: { kind: 'BOOK_ENTRY', matchMethod: 'MANUAL', bookEntryId: e.id, checkId: null, remarks } })
    await audit(tx, input.actor, 'recon_line_matched', {
      periodId: period.id, accountKey: period.accountKey, lineId: line.id, bookEntryId: e.id, reference: e.reference,
      entryAmount: e.amount.toFixed(2), lineAmount: (line.debit ?? line.credit)!.toFixed(2), method: 'MANUAL', previousKind: line.kind,
    }, remarks)
  })
}

export async function classifyLine(db: Db, input: { lineId: string; kind: LineKind; remarks: string; actor: ReconActor }) {
  const remarks = req(input.remarks)
  if (!remarks) fail('REMARKS_REQUIRED', 'Classifying a line by hand needs a remark.')
  return inTx(db, async (tx) => {
    const { line, period } = await editableLine(tx, input.lineId)
    const allowed = classificationsFor(line.debit ? 'DEBIT' : 'CREDIT')
    if (!allowed.includes(input.kind)) fail('BAD_KIND', `A ${line.debit ? 'debit' : 'credit'} line is one of: ${allowed.join(', ')}.`)
    await tx.reconStatementLine.update({ where: { id: line.id }, data: { kind: input.kind, matchMethod: 'MANUAL', bookEntryId: null, remarks } })
    await audit(tx, input.actor, 'recon_line_classified', { periodId: period.id, accountKey: period.accountKey, lineId: line.id, from: line.kind, to: input.kind }, remarks)
  })
}

// ─── 6. the ladder ────────────────────────────────────────────────────────

const ACTION_AUDIT: Record<WorkflowAction, string> = {
  SUBMIT: 'recon_submitted', REVIEW: 'recon_reviewed', RETURN: 'recon_returned', APPROVE: 'recon_approved', CLOSE: 'recon_closed',
}

/**
 * Move a month along DRAFT → FOR REVIEW → FOR APPROVAL → RECONCILED → CLOSED
 * (or RETURN it to DRAFT, note required). APPROVE recomputes inside the
 * transaction, freezes the figures and the full computation into the period,
 * and opens the next month carried forward — or, when the next month is
 * already open in DRAFT (this one was re-opened), re-carries its beginning.
 */
export async function transitionPeriod(db: PrismaClient, input: { periodId: string; action: WorkflowAction; note?: string; actor: ReconActor; now: Date; todayManila: string }) {
  const note = req(input.note)
  if (input.action === 'RETURN' && !note) fail('NOTE_REQUIRED', 'Say why it is returned to draft.')
  return db.$transaction(async (tx) => {
    const p = await tx.reconPeriod.findUnique({ where: { id: input.periodId } })
    if (!p) return fail('NO_PERIOD', 'That reconciliation does not exist.')
    const prev = p.previousPeriodId ? await tx.reconPeriod.findUnique({ where: { id: p.previousPeriodId } }) : null
    const { computation, otherCurrency } = await computeLive(tx, p)
    const verdict = workflowVerdict(input.action, {
      status: p.status as ReconStatus, submittedById: p.submittedById, reviewedById: p.reviewedById,
      statementEndingBalance: p.statementEndingBalance?.toFixed(2) ?? null, difference: computation.figures.difference,
      previousApproved: prev === null || isApproved(prev.status as ReconStatus),
      previousClosed: prev === null || prev.status === 'CLOSED',
    }, input.actor)
    if (!verdict.ok) return fail(verdict.code, verdict.message)

    const stamp = (() => {
      switch (input.action) {
        case 'SUBMIT': return { submittedById: input.actor.id, submittedAt: input.now, reviewedById: null, reviewedAt: null }
        case 'REVIEW': return { reviewedById: input.actor.id, reviewedAt: input.now }
        case 'RETURN': return { reviewedById: null, reviewedAt: null }
        case 'APPROVE': {
          const snapshot: ReconSnapshot = { version: 1, computation, otherCurrency, frozenAt: input.now.toISOString() }
          return { approvedById: input.actor.id, approvedAt: input.now, ...frozenColumns(computation), snapshot: snapshot as unknown as Prisma.InputJsonValue }
        }
        case 'CLOSE': return { closedById: input.actor.id, closedAt: input.now }
      }
    })()
    const moved = await tx.reconPeriod.updateMany({ where: { id: p.id, status: p.status }, data: { status: verdict.to, ...stamp } })
    if (moved.count !== 1) return fail('CHANGED', 'Someone else moved this reconciliation just now. Reload and try again.')
    const f = computation.figures
    await audit(tx, input.actor, ACTION_AUDIT[input.action], {
      periodId: p.id, accountKey: p.accountKey, month: monthOf(p.periodStart), from: p.status, to: verdict.to,
      ...(input.action === 'APPROVE' || input.action === 'SUBMIT'
        ? { figures: { endingBank: f.endingBank, endingBook: f.endingBook, adjustedBank: f.adjustedBank, adjustedBook: f.adjustedBook, difference: f.difference, outstandingChecks: f.totalOutstandingChecks, depositsInTransit: f.depositsInTransit } }
        : {}),
    }, note || undefined)

    if (input.action === 'APPROVE') {
      const account = await accountOrFail(tx, p.accountKey)
      const approved = await tx.reconPeriod.findUniqueOrThrow({ where: { id: p.id } })
      const next = await tx.reconPeriod.findUnique({ where: { previousPeriodId: p.id } })
      if (next) {
        if (next.status === 'DRAFT' && (next.beginningBankBalance.toFixed(2) !== f.endingBank || next.beginningBookBalance.toFixed(2) !== f.endingBook)) {
          await tx.reconPeriod.update({ where: { id: next.id }, data: { beginningBankBalance: f.endingBank, beginningBookBalance: f.endingBook } })
          await audit(tx, input.actor, 'recon_beginning_recarried', {
            periodId: next.id, accountKey: next.accountKey, previousPeriodId: p.id, automatic: true,
            before: { beginningBank: next.beginningBankBalance.toFixed(2), beginningBook: next.beginningBookBalance.toFixed(2) },
            after: { beginningBank: f.endingBank, beginningBook: f.endingBook },
          })
        }
      } else if (monthHasBegun(nextMonth(monthOf(p.periodStart)), input.todayManila)) {
        await carryForward(tx, approved, account, input.actor, input.todayManila)
      }
    }
    return verdict.to
  }, TX)
}

// ─── 7. re-opening an approved month (maker–checker) ───────────────────────

export async function requestReopen(db: Db, input: { periodId: string; reason: string; actor: ReconActor; now: Date }) {
  return inTx(db, async (tx) => {
    const p = await tx.reconPeriod.findUnique({ where: { id: input.periodId }, include: { nextPeriod: true, reopenRequests: { where: { status: 'PENDING' } } } })
    if (!p) return fail('NO_PERIOD', 'That reconciliation does not exist.')
    const v = reopenRequestVerdict({ status: p.status as ReconStatus, nextStatus: (p.nextPeriod?.status as ReconStatus | undefined) ?? null, hasPendingRequest: p.reopenRequests.length > 0 }, input.actor, input.reason)
    if (!v.ok) return fail(v.code, v.message)
    const r = await tx.reconReopenRequest.create({ data: { periodId: p.id, pendingKey: 'PENDING', reason: req(input.reason), requestedById: input.actor.id, requestedAt: input.now } })
    await audit(tx, input.actor, 'recon_reopen_requested', { periodId: p.id, accountKey: p.accountKey, requestId: r.id, status: p.status }, req(input.reason))
    return r
  })
}

/**
 * APPROVE returns the month to DRAFT; its frozen figures stay on the row (and
 * in the audit trail) until it is approved again, which re-freezes them and
 * re-carries a DRAFT next month. Refused if the next month moved meanwhile.
 */
export async function decideReopen(db: Db, input: { requestId: string; decision: 'APPROVE' | 'REJECT'; note: string; actor: ReconActor; now: Date }) {
  return inTx(db, async (tx) => {
    const r = await tx.reconReopenRequest.findUnique({ where: { id: input.requestId }, include: { period: { include: { nextPeriod: true } } } })
    if (!r) return fail('NOT_FOUND', 'That request does not exist.')
    const v = reopenDecisionVerdict(r, input.actor, input.decision, input.note)
    if (!v.ok) return fail(v.code, v.message)
    const decided = await tx.reconReopenRequest.updateMany({
      where: { id: r.id, status: 'PENDING' },
      data: { status: input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', pendingKey: null, decidedById: input.actor.id, decidedAt: input.now, decisionNote: req(input.note) || null },
    })
    if (decided.count !== 1) fail('CHANGED', 'This request was decided just now by someone else.')
    if (input.decision === 'APPROVE') {
      const p = r.period
      if (!isApproved(p.status as ReconStatus)) fail('NOT_APPROVED', 'The month is no longer RECONCILED or CLOSED.')
      if (p.nextPeriod && p.nextPeriod.status !== 'DRAFT') fail('NEXT_MONTH_MOVED', 'The following month has moved past DRAFT since the request. Re-open it first.')
      const moved = await tx.reconPeriod.updateMany({
        where: { id: p.id, status: p.status },
        data: { status: 'DRAFT', reopenCount: { increment: 1 }, submittedById: null, submittedAt: null, reviewedById: null, reviewedAt: null, approvedById: null, approvedAt: null, closedById: null, closedAt: null },
      })
      if (moved.count !== 1) fail('CHANGED', 'The month changed just now. Reload and try again.')
      await audit(tx, input.actor, 'recon_reopen_approved', {
        periodId: p.id, accountKey: p.accountKey, requestId: r.id, requestedById: r.requestedById, from: p.status, to: 'DRAFT',
        frozenBefore: {
          endingBank: p.endingBankBalance?.toFixed(2) ?? null, endingBook: p.endingBookBalance?.toFixed(2) ?? null,
          adjustedBank: p.adjustedBankBalance?.toFixed(2) ?? null, adjustedBook: p.adjustedBookBalance?.toFixed(2) ?? null,
          approvedById: p.approvedById, approvedAt: p.approvedAt?.toISOString() ?? null,
        },
      }, req(input.note) || r.reason)
    } else {
      await audit(tx, input.actor, 'recon_reopen_rejected', { periodId: r.periodId, accountKey: r.period.accountKey, requestId: r.id, requestedById: r.requestedById }, req(input.note))
    }
  })
}
