import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../../helpers/db'
import { makeUser } from '../../helpers/factory'
import {
  establishBeginningBalance, correctBeginningBalance, openNextPeriod, setStatementBalances, addBookEntry,
  planStatementUpload, applyStatementUpload, transitionPeriod, requestReopen, decideReopen, matchLineToCheck,
  classifyLine, addAdjustment, removeStatementUpload, recarryBeginning,
} from '@/lib/recon/monthly/actions'
import { loadPeriodView, listDashboard, loadPeriodHistory } from '@/lib/recon/monthly/query'
import { csvRows } from '@/lib/recon/monthly/statement'
import type { ReconActor } from '@/lib/recon/monthly/period'

beforeEach(resetDb)

const day = (s: string) => new Date(`${s}T00:00:00.000Z`)
const now = new Date('2026-11-09T02:00:00.000Z')
const TODAY = '2026-11-09'
const actor = (u: { id: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' }): ReconActor => ({ id: u.id, role: u.role })

async function setup() {
  const [preparer, reviewer, admin, admin2] = await Promise.all([makeUser(), makeUser(), makeUser('FINANCE_ADMIN'), makeUser('FINANCE_ADMIN')])
  const company = await testDb.company.create({ data: { code: 'STK', name: 'Starkson', legalNames: [] } })
  const bank = await testDb.bank.create({ data: { code: 'BPI', name: 'BPI' } })
  const book = await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: bank.id, companyId: company.id } })
  const other = await testDb.checkBook.create({ data: { code: 'BPI-S-8879', bankId: bank.id, companyId: company.id } })
  const mk = (checkNumber: string, amount: string, checkDate: string, extra: object = {}) => testDb.check.create({
    data: {
      companyId: company.id, checkBookId: book.id, checkNumber, apvNumbers: [], checkDate: day(checkDate), amount, currency: 'PHP',
      payeeName: 'HENKEL PHILIPPINES INC.', eligibility: 'SUPPLIER', status: 'RELEASED', isCheque: true, ...extra,
    },
  })
  return { preparer, reviewer, admin, admin2, company, bank, book, other, mk }
}

const statement = (rows: string[][]) => [{ name: 'stmt.csv', rows: csvRows(rows.map((r) => r.join(',')).join('\n')) }]

describe('monthly reconciliation — a month from beginning balance to carry-forward', () => {
  it('establishes, matches a statement, approves with separation of duties, freezes and carries forward', async () => {
    const s = await setup()
    const c1 = await s.mk('6000000001', '3000.00', '2026-10-05')
    const c2 = await s.mk('6000000002', '2000.00', '2026-10-06')
    await s.mk('6000000003', '700.00', '2026-09-20') // released before the beginning balance date, still outstanding

    await expect(establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '10000', bookBalance: '9300', reference: 'BPI SOA SEP 2026', actor: actor(s.preparer) }))
      .rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    await expect(establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-02', bankBalance: '10000', bookBalance: '9300', reference: 'x', actor: actor(s.admin) }))
      .rejects.toMatchObject({ code: 'NOT_MONTH_START' })
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '10,000.00', bookBalance: '9300', reference: 'BPI SOA SEP 2026', actor: actor(s.admin) })
    await expect(establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '1', bookBalance: '1', reference: 'x', actor: actor(s.admin) }))
      .rejects.toMatchObject({ code: 'ALREADY_ESTABLISHED' })

    const oct = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    expect(oct).toMatchObject({ beginningSource: 'OPENING', status: 'DRAFT' })
    expect(oct.beginningBankBalance.toFixed(2)).toBe('10000.00')

    await addBookEntry(testDb, { periodId: oct.id, kind: 'DEPOSIT', entryDate: '2026-10-03', amount: '4000', reference: 'DS-1', actor: actor(s.preparer) })
    await addBookEntry(testDb, { periodId: oct.id, kind: 'DEPOSIT', entryDate: '2026-10-31', amount: '500', reference: 'DS-2', actor: actor(s.preparer) })
    await expect(addBookEntry(testDb, { periodId: oct.id, kind: 'DEPOSIT', entryDate: '2026-11-01', amount: '1', reference: 'x', actor: actor(s.preparer) }))
      .rejects.toMatchObject({ code: 'OUTSIDE_MONTH' })

    const sheets = statement([
      ['Date', 'Description', 'Check No', 'Debit', 'Credit', 'Balance'],
      ['10/01/2026', 'BEGINNING BALANCE', '', '', '', '10000.00'],
      ['10/04/2026', 'DEPOSIT', '', '', '4000.00', '14000.00'],
      ['10/12/2026', 'CHECK CLEARING', '6000000001', '3000.00', '', '11000.00'],
      ['10/31/2026', 'SERVICE CHARGE', '', '50.00', '', '10950.00'],
    ])
    const plan = await planStatementUpload(testDb, { periodId: oct.id, fileName: 'stmt.csv', sheets })
    expect(plan.lines.map((l) => l.proposal.kind)).toEqual(['BOOK_ENTRY', 'CHECK', 'BANK_CHARGE'])
    expect(plan.parsed.statementEnding).toBe('10950.00')
    expect(await testDb.reconStatementLine.count()).toBe(0) // the plan writes nothing

    const applied = await applyStatementUpload(testDb, { periodId: oct.id, fileName: 'stmt.csv', sheets, setBalances: true, actor: actor(s.preparer), now, deadline: new Date(Date.now() + 30_000) })
    expect(applied).toMatchObject({ inserted: 3, checksCleared: 1, balancesSet: true })
    const cleared = await testDb.check.findUniqueOrThrow({ where: { id: c1.id } })
    expect(cleared).toMatchObject({ clearingStatus: 'CLEARED', clearedDate: day('2026-10-12') })
    expect(await testDb.auditLog.count({ where: { action: 'clearing_recorded', checkId: c1.id } })).toBe(1)

    // The same file again: nothing new, nothing cleared twice.
    const again = await planStatementUpload(testDb, { periodId: oct.id, fileName: 'stmt.csv', sheets })
    expect(again).toMatchObject({ newLines: 0, duplicates: 3 })

    let view = (await loadPeriodView(testDb, oct.id))!
    // Bank: 10,950 + DIT 500 − OC (2,000 + 700) = 8,750. Book: 9,300 + 4,500 − 5,000 − 50 = 8,750.
    expect(view.computation.figures).toMatchObject({
      endingBank: '10950.00', depositsInTransit: '500.00', totalOutstandingChecks: '2700.00',
      totalChecksReleased: '5000.00', bankCharges: '50.00', adjustedBank: '8750.00', adjustedBook: '8750.00', difference: '0.00',
    })
    expect(view.computation.counts.outstandingBeforeOpening).toBe(1)

    await transitionPeriod(testDb, { periodId: oct.id, action: 'SUBMIT', actor: actor(s.preparer), now, todayManila: TODAY })
    await expect(transitionPeriod(testDb, { periodId: oct.id, action: 'REVIEW', actor: actor(s.preparer), now, todayManila: TODAY })).rejects.toMatchObject({ code: 'SAME_PERSON' })
    await expect(addBookEntry(testDb, { periodId: oct.id, kind: 'DEPOSIT', entryDate: '2026-10-05', amount: '1', reference: 'x', actor: actor(s.preparer) })).rejects.toMatchObject({ code: 'LOCKED' })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'REVIEW', actor: actor(s.reviewer), now, todayManila: TODAY })
    await expect(transitionPeriod(testDb, { periodId: oct.id, action: 'APPROVE', actor: actor(s.reviewer), now, todayManila: TODAY })).rejects.toMatchObject({ code: 'ADMIN_ONLY' })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'APPROVE', actor: actor(s.admin), now, todayManila: TODAY })

    const approved = await testDb.reconPeriod.findUniqueOrThrow({ where: { id: oct.id } })
    expect(approved.status).toBe('RECONCILED')
    expect(approved.endingBankBalance?.toFixed(2)).toBe('10950.00')
    expect(approved.endingBookBalance?.toFixed(2)).toBe('8750.00')
    expect(approved.totalOutstandingChecks?.toFixed(2)).toBe('2700.00')

    // November opened automatically, carried forward.
    const nov = await testDb.reconPeriod.findFirstOrThrow({ where: { previousPeriodId: oct.id } })
    expect(nov).toMatchObject({ beginningSource: 'CARRIED_FORWARD', status: 'DRAFT' })
    expect(nov.beginningBankBalance.toFixed(2)).toBe('10950.00')
    expect(nov.beginningBookBalance.toFixed(2)).toBe('8750.00')
    const novView = (await loadPeriodView(testDb, nov.id))!
    expect(novView.carry.mismatch).toBe(false)
    // Outstanding checks and the deposit in transit carried — not reset, not counted as released again.
    expect(novView.computation.outstanding.map((c) => c.checkNumber).sort()).toEqual(['6000000002', '6000000003'])
    expect(novView.computation.depositsInTransit.map((e) => e.reference)).toEqual(['DS-2'])
    expect(novView.computation.figures.totalChecksReleased).toBe('0.00')
    expect(novView.computation.figures.difference).toBe('0.00')

    // A back-dated clearing later cannot rewrite October: it is read from its snapshot, and the drift is shown.
    await testDb.check.update({ where: { id: c2.id }, data: { clearingStatus: 'CLEARED', clearedDate: day('2026-10-20') } })
    view = (await loadPeriodView(testDb, oct.id))!
    expect(view.frozen).toBe(true)
    expect(view.computation.figures.totalOutstandingChecks).toBe('2700.00')
    expect(view.liveDrift?.totalOutstandingChecks).toBe('700.00')

    // The beginning balance is now locked.
    await expect(correctBeginningBalance(testDb, { accountKey: s.book.id, bankBalance: '1', bookBalance: '1', reference: 'r', reason: 'x', actor: actor(s.admin) }))
      .rejects.toMatchObject({ code: 'FIRST_PERIOD_LOCKED' })

    // Close, then re-open with a second admin's approval.
    await transitionPeriod(testDb, { periodId: oct.id, action: 'CLOSE', actor: actor(s.admin), now, todayManila: TODAY })
    const r = await requestReopen(testDb, { periodId: oct.id, reason: 'deposit slip DS-2 was October 30', actor: actor(s.admin), now })
    await expect(requestReopen(testDb, { periodId: oct.id, reason: 'again', actor: actor(s.admin2), now })).rejects.toMatchObject({ code: 'ALREADY_REQUESTED' })
    await expect(decideReopen(testDb, { requestId: r.id, decision: 'APPROVE', note: '', actor: actor(s.admin), now })).rejects.toMatchObject({ code: 'SAME_PERSON' })
    await decideReopen(testDb, { requestId: r.id, decision: 'APPROVE', note: 'ok', actor: actor(s.admin2), now })
    expect((await testDb.reconPeriod.findUniqueOrThrow({ where: { id: oct.id } })).status).toBe('DRAFT')
    expect((await loadPeriodView(testDb, nov.id))!.carry.previousReopened).toBe(true)

    const history = (await loadPeriodHistory(testDb, oct.id)).map((h) => h.action)
    expect(history).toEqual(expect.arrayContaining([
      'recon_period_started', 'recon_book_entry_added', 'recon_statement_uploaded', 'recon_submitted', 'recon_reviewed',
      'recon_approved', 'recon_closed', 'recon_reopen_requested', 'recon_reopen_approved',
    ]))
  })

  it('refuses to re-open a month whose next month has moved past draft', async () => {
    const s = await setup()
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-09-01', bankBalance: '0', bookBalance: '0', reference: 'r', actor: actor(s.admin) })
    const sep = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    await setStatementBalances(testDb, { periodId: sep.id, statementEnding: '0', statementBeginning: '', actor: actor(s.preparer) })
    for (const [a, who] of [['SUBMIT', s.preparer], ['REVIEW', s.reviewer], ['APPROVE', s.admin]] as const) {
      await transitionPeriod(testDb, { periodId: sep.id, action: a, actor: actor(who), now, todayManila: TODAY })
    }
    const oct = await testDb.reconPeriod.findFirstOrThrow({ where: { previousPeriodId: sep.id } })
    await setStatementBalances(testDb, { periodId: oct.id, statementEnding: '0', statementBeginning: '', actor: actor(s.preparer) })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'SUBMIT', actor: actor(s.preparer), now, todayManila: TODAY })
    await expect(requestReopen(testDb, { periodId: sep.id, reason: 'x', actor: actor(s.admin), now })).rejects.toMatchObject({ code: 'NEXT_MONTH_MOVED' })
  })

  it('refuses approval while the balances differ, and approval out of order', async () => {
    const s = await setup()
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '100', bookBalance: '100', reference: 'r', actor: actor(s.admin) })
    const oct = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    await setStatementBalances(testDb, { periodId: oct.id, statementEnding: '90', statementBeginning: '', actor: actor(s.preparer) })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'SUBMIT', actor: actor(s.preparer), now, todayManila: TODAY })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'REVIEW', actor: actor(s.reviewer), now, todayManila: TODAY })
    await expect(transitionPeriod(testDb, { periodId: oct.id, action: 'APPROVE', actor: actor(s.admin), now, todayManila: TODAY })).rejects.toMatchObject({ code: 'NOT_BALANCED' })
    await expect(transitionPeriod(testDb, { periodId: oct.id, action: 'RETURN', actor: actor(s.admin), now, todayManila: TODAY })).rejects.toMatchObject({ code: 'NOTE_REQUIRED' })
    await transitionPeriod(testDb, { periodId: oct.id, action: 'RETURN', note: 'bank charge missing', actor: actor(s.admin), now, todayManila: TODAY })
    await addAdjustment(testDb, { periodId: oct.id, side: 'BOOK', direction: 'LESS', amount: '10', description: 'SC not on statement upload', actor: actor(s.preparer) })
    expect((await loadPeriodView(testDb, oct.id))!.computation.figures.difference).toBe('0.00')
  })

  it('manual match needs a remark and clears the check; classification is restricted by direction; a cleared line is final', async () => {
    const s = await setup()
    const c = await s.mk('6000000009', '1500.00', '2026-10-02')
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '0', bookBalance: '0', reference: 'r', actor: actor(s.admin) })
    const oct = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    const sheets = statement([['Date', 'Particulars', 'Debit', 'Credit'], ['2026-10-15', 'ENCASHMENT REF 77', '1500.00', ''], ['2026-10-16', 'XFER', '', '9.00']])
    await applyStatementUpload(testDb, { periodId: oct.id, fileName: 'a.csv', sheets, setBalances: false, actor: actor(s.preparer), now, deadline: new Date(Date.now() + 30_000) })
    const [debit, credit] = await testDb.reconStatementLine.findMany({ orderBy: { lineDate: 'asc' } })
    expect(debit.kind).toBe('UNIDENTIFIED_DEBIT')
    await expect(matchLineToCheck(testDb, { lineId: debit.id, checkNumber: '6000000009', remarks: ' ', actor: actor(s.preparer), now })).rejects.toMatchObject({ code: 'REMARKS_REQUIRED' })
    await expect(matchLineToCheck(testDb, { lineId: debit.id, checkNumber: '123456', remarks: 'x', actor: actor(s.preparer), now })).rejects.toMatchObject({ code: 'NOT_IN_ACCOUNT' })
    await matchLineToCheck(testDb, { lineId: debit.id, checkNumber: '006000000009', remarks: 'bank printed no check number; amount and payee agree', actor: actor(s.preparer), now })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ clearingStatus: 'CLEARED', clearedDate: day('2026-10-15') })
    expect(await testDb.reconStatementLine.findUniqueOrThrow({ where: { id: debit.id } })).toMatchObject({ kind: 'CHECK', matchMethod: 'MANUAL' })
    await expect(classifyLine(testDb, { lineId: debit.id, kind: 'BANK_CHARGE', remarks: 'x', actor: actor(s.preparer) })).rejects.toMatchObject({ code: 'CHECK_MATCHED' })
    await expect(classifyLine(testDb, { lineId: credit.id, kind: 'BANK_CHARGE', remarks: 'x', actor: actor(s.preparer) })).rejects.toMatchObject({ code: 'BAD_KIND' })
    await classifyLine(testDb, { lineId: credit.id, kind: 'BANK_CREDIT', remarks: 'interest credited as XFER', actor: actor(s.preparer) })

    // Removing the file takes the credit back out but keeps the cleared-check line.
    expect(await removeStatementUpload(testDb, { periodId: oct.id, sourceFile: 'a.csv', reason: 'wrong file', actor: actor(s.preparer) })).toEqual({ removed: 1, kept: 1 })
  })

  it('refuses a statement line already uploaded under another month of the same account', async () => {
    const s = await setup()
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '0', bookBalance: '0', reference: 'r', actor: actor(s.admin) })
    const oct = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    const sheets = statement([['Date', 'Description', 'Amount'], ['2026-10-15', 'SC', '-5.00']])
    await applyStatementUpload(testDb, { periodId: oct.id, fileName: 'a.csv', sheets, setBalances: false, actor: actor(s.preparer), now, deadline: new Date(Date.now() + 30_000) })
    await applyStatementUpload(testDb, { periodId: oct.id, fileName: 'a-copy.csv', sheets, setBalances: false, actor: actor(s.preparer), now, deadline: new Date(Date.now() + 30_000) })
    expect(await testDb.reconStatementLine.count()).toBe(1)
  })

  it('re-carries a draft month when the month before is re-approved with other figures', async () => {
    const s = await setup()
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-09-01', bankBalance: '100', bookBalance: '100', reference: 'r', actor: actor(s.admin) })
    const sep = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    const approve = async (id: string) => {
      await transitionPeriod(testDb, { periodId: id, action: 'SUBMIT', actor: actor(s.preparer), now, todayManila: TODAY })
      await transitionPeriod(testDb, { periodId: id, action: 'REVIEW', actor: actor(s.reviewer), now, todayManila: TODAY })
      await transitionPeriod(testDb, { periodId: id, action: 'APPROVE', actor: actor(s.admin), now, todayManila: TODAY })
    }
    await setStatementBalances(testDb, { periodId: sep.id, statementEnding: '100', statementBeginning: '', actor: actor(s.preparer) })
    await approve(sep.id)
    const oct = await testDb.reconPeriod.findFirstOrThrow({ where: { previousPeriodId: sep.id } })
    const r = await requestReopen(testDb, { periodId: sep.id, reason: 'interest missed', actor: actor(s.admin), now })
    await decideReopen(testDb, { requestId: r.id, decision: 'APPROVE', note: '', actor: actor(s.admin2), now })
    await expect(recarryBeginning(testDb, { periodId: oct.id, actor: actor(s.preparer) })).rejects.toMatchObject({ code: 'PREVIOUS_OPEN' })
    await setStatementBalances(testDb, { periodId: sep.id, statementEnding: '101', statementBeginning: '', actor: actor(s.preparer) })
    await addAdjustment(testDb, { periodId: sep.id, side: 'BOOK', direction: 'ADD', amount: '1', description: 'interest', actor: actor(s.preparer) })
    await approve(sep.id)
    const after = await testDb.reconPeriod.findUniqueOrThrow({ where: { id: oct.id } })
    expect(after.beginningBankBalance.toFixed(2)).toBe('101.00')
    expect(after.beginningBookBalance.toFixed(2)).toBe('101.00')
    expect(await testDb.auditLog.count({ where: { action: 'recon_beginning_recarried' } })).toBe(1)
  })

  it('lists the dashboard: the current month per account, an unstarted account, and the next month to open', async () => {
    const s = await setup()
    await establishBeginningBalance(testDb, { accountKey: s.book.id, effectiveDate: '2026-10-01', bankBalance: '5', bookBalance: '5', reference: 'r', actor: actor(s.admin) })
    await establishBeginningBalance(testDb, { accountKey: s.other.id, effectiveDate: '2026-11-01', bankBalance: '7', bookBalance: '7', reference: 'r', actor: actor(s.admin) })
    const oct = await openNextPeriod(testDb, { accountKey: s.book.id, actor: actor(s.preparer), todayManila: TODAY })
    let rows = await listDashboard(testDb, {}, TODAY)
    expect(rows.map((r) => [r.account.code, r.month, r.status])).toEqual([['BPI-S-4636', '2026-10', 'DRAFT'], ['BPI-S-8879', '2026-11', null]])
    expect(rows[0]).toMatchObject({ beginningBank: '5.00', difference: '0.00' })
    rows = await listDashboard(testDb, { status: 'RECONCILED' }, TODAY)
    expect(rows).toEqual([])
    rows = await listDashboard(testDb, { year: 2026, month: 10 }, TODAY)
    expect(rows.map((r) => r.periodId)).toEqual([oct.id])
  })
})
