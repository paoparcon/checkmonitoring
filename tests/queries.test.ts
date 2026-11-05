import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from './helpers/db'
import { makeCheck } from './helpers/factory'
import {
  getSummary, getTodaysRelease, listTodaysReleaseIds, getPendingSignature, listPendingSignatureIds, listChecks, countChecks, toTableRow, getFilterOptions,
  parseStatusParam, parseEligibilityParam, parseOptionId, columnFilterFields, likePattern,
} from '@/lib/queries'
import { manilaDayStart, manilaDayEnd, manilaToday } from '@/lib/manila-day'
import { formatMoney } from '@/lib/money'
import { generatedWhere } from '@/lib/queries'
import { LIVE_STATUSES, isLiveStatus } from '@/lib/domain/check-status'
import type { SortKey } from '@/lib/list-sort'

beforeEach(resetDb)

describe('getSummary', () => {
  it('counts each status and totals by currency for non-cancelled checks', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'SCHEDULED' })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'CANCELLED' })

    const s = await getSummary(testDb)
    expect(s.pendingSignature).toBe(1)
    expect(s.signed).toBe(1)
    expect(s.readyForRelease).toBe(1)
    expect(s.scheduled).toBe(1)
    expect(s.released).toBe(1)
    expect(s.total).toBe(6)
    // 5 non-cancelled checks (the CANCELLED one excluded) at 197715.42 each, all PHP.
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '988577.1', count: 5 }])
  })

  it('counts CLEARED apart from RELEASED, and STALED, and lists each view exactly (2026-11-05)', async () => {
    await makeCheck({ status: 'RELEASED' })
    const cleared = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: cleared.id }, data: { clearingStatus: 'CLEARED' } })
    const deposited = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: deposited.id }, data: { clearingStatus: 'DEPOSITED' } })
    const stale = await makeCheck({ status: 'CANCELLED' })
    await testDb.check.update({ where: { id: stale.id }, data: { isStale: true } })
    await makeCheck({ status: 'CANCELLED' })

    const s = await getSummary(testDb)
    // DEPOSITED is not cleared: the bank has not paid it yet.
    expect(s.released).toBe(2)
    expect(s.cleared).toBe(1)
    expect(s.cancelled).toBe(2)
    expect(s.stale).toBe(1)

    expect((await listChecks(testDb, { displayStatusIn: ['CLEARED'] })).map((c) => c.id)).toEqual([cleared.id])
    expect(await countChecks(testDb, { displayStatusIn: ['RELEASED'] })).toBe(2)
    expect(await countChecks(testDb, { displayStatusIn: ['RELEASED', 'CLEARED'] })).toBe(3)
    expect((await listChecks(testDb, { stale: true })).map((c) => c.id)).toEqual([stale.id])
    // The STATUS column says CLEARED; the stored status stays RELEASED.
    const row = toTableRow((await listChecks(testDb, { displayStatusIn: ['CLEARED'] }))[0])
    expect(row.status).toBe('RELEASED')
    expect(row.shownStatus).toBe('CLEARED')
  })

  /**
   * The PENDING SIGNATURE card folds GENERATED in; the release timeline shows
   * the two rungs separately, because a timeline node's count has to be the
   * number of rows its link opens and `?status=SIGNATURE_PENDING` opens only
   * the SIGNATURE_PENDING rows.
   *
   * Both readings come from the SAME grouping, so they cannot drift: this pins
   * that the split adds back up to the card.
   */
  it('reports the two pending rungs separately as well as folded into the card', async () => {
    await makeCheck({ status: 'GENERATED' })
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNATURE_PENDING' })

    // Two days on, so the cheques made just now are not "generated today":
    // only the one literally at GENERATED counts.
    const s = await getSummary(testDb, {}, new Date(Date.now() + 2 * 86_400_000))
    expect(s.generated).toBe(1)
    expect(s.signaturePending).toBe(2)
    expect(s.pendingSignature).toBe(3)
  })

  it('counts a SIGNATURE_PENDING check created today as generated today (Manila day), and opens the same set', async () => {
    await makeCheck({ status: 'GENERATED' })
    const fresh = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const old = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await testDb.check.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 3 * 86_400_000) } })

    const now = new Date()
    const s = await getSummary(testDb, {}, now)
    expect(s.generated).toBe(2)
    const rows = await testDb.check.findMany({ where: { AND: [generatedWhere(manilaDayStart(manilaToday(now)))] } })
    expect(rows.map((r) => r.id)).toContain(fresh.id)
    expect(rows.map((r) => r.id)).not.toContain(old.id)
    expect(rows).toHaveLength(2)
  })

  it('counts CANCELLED and VOIDED even when they have no amount', async () => {
    await makeCheck({ status: 'CANCELLED', amount: null })
    await makeCheck({ status: 'VOIDED', amount: null })
    const s = await getSummary(testDb)
    expect(s.cancelled).toBe(1)
    expect(s.voided).toBe(1)
  })

  // The whole point of this step: a dataset spanning multiple currencies must
  // never collapse into one number. Two currencies in means two totals out.
  it('never adds two different currencies together', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: '500.50' })
    await makeCheck({ currency: 'CNY', amount: '2000.25' })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toHaveLength(2)
    expect(s.totalsByCurrency).toEqual(expect.arrayContaining([
      { currency: 'PHP', total: '1500.5', count: 2 },
      { currency: 'CNY', total: '2000.25', count: 1 },
    ]))
  })

  it('excludes CANCELLED checks from every currency total', async () => {
    await makeCheck({ currency: 'CNY', amount: '999.00', status: 'CANCELLED' })
    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([])
  })

  // 397 register rows carry no amount. This pins the behaviour the dashboard
  // depends on: SQL SUM() skips NULL rather than reading it as 0, so the total
  // is the sum of the amounts that are actually known - while COUNT(*) still
  // counts the cheque, because it exists and Finance must be able to see it.
  //
  // A total of 1,500.50 over a count of 3 therefore does NOT mean the three
  // amounts add to 1,500.50. That is deliberate: the alternative is a total
  // that silently absorbs 397 unknowns as zeroes and looks authoritative.
  //
  // `s.total` is the exception, and it changed on 2026-09-06: it is the TOTAL
  // CHECKS card, which links to a table that no longer lists the cheques with no
  // amount, so it counts 2 of these 3. The currency block above is untouched -
  // see the note in getSummary for why the two answer different questions.
  it('leaves a check with no recorded amount out of the total but still counts it', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: '500.50' })
    await makeCheck({ currency: 'PHP', amount: null })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1500.5', count: 3 }])
    expect(s.total).toBe(2)
    expect(s.incomplete).toBe(1)
  })

  // The degenerate case: every cheque in a currency has an unknown amount, so
  // Postgres returns SUM() = NULL for the whole group.
  //
  // The total is carried through as null, NOT collapsed to zero. "No amount is
  // known for any of these cheques" and "these cheques are worth nothing" are
  // different facts, and a figure reading ₱0.00 while meaning the first is a
  // lie the reader has no way to detect. `formatMoney` renders null as an em
  // dash, so the card shows a dash rather than a confident zero.
  //
  // The row must still appear with its count — dropping it would hide the
  // cheques entirely.
  it('reports a currency whose every amount is unknown with no total, not a zero', async () => {
    await makeCheck({ currency: 'USD', amount: null })
    await makeCheck({ currency: 'USD', amount: null })

    const s = await getSummary(testDb)
    expect(s.totalsByCurrency).toEqual([{ currency: 'USD', total: null, count: 2 }])
    expect(formatMoney(s.totalsByCurrency[0].total, 'USD')).toBe('—')
  })
})

/**
 * Client request 2026-09-29: "should have filter in every summary". The TOTALS
 * screen's company, bank and eligibility dropdowns narrow every card, so the
 * summary takes the same three filters the table reads — and applies them to
 * ALL of its figures, the disclosure count included, so no card can report the
 * whole company while the one beside it reports the filtered set.
 */
describe('getSummary narrowed', () => {
  it('narrows every count, the value total and the disclosure to one company', async () => {
    const mine = await makeCheck({ status: 'SIGNED', amount: '100.00' })
    await makeCheck({ status: 'SIGNED', amount: '200.00' })
    await makeCheck({ status: 'RELEASED', amount: '400.00' })
    // A cheque with no amount, in the SAME company, so the disclosure has one to count.
    await testDb.check.create({
      data: {
        companyId: mine.companyId, cashAccountId: mine.cashAccountId,
        checkNumber: '6000000001', apvNumbers: [], checkDate: new Date('2026-09-01'),
        amount: null, isIncomplete: true, currency: 'PHP', payeeName: 'X',
        eligibility: 'SUPPLIER', status: 'SIGNATURE_PENDING', isCheque: true,
      },
    })

    const s = await getSummary(testDb, { companyId: mine.companyId })
    expect(s.signed).toBe(1)
    expect(s.released).toBe(0)
    expect(s.pendingSignature).toBe(0)
    expect(s.total).toBe(1)
    expect(s.incomplete).toBe(1)
    // The currency group is deliberately NOT narrowed by completeness (see the
    // note in getSummary): the no-amount cheque is counted, its null skipped.
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '100', count: 2 }])
  })

  it('narrows to one cash account', async () => {
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })

    const s = await getSummary(testDb, { cashAccountId: mine.cashAccountId! })
    expect(s.readyForRelease).toBe(1)
    expect(s.total).toBe(1)
  })

  it('narrows to one eligibility', async () => {
    await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })
    await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })

    const s = await getSummary(testDb, { eligibility: 'SUPPLIER' })
    expect(s.signed).toBe(2)
    expect(s.total).toBe(2)
  })

  it('is the whole database with no narrowing, exactly as before', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNED' })

    expect((await getSummary(testDb)).signed).toBe(2)
    expect((await getSummary(testDb, {})).signed).toBe(2)
  })
})

describe('listChecks', () => {
  it('finds a check by its number', async () => {
    await makeCheck({ checkNumber: '6000329924' })
    await makeCheck({ checkNumber: '1791379619' })
    const rows = await listChecks(testDb, { q: '6000329' })
    expect(rows).toHaveLength(1)
    expect(rows[0].checkNumber).toBe('6000329924')
  })

  it('finds a check by payee, case-insensitively', async () => {
    await makeCheck({})
    const rows = await listChecks(testDb, { q: 'henkel' })
    expect(rows).toHaveLength(1)
  })

  it('filters by status', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })
    const rows = await listChecks(testDb, { status: 'RELEASED' })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('RELEASED')
  })

  it('filters by eligibility so INTERNAL checks can be reviewed separately', async () => {
    await makeCheck({ eligibility: 'INTERNAL' })
    await makeCheck({ eligibility: 'SUPPLIER' })
    const rows = await listChecks(testDb, { eligibility: 'INTERNAL' })
    expect(rows).toHaveLength(1)
  })

  it('returns an empty list rather than throwing when nothing matches', async () => {
    expect(await listChecks(testDb, { q: 'no-such-check' })).toEqual([])
  })
})

// 129 of production's 9,247 cheques carry no amount, and until now nothing on
// any screen said so. `Check.isIncomplete` is the stored flag; these pin that
// it is counted, filterable, and — crucially — that flagging them changed
// nothing about the money.
describe('incomplete checks', () => {
  /**
   * SUPERSEDED BY A CLIENT DECISION, 2026-09-06. This used to assert
   * `s.total === 3` — every cheque, the two with no amount included. Shown the
   * INCOMPLETE card reading 129 the client said "ignore them mean you have to
   * remove them, dont consider them becuase they dont have amount", so the
   * dashboard's counts stop at the cheques that have one.
   *
   * `s.incomplete` is the figure that survives, because it is now the
   * DISCLOSURE: the page prints it above the table with a link that shows them,
   * which is what makes a register that got smaller readable rather than
   * alarming.
   */
  it('counts the checks flagged incomplete, and leaves them out of every other figure', async () => {
    await makeCheck({ amount: '1000.00' })
    await makeCheck({ amount: null })
    await makeCheck({ amount: null })

    const s = await getSummary(testDb)
    expect(s.incomplete).toBe(2)
    expect(s.total).toBe(1)
  })

  /**
   * The drift this whole change had to avoid: a card's number is the number of
   * rows the table it links to shows. `getSummary` narrows itself the same way
   * `buildWhere` narrows the table, so a status count and its table cannot part
   * company.
   */
  it('keeps each status count equal to the rows that status opens', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: '1000.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: null })
    await makeCheck({ status: 'SIGNED', amount: '2000.00' })
    await makeCheck({ status: 'SIGNED', amount: null })
    await makeCheck({ status: 'RELEASED', amount: null })

    const s = await getSummary(testDb)
    expect(s.pendingSignature).toBe(1)
    expect(s.signaturePending).toBe(1)
    expect(s.signed).toBe(1)
    expect(s.released).toBe(0)

    // The dashboard's own filters, as `resolveDashboardQuery` builds them.
    expect(await countChecks(testDb, { status: 'SIGNATURE_PENDING', incomplete: false }))
      .toBe(s.signaturePending)
    expect(await countChecks(testDb, { status: 'SIGNED', incomplete: false })).toBe(s.signed)
    expect(await countChecks(testDb, { status: 'RELEASED', incomplete: false })).toBe(s.released)
    expect(await countChecks(testDb, { incomplete: false })).toBe(s.total)
  })

  it('filters the table down to the incomplete records', async () => {
    await makeCheck({ amount: '1000.00', checkNumber: '6000000101' })
    await makeCheck({ amount: null, checkNumber: '6000000102' })

    const rows = await listChecks(testDb, { incomplete: true })
    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000102'])
  })

  /**
   * The tri-state, end to end. `false` is the dashboard's default and EXCLUDES;
   * `undefined` is still no filter at all, so a caller with no opinion about
   * incompleteness cannot acquire one by accident — `getTodaysRelease` and the
   * admin screens depend on that distinction staying real.
   */
  it('excludes the incomplete records for false, and filters on nothing for undefined', async () => {
    await makeCheck({ amount: '1000.00', checkNumber: '6000000201' })
    await makeCheck({ amount: null, checkNumber: '6000000202' })

    expect(await countChecks(testDb, {})).toBe(2)
    expect(await countChecks(testDb, { incomplete: true })).toBe(1)
    expect(await countChecks(testDb, { incomplete: false })).toBe(1)

    const shown = await listChecks(testDb, { incomplete: false })
    expect(shown.map((r) => r.checkNumber)).toEqual(['6000000201'])
  })

  // Hidden, never removed. Rule 10 forbids a bulk delete path, and 25 of
  // production's 129 are RELEASED cheques somebody has already handed over.
  it('hides them from the dashboard without touching the rows', async () => {
    await makeCheck({ amount: null, checkNumber: '6000000203', status: 'RELEASED' })

    expect(await countChecks(testDb, { incomplete: false, statusIn: undefined })).toBe(0)
    const still = await listChecks(testDb, { incomplete: true })
    expect(still).toHaveLength(1)
    expect(still[0].status).toBe('RELEASED')
    expect(still[0].amount).toBeNull()
  })

  // THE ONE THAT MUST NOT BE "FIXED". Flagging a cheque as incomplete does not
  // enrol it in any total: SQL SUM() skips a NULL amount, so the PHP total
  // below is 1,000.00 over a count of 2. A future reader who "corrects" this by
  // coalescing the null to zero would leave the figure looking identical while
  // meaning something else — a total that silently absorbs 129 unknowns as
  // zeroes and reads as authoritative. See getSummary for the full note.
  it('keeps an incomplete check out of the currency total while still counting it', async () => {
    await makeCheck({ currency: 'PHP', amount: '1000.00' })
    await makeCheck({ currency: 'PHP', amount: null })

    const s = await getSummary(testDb)
    expect(s.incomplete).toBe(1)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1000', count: 2 }])
  })
})

// The dashboard defaults to the cheques that still need Finance. Production
// holds 9,287 of which 7,433 are RELEASED and 531 CANCELLED, so a default of
// "everything" hides the ~400 that matter behind the row limit.
describe('statusIn (the dashboard scope)', () => {
  it('narrows to the live statuses and excludes the closed ones', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'READY_FOR_RELEASE' })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'CANCELLED' })

    const rows = await listChecks(testDb, { statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(2)
    expect(rows.every((r) => isLiveStatus(r.status))).toBe(true)
    expect(await countChecks(testDb, { statusIn: LIVE_STATUSES })).toBe(2)
  })

  it('lets an explicitly chosen status win, so RELEASED is still reachable', async () => {
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'RELEASED' })

    const rows = await listChecks(testDb, { status: 'RELEASED', statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('RELEASED')
  })

  it('treats an empty scope as no filter rather than as "match nothing"', async () => {
    await makeCheck({ status: 'RELEASED' })
    expect(await listChecks(testDb, { statusIn: [] })).toHaveLength(1)
  })

  it('narrows alongside the search rather than widening past it', async () => {
    await makeCheck({ status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ status: 'RELEASED', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ status: 'SIGNED', payeeName: 'OTHER SUPPLIER' })

    const rows = await listChecks(testDb, { q: 'henkel', statusIn: LIVE_STATUSES })

    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('SIGNED')
  })
})

// The table is a client component, and `Prisma.Decimal` cannot cross that
// boundary — React refuses to serialise a class instance. `toTableRow` is the
// conversion, and rule 8 decides its shape: the amount travels as a decimal
// string, never as a JS number.
describe('toTableRow', () => {
  it('carries the amount as a decimal string, not a number', async () => {
    await makeCheck({ amount: '197715.42' })
    const [row] = await listChecks(testDb, {})

    const table = toTableRow(row)

    expect(table.amount).toBe('197715.42')
    expect(typeof table.amount).toBe('string')
  })

  it('keeps a missing amount as null rather than zero', async () => {
    await makeCheck({ amount: null })
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).amount).toBeNull()
  })

  it('is JSON-serialisable, so it can be passed to a client component', async () => {
    await makeCheck({})
    const [row] = await listChecks(testDb, {})

    const table = toTableRow(row)

    // A Decimal survives JSON.stringify as a bare string and would pass a
    // shallow check; the property that matters is that nothing here is a class
    // instance. Every value is a primitive, a Date, or an array of strings.
    for (const value of Object.values(table)) {
      const plain = value === null
        || ['string', 'number', 'boolean'].includes(typeof value)
        || value instanceof Date
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(plain).toBe(true)
    }
  })

  it('lists every bill’s APV, not just the first', async () => {
    const check = await makeCheck({})
    await testDb.checkBill.createMany({
      data: [
        { checkId: check.id, apvNumber: 'APV-1', amount: '1.00' },
        { checkId: check.id, apvNumber: 'APV-2', amount: '2.00' },
      ],
    })
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).apvNumbers).toEqual(['APV-1', 'APV-2'])
  })

  it('shows the register’s vouchers as well as the approval workbook’s bills', async () => {
    // Two sources, one column. `Check.apvNumbers` is what the register states —
    // 11,552 of its 11,779 cheque numbers carry one — and `bills` is the
    // approval-for-release workbook's per-bill ledger, which covered 85 rows of
    // one day's list. Showing either alone leaves the column empty for almost
    // the whole register, which is the state that let a voucher go unnoticed.
    const check = await makeCheck({ apvNumbers: ['AP-ST042652', 'AP-ST042999'] })
    await testDb.checkBill.create({
      data: { checkId: check.id, apvNumber: 'AP-ST042652', amount: '1.00' },
    })
    const [row] = await listChecks(testDb, {})
    // Deduplicated: the two sources naming the same voucher is the normal case
    // for a cheque on the approval list, not a reason to print it twice.
    expect(toTableRow(row).apvNumbers).toEqual(['AP-ST042652', 'AP-ST042999'])
  })

  it('lists the bills’ PO numbers, deduplicated, sorted, without the null ones', async () => {
    const check = await makeCheck({})
    await testDb.checkBill.createMany({
      data: [
        { checkId: check.id, apvNumber: 'APV-1', amount: '1.00', poNumber: 'PO-2' },
        { checkId: check.id, apvNumber: 'APV-2', amount: '1.00', poNumber: 'PO-1' },
        { checkId: check.id, apvNumber: 'APV-3', amount: '1.00', poNumber: 'PO-2' },
        { checkId: check.id, apvNumber: 'APV-4', amount: '1.00', poNumber: null },
      ],
    })
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).poNumbers).toEqual(['PO-1', 'PO-2'])
  })

  it('gives no PO numbers for a check with no bills', async () => {
    await makeCheck({})
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).poNumbers).toEqual([])
  })

  it('finds a check by a PO number through the bills search', async () => {
    const check = await makeCheck({ checkNumber: '6000353106' })
    await testDb.checkBill.create({
      data: { checkId: check.id, apvNumber: 'APV-1', amount: '1.00', poNumber: 'PO-1' },
    })
    await makeCheck({ checkNumber: '6000353107' })
    const rows = await listChecks(testDb, { q: 'po-1' })
    expect(rows.map((r) => r.checkNumber)).toEqual(['6000353106'])
  })

  it('finds a check by a voucher the register states', async () => {
    // Whole voucher, not a substring: Postgres array containment is the only
    // filter available over a `text[]`. Worth knowing, and far better than the
    // column not being searchable at all.
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    await makeCheck({ checkNumber: '6000353107', apvNumbers: ['AP-ST042999'] })

    const rows = await listChecks(testDb, { q: 'AP-ST042652' })
    expect(rows.map((r) => r.checkNumber)).toEqual(['6000353106'])
    // Stored upper-cased by the parser, so a lower-cased search still finds it.
    expect((await listChecks(testDb, { q: 'ap-st042652' })).map((r) => r.checkNumber))
      .toEqual(['6000353106'])
  })

  it('carries the supplier receipt, and says whether one is recorded', async () => {
    const withReceipt = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: withReceipt.id }, data: { orNumber: 'OR-000123', receiptType: 'OR' } })
    await makeCheck({ status: 'RELEASED' })

    const rows = (await listChecks(testDb, { statusIn: ['RELEASED'] })).map(toTableRow)
    const a = rows.find((r) => r.id === withReceipt.id)!
    const b = rows.find((r) => r.id !== withReceipt.id)!

    expect(a).toMatchObject({ orNumber: 'OR-000123', receiptType: 'OR', hasReceipt: true })
    expect(b).toMatchObject({ orNumber: null, receiptType: null, hasReceipt: false })
  })
})

// Postgres sorts NULLs FIRST on a descending sort. `checkDate` is nullable —
// 38 live cheques carry no date — so the dashboard's default ordering opened on
// a screen of nothing but em dashes with every dated cheque pushed below them.
// The fix is `nulls: 'last'`, and this is what stops it coming back: a plain
// `{ checkDate: 'desc' }` fails the first test here.
describe('listChecks ordering', () => {
  it('puts a check with no date after every dated one, newest dated first', async () => {
    await makeCheck({ checkNumber: '6000000901', checkDate: null })
    await makeCheck({ checkNumber: '6000000902', checkDate: new Date('2026-01-15') })
    await makeCheck({ checkNumber: '6000000903', checkDate: new Date('2026-08-20') })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000903', '6000000902', '6000000901'])
  })

  it('still breaks a tie on the check number, ascending', async () => {
    await makeCheck({ checkNumber: '6000000905', checkDate: new Date('2026-03-01') })
    await makeCheck({ checkNumber: '6000000904', checkDate: new Date('2026-03-01') })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000904', '6000000905'])
  })

  it('orders a table made entirely of dateless checks rather than dropping them', async () => {
    await makeCheck({ checkNumber: '6000000907', checkDate: null })
    await makeCheck({ checkNumber: '6000000906', checkDate: null })

    const rows = await listChecks(testDb, {})

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000906', '6000000907'])
  })
})

// The BANK column. `Check.cashAccountId` -> `CashAccount` (the code Finance
// actually says out loud, "BPI STK") -> `Bank`. Both cross to the browser as
// plain strings: a Prisma model instance on `CheckTableRow` would throw at the
// server/client boundary, which has happened on this table before.
describe('toTableRow bank columns', () => {
  it('carries the cash account code and its bank code as plain strings', async () => {
    const check = await makeCheck({})
    const account = await testDb.cashAccount.findUniqueOrThrow({
      where: { id: check.cashAccountId! },
      include: { bank: true },
    })

    const [row] = await listChecks(testDb, {})
    const table = toTableRow(row)

    expect(table.cashAccountCode).toBe(account.code)
    expect(table.bankCode).toBe(account.bank.code)
    expect(typeof table.cashAccountCode).toBe('string')
    expect(typeof table.bankCode).toBe('string')
  })

  it('reports null, not an empty string, for a check with no cash account', async () => {
    const check = await makeCheck({})
    await testDb.check.update({ where: { id: check.id }, data: { cashAccountId: null } })

    const [row] = await listChecks(testDb, {})
    const table = toTableRow(row)

    expect(table.cashAccountCode).toBeNull()
    expect(table.bankCode).toBeNull()
  })

  it('stays JSON-serialisable with the bank columns on it', async () => {
    await makeCheck({})
    const [row] = await listChecks(testDb, {})

    for (const value of Object.values(toTableRow(row))) {
      const plain = value === null
        || ['string', 'number', 'boolean'].includes(typeof value)
        || value instanceof Date
        || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
      expect(plain).toBe(true)
    }
  })
})

// The dropdown options come from the database, so a new company or cash account
// appears on the filter bar without a code change.
describe('getFilterOptions', () => {
  it('lists every company and cash account, ordered by code', async () => {
    const bank = await testDb.bank.create({ data: { code: 'ZBPI', name: 'Bank of the Philippine Islands' } })
    const a = await testDb.company.create({ data: { code: 'ZSTK', name: 'Company A', legalNames: [] } })
    const b = await testDb.company.create({ data: { code: 'ZA1', name: 'Company B', legalNames: [] } })
    await testDb.cashAccount.create({ data: { code: 'ZBPI STK', bankId: bank.id, companyId: a.id } })
    await testDb.cashAccount.create({ data: { code: 'ZBPI A1', bankId: bank.id, companyId: b.id } })

    const options = await getFilterOptions(testDb)

    expect(options.companies.map((c) => c.code)).toEqual(['ZA1', 'ZSTK'])
    expect(options.cashAccounts.map((c) => c.code)).toEqual(['ZBPI A1', 'ZBPI STK'])
    expect(options.cashAccounts.every((c) => c.bankCode === 'ZBPI')).toBe(true)
  })

  it('returns empty lists rather than throwing on an empty database', async () => {
    expect(await getFilterOptions(testDb)).toEqual({ companies: [], cashAccounts: [] })
  })

  it('is JSON-serialisable, so the filter bar can be rendered from it', async () => {
    const bank = await testDb.bank.create({ data: { code: 'ZMBTC', name: 'Metrobank' } })
    const company = await testDb.company.create({ data: { code: 'ZPP', name: 'Company C', legalNames: [] } })
    await testDb.cashAccount.create({ data: { code: 'ZMBTC PP', bankId: bank.id, companyId: company.id } })

    const options = await getFilterOptions(testDb)

    for (const record of [...options.companies, ...options.cashAccounts]) {
      for (const value of Object.values(record)) {
        expect(typeof value).toBe('string')
      }
    }
  })
})

// Every URL parameter is validated before it reaches Prisma. An unrecognised
// value is not an error page and not a guess — it is IGNORED, exactly as
// `status` already behaved, because a stale bookmark must open the dashboard
// rather than 500 it.
describe('URL parameter validation', () => {
  it('accepts every status on the ladder, including the closed ones', () => {
    for (const s of ['GENERATED', 'SIGNATURE_PENDING', 'SIGNED', 'READY_FOR_RELEASE',
      'SCHEDULED', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(parseStatusParam(s)).toBe(s)
    }
  })

  it('ignores an unrecognised, empty or absent status rather than passing it to Prisma', () => {
    expect(parseStatusParam('DROP TABLE')).toBeUndefined()
    // Case matters: the enum is upper case and Prisma would reject 'released'.
    expect(parseStatusParam('released')).toBeUndefined()
    expect(parseStatusParam('')).toBeUndefined()
    expect(parseStatusParam(undefined)).toBeUndefined()
  })

  it('accepts the three eligibilities and ignores anything else', () => {
    expect(parseEligibilityParam('SUPPLIER')).toBe('SUPPLIER')
    expect(parseEligibilityParam('BROKER')).toBe('BROKER')
    expect(parseEligibilityParam('INTERNAL')).toBe('INTERNAL')
    expect(parseEligibilityParam('SUPPLIERS')).toBeUndefined()
    expect(parseEligibilityParam('')).toBeUndefined()
    expect(parseEligibilityParam(undefined)).toBeUndefined()
  })

  // A company or account id is checked against the rows actually loaded from
  // the database. A hand-typed id, or one for a record since removed, drops the
  // filter rather than returning a silently empty table.
  it('accepts an id present in the loaded options and ignores one that is not', () => {
    const options = [{ id: 'cmp_1' }, { id: 'cmp_2' }]
    expect(parseOptionId('cmp_2', options)).toBe('cmp_2')
    expect(parseOptionId('cmp_9', options)).toBeUndefined()
    expect(parseOptionId('', options)).toBeUndefined()
    expect(parseOptionId(undefined, options)).toBeUndefined()
    expect(parseOptionId('cmp_1', [])).toBeUndefined()
  })
})

// The four dropdowns are not four separate queries. `buildWhere` already ANDs
// them, and they must go on narrowing each other, the search box, the
// incomplete checkbox and the NEEDS ACTION scope all at once.
describe('filters compose', () => {
  it('narrows by company, cash account, eligibility, search, scope and incompleteness together', async () => {
    const wanted = await makeCheck({
      checkNumber: '6000000910', status: 'SIGNED', eligibility: 'SUPPLIER',
      amount: null, payeeName: 'HENKEL PHILIPPINES INC.',
    })
    // Same company and account, but released — excluded by the NEEDS ACTION scope.
    await testDb.check.create({
      data: {
        companyId: wanted.companyId, cashAccountId: wanted.cashAccountId,
        checkNumber: '6000000911', status: 'RELEASED', eligibility: 'SUPPLIER',
        payeeName: 'HENKEL PHILIPPINES INC.', isIncomplete: true, checkDate: new Date('2026-09-01'),
      },
    })
    // Same company and account and live, but INTERNAL.
    await testDb.check.create({
      data: {
        companyId: wanted.companyId, cashAccountId: wanted.cashAccountId,
        checkNumber: '6000000912', status: 'SIGNED', eligibility: 'INTERNAL',
        payeeName: 'HENKEL PHILIPPINES INC.', isIncomplete: true, checkDate: new Date('2026-09-01'),
      },
    })
    // A different company entirely.
    await makeCheck({ checkNumber: '6000000913', amount: null, status: 'SIGNED' })

    const filters = {
      q: 'henkel',
      companyId: wanted.companyId,
      cashAccountId: wanted.cashAccountId ?? undefined,
      eligibility: 'SUPPLIER' as const,
      incomplete: true,
      statusIn: LIVE_STATUSES,
    }

    const rows = await listChecks(testDb, filters)

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000910'])
    expect(await countChecks(testDb, filters)).toBe(1)
  })

  it('filters by cash account on its own', async () => {
    const one = await makeCheck({ checkNumber: '6000000920' })
    await makeCheck({ checkNumber: '6000000921' })

    const rows = await listChecks(testDb, { cashAccountId: one.cashAccountId ?? undefined })

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000920'])
  })

  it('BANK filters on the ACCOUNT: the check book, else the register label (2026-10-06)', async () => {
    const booked = await makeCheck({ checkNumber: '6000000930' })
    const labelOnly = await makeCheck({ checkNumber: '6000000931' })
    const bank = await testDb.bank.create({ data: { code: 'BPI-Q', name: 'BPI' } })
    const book = await testDb.checkBook.create({ data: { code: 'BPI-S-9930', bankId: bank.id, companyId: booked.companyId } })
    await testDb.check.update({ where: { id: booked.id }, data: { checkBookId: book.id } })

    expect((await listChecks(testDb, { cashAccountId: book.id })).map((r) => r.checkNumber)).toEqual(['6000000930'])
    // The booked cheque's own label no longer selects it: its account is the book.
    expect(await listChecks(testDb, { cashAccountId: booked.cashAccountId! })).toHaveLength(0)
    expect((await listChecks(testDb, { cashAccountId: labelOnly.cashAccountId! })).map((r) => r.checkNumber)).toEqual(['6000000931'])
    expect((await getSummary(testDb, { cashAccountId: book.id })).total).toBe(1)

    const table = toTableRow((await listChecks(testDb, { cashAccountId: book.id }))[0])
    expect(table).toMatchObject({ cashAccountCode: 'BPI-S-9930', bankCode: 'BPI-Q' })
    const options = await getFilterOptions(testDb)
    expect(options.cashAccounts[0]).toEqual({ id: book.id, code: 'BPI-S-9930', bankCode: 'BPI-Q' })
  })

  it('BANK filter and a released-date range apply together', async () => {
    const one = await makeCheck({ status: 'RELEASED', checkNumber: '6000000940', releasedAt: new Date('2026-10-01T03:00:00Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000941', releasedAt: new Date('2026-10-01T03:00:00Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000942', releasedAt: new Date('2026-08-01T03:00:00Z') })
    const rows = await listChecks(testDb, {
      cashAccountId: one.cashAccountId!, releasedFrom: new Date('2026-09-30T16:00:00Z'), releasedTo: new Date('2026-10-01T15:59:59Z'),
    })
    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000940'])
  })

  it('filters by company on its own', async () => {
    const one = await makeCheck({ checkNumber: '6000000930' })
    await makeCheck({ checkNumber: '6000000931' })

    const rows = await listChecks(testDb, { companyId: one.companyId })

    expect(rows.map((r) => r.checkNumber)).toEqual(['6000000930'])
  })
})

/**
 * TODAY'S RELEASE: the panel above the table, and the set RELEASE ALL acts on.
 *
 * The set is READY_FOR_RELEASE **and** SCHEDULED, exactly like the card of the
 * same name — a panel offering to release 81 cheques above a card reading 87 is
 * a bug report waiting to happen. The pairing is not restated here or in
 * `getTodaysRelease`; both read `viewStatusFilter` in lib/dashboard-view.ts.
 */
/**
 * DATE RELEASED. The range is over `releasedAt` — the instant `markReleased`
 * wrote — and a release nobody recorded here has none, so it can never fall
 * inside a range. That is the fact the dashboard discloses with a count, and
 * `releasedAtIsNull` is how it gets the count from the same `buildWhere`.
 */
describe('DATE RELEASED range', () => {
  // Manila 2026-09-25, as the resolver would hand it over.
  const from = new Date('2026-09-24T16:00:00.000Z')
  const to = new Date('2026-09-25T15:59:59.999Z')

  it('returns only the checks released inside the range, never one with no recorded release', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-IN', releasedAt: new Date('2026-09-25T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-BEFORE', releasedAt: new Date('2026-09-20T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-AFTER', releasedAt: new Date('2026-09-26T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-UNDATED', releasedAt: null })

    const filters = { status: 'RELEASED' as const, releasedFrom: from, releasedTo: to }
    const rows = await listChecks(testDb, filters)
    expect(rows.map((r) => r.checkNumber)).toEqual(['R-IN'])
    expect(await countChecks(testDb, filters)).toBe(1)
  })

  it('is inclusive at both Manila-day edges', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-FIRST-MS', releasedAt: from })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-LAST-MS', releasedAt: to })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-ONE-MS-LATE', releasedAt: new Date(to.getTime() + 1) })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['R-FIRST-MS', 'R-LAST-MS'])
  })

  it('honours an open-ended bound on either side', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-EARLY', releasedAt: new Date('2026-09-20T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-LATE', releasedAt: new Date('2026-09-26T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'R-UNDATED', releasedAt: null })

    const onOrAfter = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from })
    expect(onOrAfter.map((r) => r.checkNumber)).toEqual(['R-LATE'])

    const onOrBefore = await listChecks(testDb, { status: 'RELEASED', releasedTo: to })
    expect(onOrBefore.map((r) => r.checkNumber)).toEqual(['R-EARLY'])
  })

  it('counts, for the disclosure, only the released checks with neither date', async () => {
    await makeCheck({ status: 'RELEASED', releasedAt: new Date('2026-09-25T02:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED' })
    await makeCheck({ status: 'RELEASED' })
    // Live, so no release date of either kind — must NOT be counted.
    await makeCheck({ status: 'SIGNED' })

    expect(await countChecks(testDb, { status: 'RELEASED', noReleaseDate: true })).toBe(2)
  })

  // The register's stated day is stored as UTC midnight — 08:00 Manila — so it
  // sits inside the Manila-day bounds the resolver builds.
  it('matches a check on its stated release day when the app recorded no release', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-IN', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-OUT', statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'S-NONE' })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber)).toEqual(['S-IN'])
  })

  it('matches on either date when a check carries both', async () => {
    // App says the 25th, register says the 22nd: inside on the app date.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-APP', releasedAt: new Date('2026-09-25T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })
    // App says the 20th, register says the 25th: inside on the stated date.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-REG', releasedAt: new Date('2026-09-20T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    // Both outside.
    await makeCheck({ status: 'RELEASED', checkNumber: 'B-OUT', releasedAt: new Date('2026-09-20T02:00:00.000Z'), statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })

    const rows = await listChecks(testDb, { status: 'RELEASED', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber).sort()).toEqual(['B-APP', 'B-REG'])
  })

  // The range lives under AND so it composes with the search, which owns the
  // top-level OR. Without that wrapping one of the two would silently replace
  // the other.
  it('still composes with a search', async () => {
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-IN-MATCH', payeeName: 'ACME TRADING', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-IN-OTHER', payeeName: 'HENKEL', statedReleaseDate: new Date('2026-09-25T00:00:00.000Z') })
    await makeCheck({ status: 'RELEASED', checkNumber: 'Q-OUT-MATCH', payeeName: 'ACME TRADING', statedReleaseDate: new Date('2026-09-22T00:00:00.000Z') })

    const rows = await listChecks(testDb, { status: 'RELEASED', q: 'acme', releasedFrom: from, releasedTo: to })
    expect(rows.map((r) => r.checkNumber)).toEqual(['Q-IN-MATCH'])
  })

  it('carries the stated day into the table row', async () => {
    const day = new Date('2026-09-25T00:00:00.000Z')
    const c = await makeCheck({ status: 'RELEASED', statedReleaseDate: day })
    const [row] = await listChecks(testDb, { q: c.checkNumber })
    expect(toTableRow(row).statedReleaseDate).toEqual(day)
    expect(toTableRow(row).releasedAt).toBeNull()
  })

  it('carries the release instant into the table row, null when none was recorded', async () => {
    const when = new Date('2026-09-25T02:00:00.000Z')
    const dated = await makeCheck({ status: 'RELEASED', releasedAt: when })
    const undated = await makeCheck({ status: 'RELEASED', releasedAt: null })

    const [datedRow] = await listChecks(testDb, { q: dated.checkNumber })
    expect(toTableRow(datedRow).releasedAt).toEqual(when)

    const [undatedRow] = await listChecks(testDb, { q: undated.checkNumber })
    expect(toTableRow(undatedRow).releasedAt).toBeNull()
  })
})

describe('getTodaysRelease', () => {
  it('covers READY_FOR_RELEASE and SCHEDULED together and nothing else', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '100.00' })
    await makeCheck({ status: 'SCHEDULED', amount: '200.00' })
    await makeCheck({ status: 'SIGNED', amount: '400.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: '800.00' })
    await makeCheck({ status: 'RELEASED', amount: '1600.00' })
    await makeCheck({ status: 'CANCELLED', amount: '3200.00' })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(2)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '300', count: 2 }])
  })

  // The same rule getSummary obeys. Production is PHP-only today; the rule is
  // structural, not a reading of the current data.
  it('never adds two different currencies together', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', currency: 'PHP', amount: '1000.00' })
    await makeCheck({ status: 'SCHEDULED', currency: 'PHP', amount: '500.50' })
    await makeCheck({ status: 'READY_FOR_RELEASE', currency: 'CNY', amount: '2000.25' })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(3)
    expect(t.totalsByCurrency).toHaveLength(2)
    expect(t.totalsByCurrency).toEqual(expect.arrayContaining([
      { currency: 'PHP', total: '1500.5', count: 2 },
      { currency: 'CNY', total: '2000.25', count: 1 },
    ]))
  })

  /**
   * SUPERSEDED BY A CLIENT DECISION, 2026-09-06. This test used to assert that a
   * READY_FOR_RELEASE cheque with no recorded amount was COUNTED here and
   * reported through a `TodaysRelease.incomplete` field, so the panel could
   * explain why its count and its total disagreed.
   *
   * The client asked for those cheques to be taken out of the dashboard
   * entirely — "dont consider them becuase they dont have amount" — so the READY
   * FOR RELEASE card no longer counts them, and this panel must not either: a
   * panel offering to RELEASE ALL 2 beneath a card reading 1 is the exact
   * disagreement `TODAYS_RELEASE_FILTER` exists to prevent. The field is gone
   * with the case it explained. Nothing is deleted; the cheque is still there,
   * and `/?incomplete=1` still lists it.
   */
  it('leaves a check with no recorded amount out of the set entirely', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '1000.00' })
    await makeCheck({ status: 'SCHEDULED', amount: null })

    const t = await getTodaysRelease(testDb)
    expect(t.count).toBe(1)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '1000', count: 1 }])
  })

  // The cheque is excluded from the panel, NOT removed: it is still in the
  // table, still READY_FOR_RELEASE, and still reachable by the filter the
  // dashboard links to.
  it('does not delete or restatus the check it excludes', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: null, checkNumber: '6000000301' })

    expect(await countChecks(testDb, { incomplete: true })).toBe(1)
    const rows = await listChecks(testDb, { incomplete: true })
    expect(rows[0].status).toBe('READY_FOR_RELEASE')
    expect(rows[0].checkNumber).toBe('6000000301')
  })

  /**
   * Every amount unknown is not the same fact as a total of zero, and must not
   * render as one. `formatMoney` shows null as an em dash.
   *
   * Reached through the DRIFT case since 2026-09-06: the panel now filters on
   * the stored `isIncomplete` flag, so the only way a null amount gets in is a
   * row whose flag disagrees with its own amount — exactly what
   * `scripts/backfill-incomplete.ts` exists to re-derive. The null must still be
   * carried through rather than collapsed, because a flag being stale is not a
   * reason to publish a confident ₱0.00.
   */
  it('carries a wholly unknown total through as null rather than zero', async () => {
    const c = await makeCheck({ status: 'READY_FOR_RELEASE', amount: null })
    await testDb.check.update({ where: { id: c.id }, data: { isIncomplete: false } })

    const t = await getTodaysRelease(testDb)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: null, count: 1 }])
  })

  // The panel is shown even when there is nothing to release, so the empty
  // answer has to be a real one rather than a throw or a null.
  it('answers zero when nothing is ready', async () => {
    await makeCheck({ status: 'SIGNED' })
    const t = await getTodaysRelease(testDb)
    expect(t).toEqual({ count: 0, totalsByCurrency: [] })
  })

  // The amount is a decimal STRING at every boundary. A JS number here would
  // lose centavos on a nine-figure peso total, and this is the figure a person
  // reads before handing over the money.
  it('reports the total as a decimal string, never a number', async () => {
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '6315173.06' })
    const t = await getTodaysRelease(testDb)
    expect(typeof t.totalsByCurrency[0].total).toBe('string')
    expect(formatMoney(t.totalsByCurrency[0].total, 'PHP')).toBe('₱6,315,173.06')
  })
})
describe("getTodaysRelease and listTodaysReleaseIds narrowed", () => {
  it('count the ready checks of one company, and RELEASE ALL acts on exactly those', async () => {
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE', amount: '100.00' })
    const alsoMine = await testDb.check.create({
      data: {
        companyId: mine.companyId, cashAccountId: mine.cashAccountId,
        checkNumber: '6000000002', apvNumbers: [], checkDate: new Date('2026-09-02'),
        amount: '50.00', isIncomplete: false, currency: 'PHP', payeeName: 'X',
        eligibility: 'SUPPLIER', status: 'SCHEDULED', isCheque: true,
      },
    })
    await makeCheck({ status: 'READY_FOR_RELEASE', amount: '1000.00' })

    const t = await getTodaysRelease(testDb, { companyId: mine.companyId })
    expect(t.count).toBe(2)
    expect(t.totalsByCurrency).toEqual([{ currency: 'PHP', total: '150', count: 2 }])

    const ids = await listTodaysReleaseIds(testDb, { companyId: mine.companyId })
    expect(ids).toEqual([mine.id, alsoMine.id])
  })

  it('narrow by cash account and by eligibility the same way', async () => {
    const bpi = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'BROKER' })
    await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })

    expect((await getTodaysRelease(testDb, { cashAccountId: bpi.cashAccountId! })).count).toBe(1)
    expect(await listTodaysReleaseIds(testDb, { eligibility: 'BROKER' })).toEqual([bpi.id])
  })
})

describe('SIGN ALL set', () => {
  it('is pending, real checks with an amount, narrowed', async () => {
    const a = await makeCheck({ status: 'SIGNATURE_PENDING', amount: '100.00' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING', amount: '250.50' })
    await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: false, amount: '9.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: null })
    await makeCheck({ status: 'SIGNED', amount: '1.00' })

    expect((await listPendingSignatureIds(testDb)).sort()).toEqual([a.id, b.id].sort())
    const s = await getPendingSignature(testDb)
    expect(s.count).toBe(2)
    expect(s.totalsByCurrency).toEqual([{ currency: 'PHP', total: '350.5', count: 2 }])

    // makeCheck gives every cheque its own company, so b is in a second one.
    expect(b.companyId).not.toBe(a.companyId)
    expect(await listPendingSignatureIds(testDb, { companyId: a.companyId })).toEqual([a.id])
    expect(await getPendingSignature(testDb, { companyId: a.companyId }))
      .toEqual({ count: 1, totalsByCurrency: [{ currency: 'PHP', total: '100', count: 1 }] })
    expect(await getPendingSignature(testDb, { companyId: 'no-such-company' })).toEqual({ count: 0, totalsByCurrency: [] })
  })
})

// Part C1: every column but ACTION, both directions, nulls LAST both ways.
describe('listChecks sort', () => {
  type Over = NonNullable<Parameters<typeof makeCheck>[0]>
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber)
  const sorted = async (key: SortKey, dir: 'asc' | 'desc', limit = 200) =>
    nums(await listChecks(testDb, {}, limit, { key, dir }))
  // 6000000001 is the low value, 02 the high one, 03 has none (where a column can be empty).
  const three = async (low: Over, high: Over, none: Over) => {
    const a = await makeCheck({ checkNumber: '6000000001', ...low })
    const b = await makeCheck({ checkNumber: '6000000002', ...high })
    const c = await makeCheck({ checkNumber: '6000000003', ...none })
    return [a, b, c] as const
  }
  const ASC = ['6000000001', '6000000002', '6000000003']
  const DESC = ['6000000002', '6000000001', '6000000003']

  it('SUPPLIER NAME', async () => {
    await three({ payeeName: 'ALPHA' }, { payeeName: 'ZULU' }, { payeeName: null })
    expect(await sorted('payeeName', 'asc')).toEqual(ASC)
    expect(await sorted('payeeName', 'desc')).toEqual(DESC)
  })

  it('CHECK DATE', async () => {
    await three({ checkDate: new Date('2026-01-01') }, { checkDate: new Date('2026-09-01') }, { checkDate: null })
    expect(await sorted('checkDate', 'asc')).toEqual(ASC)
    expect(await sorted('checkDate', 'desc')).toEqual(DESC)
  })

  it('AMOUNT', async () => {
    await three({ amount: '10.00' }, { amount: '900.00' }, { amount: null })
    expect(await sorted('amount', 'asc')).toEqual(ASC)
    expect(await sorted('amount', 'desc')).toEqual(DESC)
  })

  it('AVAILABLE DATE', async () => {
    await three(
      { availablePickupDate: new Date('2026-01-01') }, { availablePickupDate: new Date('2026-09-01') },
      { availablePickupDate: null },
    )
    expect(await sorted('availablePickupDate', 'asc')).toEqual(ASC)
    expect(await sorted('availablePickupDate', 'desc')).toEqual(DESC)
  })

  it('PICKUP SCHEDULE', async () => {
    const [a, b] = await three({}, {}, {})
    await testDb.check.update({ where: { id: a.id }, data: { scheduledPickupDate: new Date('2026-01-01') } })
    await testDb.check.update({ where: { id: b.id }, data: { scheduledPickupDate: new Date('2026-09-01') } })
    expect(await sorted('scheduledPickupDate', 'asc')).toEqual(ASC)
    expect(await sorted('scheduledPickupDate', 'desc')).toEqual(DESC)
  })

  it('COMPANY, by its code', async () => {
    const [a, b, c] = await three({}, {}, {})
    await testDb.company.update({ where: { id: a.companyId }, data: { code: 'AAA' } })
    await testDb.company.update({ where: { id: b.companyId }, data: { code: 'ZZZ' } })
    await testDb.company.update({ where: { id: c.companyId }, data: { code: 'MMM' } })
    expect(await sorted('companyCode', 'asc')).toEqual(['6000000001', '6000000003', '6000000002'])
    expect(await sorted('companyCode', 'desc')).toEqual(['6000000002', '6000000003', '6000000001'])
  })

  it('STATUS, by the ladder rather than the alphabet', async () => {
    await three({ status: 'SIGNATURE_PENDING' }, { status: 'RELEASED' }, { status: 'SIGNED' })
    // SIGNATURE_PENDING < SIGNED < RELEASED on the ladder; alphabetically RELEASED would be first.
    expect(await sorted('status', 'asc')).toEqual(['6000000001', '6000000003', '6000000002'])
    expect(await sorted('status', 'desc')).toEqual(['6000000002', '6000000003', '6000000001'])
  })

  it('CHECK NUMBER', async () => {
    await three({}, {}, {})
    expect(await sorted('checkNumber', 'asc')).toEqual(ASC)
    expect(await sorted('checkNumber', 'desc')).toEqual(['6000000003', '6000000002', '6000000001'])
  })

  it('APV NUMBER, by the first value shown — the check’s own or a bill’s', async () => {
    const [, , c] = await three({ apvNumbers: ['AP-B', 'AP-Z'] }, { apvNumbers: ['AP-C'] }, { apvNumbers: [] })
    expect(await sorted('apvNumbers', 'asc')).toEqual(ASC)
    expect(await sorted('apvNumbers', 'desc')).toEqual(DESC)
    // A bill's voucher counts: it is on screen in the same cell.
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-A', amount: '1.00' } })
    expect(await sorted('apvNumbers', 'asc')).toEqual(['6000000003', '6000000001', '6000000002'])
  })

  it('PO NUMBER, by the first value shown', async () => {
    const [a, b] = await three({}, {}, {})
    await testDb.checkBill.create({ data: { checkId: a.id, apvNumber: 'AP-1', poNumber: 'PO-1', amount: '1.00' } })
    await testDb.checkBill.create({ data: { checkId: b.id, apvNumber: 'AP-2', poNumber: 'PO-9', amount: '1.00' } })
    expect(await sorted('poNumbers', 'asc')).toEqual(ASC)
    expect(await sorted('poNumbers', 'desc')).toEqual(DESC)
  })

  it('BANK, by the cash account code, a check with none last both ways', async () => {
    const [a, b, c] = await three({}, {}, {})
    await testDb.cashAccount.update({ where: { id: a.cashAccountId! }, data: { code: 'AAA BANK' } })
    await testDb.cashAccount.update({ where: { id: b.cashAccountId! }, data: { code: 'ZZZ BANK' } })
    await testDb.check.update({ where: { id: c.id }, data: { cashAccountId: null } })
    expect(await sorted('bank', 'asc')).toEqual(ASC)
    expect(await sorted('bank', 'desc')).toEqual(DESC)
  })

  it('DATE RELEASED, by the date shown — the app’s, else the register’s', async () => {
    await three(
      { status: 'RELEASED', releasedAt: new Date('2026-09-10T02:00:00Z') },
      { status: 'RELEASED', statedReleaseDate: new Date('2026-09-20') },
      { status: 'RELEASED' },
    )
    expect(await sorted('releasedAt', 'asc')).toEqual(ASC)
    expect(await sorted('releasedAt', 'desc')).toEqual(DESC)
  })

  // The list shows at most 200: the sort must pick the right 200, not sort the first 200.
  it('sorts across every matching check before the limit, in the database and in the app', async () => {
    await makeCheck({ checkNumber: '6000000001', amount: '500.00', apvNumbers: ['AP-M'] })
    await makeCheck({ checkNumber: '6000000002', amount: '100.00', apvNumbers: ['AP-Z'] })
    await makeCheck({ checkNumber: '6000000003', amount: '300.00', apvNumbers: ['AP-A'] })
    expect(await sorted('amount', 'asc', 2)).toEqual(['6000000002', '6000000003'])
    expect(await sorted('apvNumbers', 'asc', 2)).toEqual(['6000000003', '6000000001'])
  })

  it('breaks a tie on the check number, ascending, in both directions', async () => {
    const nine = await makeCheck({ checkNumber: '6000000009', amount: '100.00' })
    const eight = await makeCheck({ checkNumber: '6000000008', amount: '100.00' })
    // The factory gives every cheque its own randomly coded cash account; one
    // account for both makes BANK a real tie rather than a coin toss.
    await testDb.check.update({ where: { id: eight.id }, data: { cashAccountId: nine.cashAccountId } })
    expect(await sorted('amount', 'asc')).toEqual(['6000000008', '6000000009'])
    expect(await sorted('amount', 'desc')).toEqual(['6000000008', '6000000009'])
    expect(await sorted('bank', 'desc')).toEqual(['6000000008', '6000000009'])
  })
})

describe('column filters', () => {
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber).sort()

  it('matches part of a check number, any case', async () => {
    await makeCheck({ checkNumber: 'BPI6000329924' })
    await makeCheck({ checkNumber: '1791379619' })
    expect(nums(await listChecks(testDb, { checkNumberContains: 'bpi6000' }))).toEqual(['BPI6000329924'])
  })

  it('matches part of a supplier name, any case', async () => {
    await makeCheck({ checkNumber: '6000000001', payeeName: 'HENKEL PHILIPPINES INC.' })
    await makeCheck({ checkNumber: '6000000002', payeeName: 'SHELL PILIPINAS CORP.' })
    expect(nums(await listChecks(testDb, { payeeContains: 'philip' }))).toEqual(['6000000001'])
  })

  it('matches part of an APV held on the check or on one of its bills, any case', async () => {
    await makeCheck({ checkNumber: '6000000011', apvNumbers: ['AP-ST042652'] })
    const onBill = await makeCheck({ checkNumber: '6000000012' })
    await testDb.checkBill.create({ data: { checkId: onBill.id, apvNumber: 'AP-ST099042', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000013', apvNumbers: ['AP-ST000001'] })
    expect(nums(await listChecks(testDb, { apvContains: '042' }))).toEqual(['6000000011', '6000000012'])
    expect(await countChecks(testDb, { apvContains: 'st0426' })).toBe(1)
  })

  it('reads % and _ as text, never as wildcards', async () => {
    await makeCheck({ apvNumbers: ['AP-ST042652'] })
    expect(await countChecks(testDb, { apvContains: '%' })).toBe(0)
    expect(await countChecks(testDb, { apvContains: 'AP_ST' })).toBe(0)
    expect(likePattern('5%_\\x')).toBe('%5\\%\\_\\\\x%')
  })

  it('matches part of a PO on a bill', async () => {
    const a = await makeCheck({ checkNumber: '6000000021' })
    await makeCheck({ checkNumber: '6000000022' })
    await testDb.checkBill.create({ data: { checkId: a.id, apvNumber: 'AP-1', poNumber: 'PO-STK-0451', amount: '1.00' } })
    expect(nums(await listChecks(testDb, { poContains: 'stk-04' }))).toEqual(['6000000021'])
  })

  it('bounds the amount inclusively, as decimal strings, and leaves out a check with no amount', async () => {
    await makeCheck({ checkNumber: '6000000031', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000032', amount: '500.00' })
    await makeCheck({ checkNumber: '6000000033', amount: '900.00' })
    await makeCheck({ checkNumber: '6000000034', amount: null })
    expect(nums(await listChecks(testDb, { amountMin: '500.00', amountMax: '900' }))).toEqual(['6000000032', '6000000033'])
    expect(nums(await listChecks(testDb, { amountMax: '100' }))).toEqual(['6000000031'])
    expect(nums(await listChecks(testDb, { amountMin: '500.01' }))).toEqual(['6000000033'])
  })

  it('bounds the check, available and pickup dates by Manila day, inclusively', async () => {
    const a = await makeCheck({ checkNumber: '6000000041', checkDate: new Date('2026-09-01'), availablePickupDate: new Date('2026-09-05T01:00:00Z') })
    await makeCheck({ checkNumber: '6000000042', checkDate: new Date('2026-09-02'), availablePickupDate: new Date('2026-09-06T01:00:00Z') })
    await testDb.check.update({ where: { id: a.id }, data: { scheduledPickupDate: new Date('2026-09-07T03:00:00Z') } })
    const day = (d: string) => ({ start: manilaDayStart(d), end: manilaDayEnd(d) })
    expect(nums(await listChecks(testDb, { from: day('2026-09-01').start, to: day('2026-09-01').end }))).toEqual(['6000000041'])
    expect(nums(await listChecks(testDb, { availableFrom: day('2026-09-06').start }))).toEqual(['6000000042'])
    expect(nums(await listChecks(testDb, { pickupTo: day('2026-09-07').end }))).toEqual(['6000000041'])
  })

  it('narrows within the view and the search rather than widening past them', async () => {
    await makeCheck({ checkNumber: '6000000051', status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000052', status: 'RELEASED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '100.00' })
    await makeCheck({ checkNumber: '6000000053', status: 'SIGNED', payeeName: 'HENKEL PHILIPPINES INC.', amount: '900.00' })
    expect(nums(await listChecks(testDb, { status: 'SIGNED', q: 'henkel', amountMax: '100' }))).toEqual(['6000000051'])
  })

  // A filter that cannot be read must not silently become no filter.
  it('lists nothing and counts nothing when a filter was refused', async () => {
    await makeCheck({})
    await makeCheck({ apvNumbers: ['AP-1'] })
    expect(await listChecks(testDb, { refused: true })).toEqual([])
    expect(await countChecks(testDb, { refused: true })).toBe(0)
    expect(await countChecks(testDb, { refused: true, apvContains: 'AP' })).toBe(0)
  })

  it('copies exactly the column filters and nothing else', () => {
    const copied = columnFilterFields({ payeeContains: 'x', status: 'SIGNED', incomplete: true, refused: true } as never)
    expect(copied).toEqual({ payeeContains: 'x' })
  })
})

describe('SIGN ALL set with column filters', () => {
  it('counts and lists only the pending checks the column filters admit', async () => {
    const acme = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'ACME TRADING', amount: '100.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'HENKEL PHILIPPINES INC.', amount: '200.00' })
    expect(await listPendingSignatureIds(testDb, {}, { payeeContains: 'acme' })).toEqual([acme.id])
    const pending = await getPendingSignature(testDb, {}, { payeeContains: 'acme' })
    expect(pending.count).toBe(1)
    expect(pending.totalsByCurrency).toEqual([{ currency: 'PHP', total: '100', count: 1 }])
  })

  // The anti-spread rule `todaysReleaseFilter` states: a whole CheckFilters
  // passed as `columns` must not override the status or the exclusion.
  it('cannot be widened by a status or incomplete smuggled in as a column filter', async () => {
    const p = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNED' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: null })
    const ids = await listPendingSignatureIds(testDb, {}, { status: 'SIGNED', incomplete: true } as never)
    expect(ids).toEqual([p.id])
  })

  // SIGN ALL is a bulk status write: a filter that could not be read must empty
  // the set, never fall back to every pending cheque.
  it('is empty when a column filter was refused', async () => {
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: '100.00' })
    await makeCheck({ status: 'SIGNATURE_PENDING', amount: '200.00' })
    expect(await listPendingSignatureIds(testDb, {}, { refused: true } as never)).toEqual([])
    expect((await getPendingSignature(testDb, {}, { refused: true } as never)).count).toBe(0)
  })
})

// Spec 2026-10-05: the PO NUMBER column also shows the POs Acumatica's
// AP-Bills and Adjustments names for any APV the cheque shows.
describe('PO NUMBER from Acumatica (AcumaticaBill)', () => {
  const acuBill = (apvNumber: string, poNumbers: string[]) =>
    testDb.acumaticaBill.create({ data: { apvNumber, tenant: 'GOLIVE', vendorRef: poNumbers.join(' / '), poNumbers } })
  const nums = (rows: { checkNumber: string }[]) => rows.map((r) => r.checkNumber).sort()

  it('shows the POs of every displayed APV — its own vouchers and its bills’ — with the bills’ POs, once each, sorted', async () => {
    const c = await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-ST000002', poNumber: 'PO-ST-000009', amount: '1.00' } })
    await acuBill('AP-ST000001', ['PO-ST-031110', 'PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-000009'])  // the bill's own PO: shown once
    await acuBill('AP-ST999999', ['PO-ST-777777'])  // an APV this cheque does not show
    const [row] = await listChecks(testDb, {})
    expect(toTableRow(row).poNumbers).toEqual(['PO-ST-000009', 'PO-ST-031110 / PO-ST-031109'])
  })

  it('a check none of whose APVs has an AcumaticaBill shows its bills’ POs only, or none', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    await acuBill('AP-ST000002', ['PO-ST-031109'])
    // Its APV has no AcumaticaBill, but a CheckBill carries a PO: exactly that PO shows.
    const withBill = await makeCheck({ checkNumber: '6000000002', apvNumbers: ['AP-ST000003'] })
    await testDb.checkBill.create({ data: { checkId: withBill.id, apvNumber: 'AP-ST000003', poNumber: 'PO-ST-000042', amount: '1.00' } })
    const rows = await listChecks(testDb, {})
    const poOf = (n: string) => toTableRow(rows.find((r) => r.checkNumber === n)!).poNumbers
    expect(poOf('6000000001')).toEqual([])
    expect(poOf('6000000002')).toEqual(['PO-ST-000042'])
  })

  it('the global search finds a check by part of an Acumatica PO, any case, and the count agrees', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    const viaBill = await makeCheck({ checkNumber: '6000000002' })
    await testDb.checkBill.create({ data: { checkId: viaBill.id, apvNumber: 'AP-ST000002', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000003', apvNumbers: ['AP-ST000003'] })
    await acuBill('AP-ST000001', ['PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-031150'])
    await acuBill('AP-ST000003', ['PO-A1-012345'])
    expect(nums(await listChecks(testDb, { q: 'po-st-0311' }))).toEqual(['6000000001', '6000000002'])
    expect(await countChecks(testDb, { q: 'po-st-0311' })).toBe(2)
    // Still narrows within the other filters.
    expect(nums(await listChecks(testDb, { q: 'po-st-0311', checkNumberContains: '0002' }))).toEqual(['6000000002'])
  })

  it('the PO filter box matches an Acumatica PO as well as a bill’s, and reads % as text', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    const viaBill = await makeCheck({ checkNumber: '6000000002' })
    await testDb.checkBill.create({ data: { checkId: viaBill.id, apvNumber: 'AP-ST000002', amount: '1.00' } })
    const billPo = await makeCheck({ checkNumber: '6000000004' })
    await testDb.checkBill.create({ data: { checkId: billPo.id, apvNumber: 'AP-ST000004', poNumber: 'PO-ST-031199', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000003', apvNumbers: ['AP-ST000003'] })
    await acuBill('AP-ST000001', ['PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-ST-031150'])
    await acuBill('AP-ST000003', ['PO-A1-012345'])
    expect(nums(await listChecks(testDb, { poContains: 'st-0311' }))).toEqual(['6000000001', '6000000002', '6000000004'])
    expect(await countChecks(testDb, { poContains: 'a1-0123' })).toBe(1)
    expect(await countChecks(testDb, { poContains: '%' })).toBe(0)
  })

  it('a broad pattern matches exactly the checks whose displayed APVs carry an Acumatica PO — never through another check’s APV', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-ST000001'] })
    const viaBill = await makeCheck({ checkNumber: '6000000002' })
    await testDb.checkBill.create({ data: { checkId: viaBill.id, apvNumber: 'AP-ST000002', amount: '1.00' } })
    // Shows AP-ST000003 only; that APV's AcumaticaBill has no PO. The matching
    // bill AP-ST000001 belongs to cheque 1's APV, not to this cheque.
    const other = await makeCheck({ checkNumber: '6000000003', apvNumbers: ['AP-ST000003'] })
    await testDb.checkBill.create({ data: { checkId: other.id, apvNumber: 'AP-ST000004', amount: '1.00' } })
    await makeCheck({ checkNumber: '6000000005' }) // no APV at all
    await acuBill('AP-ST000001', ['PO-ST-031109'])
    await acuBill('AP-ST000002', ['PO-A1-012345'])
    await acuBill('AP-ST000003', [])
    expect(nums(await listChecks(testDb, { poContains: 'PO' }))).toEqual(['6000000001', '6000000002'])
    expect(await countChecks(testDb, { poContains: 'PO' })).toBe(2)
    expect(nums(await listChecks(testDb, { q: 'PO' }))).toEqual(['6000000001', '6000000002'])
  })

  it('sorts PO NUMBER by the first value shown, Acumatica’s included, over every matching check before the limit', async () => {
    await makeCheck({ checkNumber: '6000000001', apvNumbers: ['AP-1'] })
    await makeCheck({ checkNumber: '6000000002', apvNumbers: ['AP-2'] })
    const c = await makeCheck({ checkNumber: '6000000003' })
    await makeCheck({ checkNumber: '6000000004' }) // no PO anywhere: last both ways
    await acuBill('AP-1', ['PO-ST-000005'])
    await acuBill('AP-2', ['PO-ST-000009'])
    await testDb.checkBill.create({ data: { checkId: c.id, apvNumber: 'AP-3', poNumber: 'PO-ST-000001', amount: '1.00' } })
    const sorted = async (dir: 'asc' | 'desc', limit = 200) =>
      (await listChecks(testDb, {}, limit, { key: 'poNumbers', dir })).map((r) => r.checkNumber)
    expect(await sorted('asc')).toEqual(['6000000003', '6000000001', '6000000002', '6000000004'])
    expect(await sorted('desc')).toEqual(['6000000002', '6000000001', '6000000003', '6000000004'])
    expect(await sorted('asc', 2)).toEqual(['6000000003', '6000000001'])
    // The page's rows carry Acumatica's POs too, not only the order.
    expect((await listChecks(testDb, {}, 1, { key: 'poNumbers', dir: 'desc' })).map((r) => toTableRow(r).poNumbers))
      .toEqual([['PO-ST-000009']])
  })
})
