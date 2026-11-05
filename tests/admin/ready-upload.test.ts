import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import {
  readReadyUpload, judgeUploadRow, planReadyUpload, applyReadyUpload, mergeUploads, checkReplaceDecision,
  type UploadCheck, type UploadRow,
} from '@/lib/admin/ready-upload'
import { canonicalCheckNumber } from '@/lib/import/normalise'

const PICKUP = new Date('2026-10-30T00:00:00.000Z')

describe('readReadyUpload', () => {
  it('reads a sheet whose header row carries both columns, wherever it is in the first rows', () => {
    const r = readReadyUpload([{
      name: 'READY',
      rows: [
        ['FOR RELEASE 29 OCT'], [],
        ['BANK', { richText: [{ text: 'Check No.' }] }, 'PAYEE', 'AP Bill'],
        ['BPI', 'BPI 6000400001', 'SUPPLIER', 'ap-st000001'],
        ['BPI', 6000400002, 'SUPPLIER', 'STPP-AP-000021'],
        ['BPI', null, null, null],
        ['BPI', '6000400003', 'SUPPLIER', 'not a bill'],
        ['BPI', '6000400004', 'SUPPLIER', null],
      ],
    }])
    expect(r.sheets).toEqual([{ sheet: 'READY', read: true, rows: 4, keyedBy: 'NUMBER' }])
    expect(r.rows).toEqual<UploadRow[]>([
      { sheet: 'READY', row: 4, keyedBy: 'NUMBER', checkNumber: '6000400001', voucher: 'AP-ST000001', rawCheckNumber: 'BPI 6000400001', rawVoucher: 'ap-st000001' },
      { sheet: 'READY', row: 5, keyedBy: 'NUMBER', checkNumber: '6000400002', voucher: 'STPP-AP-000021', rawCheckNumber: '6000400002', rawVoucher: 'STPP-AP-000021' },
      { sheet: 'READY', row: 7, keyedBy: 'NUMBER', checkNumber: '6000400003', voucher: null, rawCheckNumber: '6000400003', rawVoucher: 'not a bill' },
      { sheet: 'READY', row: 8, keyedBy: 'NUMBER', checkNumber: '6000400004', voucher: null, rawCheckNumber: '6000400004', rawVoucher: null },
    ])
  })

  it("reads Acumatica's AP bill export — Reference Nbr. and no check column — keyed on the bill", () => {
    const r = readReadyUpload([{
      name: 'LIST',
      rows: [
        ['Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref', 'Vendor Name', 'Balance Amount'],
        [new Date('2026-05-22'), '05-2026', 'AP-A1033419', 'PO-A1-025543', 'GDSM MARKETING', 22300],
        [new Date('2026-06-18'), '06-2026', 'ap-st041760', 'PO-ST-028732', 'Siegwerk', 44700],
        [null, null, null, null, null, 67000],   // a total line: nothing in the bill column
      ],
    }])
    expect(r.sheets).toEqual([{ sheet: 'LIST', read: true, rows: 2, keyedBy: 'BILL' }])
    expect(r.rows).toEqual<UploadRow[]>([
      { sheet: 'LIST', row: 2, keyedBy: 'BILL', checkNumber: null, voucher: 'AP-A1033419', rawCheckNumber: null, rawVoucher: 'AP-A1033419' },
      { sheet: 'LIST', row: 3, keyedBy: 'BILL', checkNumber: null, voucher: 'AP-ST041760', rawCheckNumber: null, rawVoucher: 'ap-st041760' },
    ])
  })

  it('skips, and names, a sheet with no AP BILL column', () => {
    const r = readReadyUpload([
      { name: 'PIVOT', rows: [['Row Labels', 'Sum of Amount'], ['BPI', 100]] },
      { name: 'NUMBERS ONLY', rows: [['CHECK NUMBER', 'PAYEE'], ['6000400001', 'X']] },
    ])
    expect(r.rows).toEqual([])
    expect(r.sheets.map((s) => [s.sheet, s.read, s.reason])).toEqual([
      ['PIVOT', false, 'no AP BILL header in its first 5 rows'],
      ['NUMBERS ONLY', false, 'has a CHECK NUMBER column but no AP BILL column'],
    ])
  })
})

describe('judgeUploadRow', () => {
  const row = (o: Partial<UploadRow> = {}): UploadRow => ({
    sheet: 'S', row: 2, keyedBy: 'NUMBER', checkNumber: '6000400001', voucher: 'AP-ST000001',
    rawCheckNumber: '6000400001', rawVoucher: 'AP-ST000001', ...o,
  })
  const byBill = (o: Partial<UploadRow> = {}): UploadRow => row({ keyedBy: 'BILL', checkNumber: null, rawCheckNumber: null, ...o })
  const c = (o: Partial<UploadCheck> = {}): UploadCheck => ({
    id: 'x', checkNumber: '6000400001', companyCode: 'STK', payeeName: 'SUPPLIER', amount: '100.00', currency: 'PHP',
    checkDate: '2026-09-01T00:00:00.000Z', accountCode: 'BPI-S-4636', status: 'SIGNED', acumaticaStatus: 'Balanced',
    isCheque: true, vouchers: ['AP-ST000001'], ...o,
  })

  it('readies the one live check that carries the bill; a pending one is signed first', () => {
    expect(judgeUploadRow(row(), [c()], PICKUP)).toEqual({ kind: 'READY', check: c(), signFirst: false })
    expect(judgeUploadRow(row(), [c({ status: 'SIGNATURE_PENDING' })], PICKUP)).toMatchObject({ kind: 'READY', signFirst: true })
  })

  it('takes the live check beside a cancelled or voided twin (a re-issue)', () => {
    expect(judgeUploadRow(row(), [c({ id: 'old', status: 'VOIDED' }), c({ id: 'new' })], PICKUP)).toMatchObject({ kind: 'READY', check: { id: 'new' } })
  })

  it('needs both cells, and a bill that is on the check the number names', () => {
    expect(judgeUploadRow(row({ checkNumber: null, rawCheckNumber: null }), [c()], PICKUP)).toMatchObject({ kind: 'INVALID_ROW', reason: /no check number/ })
    expect(judgeUploadRow(row({ voucher: null, rawVoucher: null }), [c()], PICKUP)).toMatchObject({ kind: 'INVALID_ROW', reason: /no AP bill/ })
    expect(judgeUploadRow(row({ voucher: null, rawVoucher: 'CV-1' }), [c()], PICKUP)).toMatchObject({ kind: 'INVALID_ROW', reason: /not an AP bill/ })
    expect(judgeUploadRow(row({ voucher: 'AP-ST000002', rawVoucher: 'AP-ST000002' }), [c()], PICKUP)).toMatchObject({ kind: 'BILL_NOT_ON_CHECK' })
    // The bill is checked before the status, so a released check with the
    // wrong bill is reported as the wrong bill — the thing to fix.
    expect(judgeUploadRow(row({ voucher: 'AP-ST000002', rawVoucher: 'AP-ST000002' }), [c({ status: 'RELEASED' })], PICKUP)).toMatchObject({ kind: 'BILL_NOT_ON_CHECK' })
  })

  it('a bill-keyed row needs only the bill, and the candidates it was given are the checks paying it', () => {
    expect(judgeUploadRow(byBill(), [c()], PICKUP)).toEqual({ kind: 'READY', check: c(), signFirst: false })
    expect(judgeUploadRow(byBill(), [c({ id: 'old', status: 'VOIDED' }), c({ id: 'new' })], PICKUP)).toMatchObject({ kind: 'READY', check: { id: 'new' } })
    expect(judgeUploadRow(byBill(), [], PICKUP).kind).toBe('NO_CHECK')
    expect(judgeUploadRow(byBill(), [c({ id: 'a' }), c({ id: 'b' })], PICKUP)).toEqual({ kind: 'AMBIGUOUS', count: 2 })
    expect(judgeUploadRow(byBill({ voucher: null, rawVoucher: null }), [c()], PICKUP)).toMatchObject({ kind: 'INVALID_ROW', reason: /no AP bill/ })
    expect(judgeUploadRow(byBill({ voucher: null, rawVoucher: 'CV-1' }), [c()], PICKUP)).toMatchObject({ kind: 'INVALID_ROW', reason: /not an AP bill/ })
  })

  it('leaves everything that is not one promotable live check', () => {
    expect(judgeUploadRow(row(), [], PICKUP).kind).toBe('NO_CHECK')
    expect(judgeUploadRow(row(), [c({ status: 'CANCELLED' })], PICKUP).kind).toBe('ONLY_CANCELLED_OR_VOIDED')
    expect(judgeUploadRow(row(), [c({ id: 'a' }), c({ id: 'b' })], PICKUP)).toEqual({ kind: 'AMBIGUOUS', count: 2 })
    expect(judgeUploadRow(row(), [c({ status: 'READY_FOR_RELEASE' })], PICKUP).kind).toBe('ALREADY_READY')
    expect(judgeUploadRow(row(), [c({ status: 'SCHEDULED' })], PICKUP).kind).toBe('ALREADY_READY')
    expect(judgeUploadRow(row(), [c({ status: 'RELEASED' })], PICKUP).kind).toBe('RELEASED')
    expect(judgeUploadRow(row(), [c({ status: 'GENERATED' })], PICKUP)).toMatchObject({ kind: 'NOT_PROMOTABLE', reason: /GENERATED/ })
    expect(judgeUploadRow(row(), [c({ isCheque: false })], PICKUP)).toMatchObject({ kind: 'NOT_PROMOTABLE', reason: /not a check/ })
    expect(judgeUploadRow(row(), [c({ acumaticaStatus: 'Voided' })], PICKUP)).toMatchObject({ kind: 'NOT_PROMOTABLE', reason: /Voided/ })
    // The MARK READY guard: a missing amount or account refuses here, before
    // anything is written, with the guard's own words.
    expect(judgeUploadRow(row(), [c({ amount: null })], PICKUP)).toMatchObject({ kind: 'NOT_PROMOTABLE', reason: /AMOUNT/ })
    expect(judgeUploadRow(row(), [c({ accountCode: null })], PICKUP)).toMatchObject({ kind: 'NOT_PROMOTABLE', reason: /CASH ACCOUNT/ })
  })
})

describe('planReadyUpload and applyReadyUpload', () => {
  beforeEach(async () => { await resetDb() })

  const list = (rows: [string, string][], sheet = 'READY') => ({
    rows: rows.map(([checkNumber, voucher], i): UploadRow => ({
      sheet, row: i + 2, keyedBy: 'NUMBER', checkNumber: canonicalCheckNumber(checkNumber), voucher, rawCheckNumber: checkNumber, rawVoucher: voucher,
    })),
    sheets: [{ sheet, read: true, rows: rows.length, keyedBy: 'NUMBER' as const }],
  })
  const billList = (vouchers: string[], sheet = 'LIST') => ({
    rows: vouchers.map((voucher, i): UploadRow => ({
      sheet, row: i + 2, keyedBy: 'BILL', checkNumber: null, voucher, rawCheckNumber: null, rawVoucher: voucher,
    })),
    sheets: [{ sheet, read: true, rows: vouchers.length, keyedBy: 'BILL' as const }],
  })

  it('plans one entry per check, says where a stray bill is held, and writes nothing', async () => {
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001', 'AP-ST000009'] })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000400002', apvNumbers: ['AP-ST000002'] })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000400003', apvNumbers: ['AP-ST000003'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400004', apvNumbers: ['AP-ST000004'] })
    // The same number twice, live — a SHARED_NUMBER in the making.
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400005', apvNumbers: ['AP-ST000005'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400005', apvNumbers: ['AP-ST000005'] })

    const plan = await planReadyUpload(testDb, {
      file: 'ready.xlsx', pickupDate: PICKUP,
      list: list([
        ['6000400001', 'AP-ST000001'],
        ['6000400001', 'AP-ST000009'],   // same check, its other bill — folded
        ['6000400002', 'AP-ST000002'],
        ['6000400003', 'AP-ST000003'],   // released
        ['6000400004', 'AP-ST000001'],   // bill held by 6000400001
        ['6000400005', 'AP-ST000005'],   // ambiguous
        ['6000400006', 'AP-ST000006'],   // no such check
      ]),
    })

    expect(plan.rows).toBe(7)
    expect(plan.toReady.map((t) => [t.check.id, t.signFirst, t.rows.map((r) => r.row)])).toEqual([
      [signed.id, false, [2, 3]],
      [pending.id, true, [4]],
    ])
    expect(plan.counts).toMatchObject({ READY: 3, RELEASED: 1, BILL_NOT_ON_CHECK: 1, AMBIGUOUS: 1, NO_CHECK: 1 })
    const stray = plan.leftAlone.find((l) => l.kind === 'BILL_NOT_ON_CHECK')
    expect(stray?.checkNumber).toBe('6000400004')
    expect(stray?.message).toMatch(/this check pays AP-ST000004; AP-ST000001 is on 6000400001 \(SIGNED\)/)
    expect(plan.leftAlone.map((l) => l.kind).sort()).toEqual(['AMBIGUOUS', 'BILL_NOT_ON_CHECK', 'NO_CHECK', 'RELEASED'])

    // A plan is a report.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })).status).toBe('SIGNED')
    expect(await testDb.auditLog.count()).toBe(0)
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  it('a bill-keyed list finds the one live check paying each bill, through apvNumbers or an approval-workbook bill', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001', 'AP-ST000009'] })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000400002', apvNumbers: [] })
    await testDb.checkBill.create({ data: { checkId: pending.id, apvNumber: 'AP-ST000002', amount: '100.00' } })
    await makeCheck({ status: 'VOIDED', checkNumber: '6000400003', apvNumbers: ['AP-ST000003'] })   // re-issued as:
    const reissue = await makeCheck({ status: 'SIGNED', checkNumber: '6000400004', apvNumbers: ['AP-ST000003'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400005', apvNumbers: ['AP-ST000005'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400006', apvNumbers: ['AP-ST000005'] })   // two live checks, one bill
    await makeCheck({ status: 'RELEASED', checkNumber: '6000400007', apvNumbers: ['AP-ST000007'] })

    const plan = await planReadyUpload(testDb, {
      file: 'bills.xlsx', pickupDate: PICKUP,
      list: billList(['AP-ST000001', 'AP-ST000009', 'AP-ST000002', 'AP-ST000003', 'AP-ST000005', 'AP-ST000007', 'AP-ST000008']),
    })
    expect(plan.toReady.map((t) => [t.check.id, t.signFirst, t.rows.map((r) => r.row)])).toEqual([
      [signed.id, false, [2, 3]],
      [pending.id, true, [4]],
      [reissue.id, false, [5]],
    ])
    expect(plan.counts).toMatchObject({ READY: 4, AMBIGUOUS: 1, RELEASED: 1, NO_CHECK: 1, BILL_NOT_ON_CHECK: 0 })
    expect(plan.leftAlone.map((l) => [l.kind, l.checkNumber, l.message])).toEqual([
      ['AMBIGUOUS', null, '2 live checks pay this AP bill — settle which one on /vouchers or in Acumatica first'],
      ['RELEASED', '6000400007', 'already RELEASED — a release is never pulled back by a list'],
      ['NO_CHECK', null, 'no check here pays this AP bill — has the sync read the check, and the BILLS read linked it?'],
    ])

    const summary = await applyReadyUpload(testDb, plan, { userId: admin.id, pickupDate: PICKUP, now: new Date() })
    expect(summary).toEqual({ readied: 3, requested: 0, signed: 1, failed: [], notReached: 0, reverted: 0, revertRequested: 0, kept: 0 })
    for (const id of [signed.id, pending.id, reissue.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_RELEASE')
    }
    const audit = await testDb.auditLog.findFirst({ where: { checkId: pending.id, action: 'ready_for_release' } })
    expect(audit?.details).toMatchObject({ source: { file: 'bills.xlsx', listRows: [{ sheet: 'LIST', row: 4, voucher: 'AP-ST000002', checkNumber: null }] } })
  })

  it("becomes requests, not readies, when an approver is set and the admin is not that person (spec 2026-11-05 §5)", async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const paolo = await makeUser('FINANCE_ADMIN')
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001'] })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000400002', apvNumbers: ['AP-ST000002'] })
    const plan = await planReadyUpload(testDb, {
      file: 'ready.xlsx', pickupDate: PICKUP,
      list: list([['6000400001', 'AP-ST000001'], ['6000400002', 'AP-ST000002']]),
    })
    const now = new Date('2026-11-05T02:00:00.000Z')
    const summary = await applyReadyUpload(testDb, plan, {
      userId: admin.id, pickupDate: PICKUP, now, approver: { id: paolo.id, name: paolo.name, email: paolo.email },
    })
    expect(summary).toEqual({ readied: 0, requested: 2, signed: 1, failed: [], notReached: 0, reverted: 0, revertRequested: 0, kept: 0 })
    // The signature is immediate; the availability waits.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })).status).toBe('SIGNED')
    expect(await testDb.check.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: 'SIGNED', signedById: admin.id, readyById: null })
    expect(await testDb.portalEvent.count()).toBe(0)
    const requests = await testDb.availabilityRequest.findMany({ orderBy: { checkId: 'asc' } })
    expect(requests).toHaveLength(2)
    for (const r of requests) {
      expect(r).toMatchObject({ status: 'PENDING', kind: 'MAKE_AVAILABLE', requestedById: admin.id, requestedAt: now, availablePickupDate: PICKUP })
      expect(r.source).toMatchObject({ file: 'ready.xlsx' })
    }
    // The approver's own upload applies at once.
    const own = await applyReadyUpload(testDb, await planReadyUpload(testDb, {
      file: 'ready.xlsx', pickupDate: PICKUP, list: list([['6000400001', 'AP-ST000001']]),
    }), { userId: paolo.id, pickupDate: PICKUP, now, approver: { id: paolo.id, name: paolo.name, email: paolo.email } })
    // Refused: a request is already pending on that check — the summary names it.
    expect(own.readied).toBe(0)
    expect(own.failed).toEqual([{ checkNumber: '6000400001', message: expect.stringContaining('waiting for approval') }])
  })

  it('applies through the domain: ready under the admin, with the pickup date, a portal event, and the list on the audit row', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const signed = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001'] })
    const pending = await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000400002', apvNumbers: ['AP-ST000002'] })
    const plan = await planReadyUpload(testDb, {
      file: 'ready.xlsx', pickupDate: PICKUP,
      list: list([['6000400001', 'AP-ST000001'], ['BPI 6000400002', 'AP-ST000002']]),
    })
    const now = new Date('2026-10-29T02:00:00.000Z')
    const summary = await applyReadyUpload(testDb, plan, { userId: admin.id, pickupDate: PICKUP, now })
    expect(summary).toEqual({ readied: 2, requested: 0, signed: 1, failed: [], notReached: 0, reverted: 0, revertRequested: 0, kept: 0 })

    const a = await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })
    expect(a).toMatchObject({ status: 'READY_FOR_RELEASE', readyById: admin.id, readyAt: now, availablePickupDate: PICKUP, portalSyncStatus: 'PENDING' })
    const b = await testDb.check.findUniqueOrThrow({ where: { id: pending.id } })
    expect(b).toMatchObject({ status: 'READY_FOR_RELEASE', signedById: admin.id, signedAt: now, readyById: admin.id })

    // The portal hears of both, as it would from the button.
    const events = await testDb.portalEvent.findMany({ orderBy: { createdAt: 'asc' } })
    expect(events.map((e) => [e.checkId, e.kind, e.status]).sort()).toEqual([[signed.id, 'MARK_AVAILABLE', 'PENDING'], [pending.id, 'MARK_AVAILABLE', 'PENDING']].sort())

    // The audit trail names the file and the row, on the signature too.
    const rows = await testDb.auditLog.findMany({ where: { checkId: pending.id }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => r.action)).toEqual(['marked_signed', 'ready_for_release'])
    for (const r of rows) {
      expect(r.userId).toBe(admin.id)
      expect(r.details).toMatchObject({ source: { file: 'ready.xlsx', listRows: [{ sheet: 'READY', row: 3, voucher: 'AP-ST000002', checkNumber: 'BPI 6000400002' }] } })
      expect(r.remarks).toMatch(/uploaded list ready\.xlsx \(READY row 3\)/)
    }
    const ready = rows[1]
    expect(ready.details).toMatchObject({ availablePickupDate: PICKUP.toISOString(), portalPush: true })
  })

  it('refuses, per check, one whose status moved between preview and confirm, and finishes the rest', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const moved = await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001'] })
    const still = await makeCheck({ status: 'SIGNED', checkNumber: '6000400002', apvNumbers: ['AP-ST000002'] })
    const plan = await planReadyUpload(testDb, {
      file: 'ready.xlsx', pickupDate: PICKUP,
      list: list([['6000400001', 'AP-ST000001'], ['6000400002', 'AP-ST000002']]),
    })
    await testDb.check.update({ where: { id: moved.id }, data: { status: 'CANCELLED' } })

    const summary = await applyReadyUpload(testDb, plan, { userId: admin.id, pickupDate: PICKUP, now: new Date() })
    expect(summary.readied).toBe(1)
    expect(summary.failed).toEqual([{ checkNumber: '6000400001', message: expect.stringMatching(/was SIGNED at the preview and is now CANCELLED/) }])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: moved.id } })).status).toBe('CANCELLED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: still.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('stops at the deadline, counts what it did not reach, and a second upload of the same list finishes it', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400001', apvNumbers: ['AP-ST000001'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000400002', apvNumbers: ['AP-ST000002'] })
    const input = { file: 'ready.xlsx', pickupDate: PICKUP, list: list([['6000400001', 'AP-ST000001'], ['6000400002', 'AP-ST000002']]) }

    const first = await applyReadyUpload(testDb, await planReadyUpload(testDb, input), {
      userId: admin.id, pickupDate: PICKUP, now: new Date(), deadline: new Date(0),
    })
    expect(first).toEqual({ readied: 0, requested: 0, signed: 0, failed: [], notReached: 2, reverted: 0, revertRequested: 0, kept: 0 })

    const again = await planReadyUpload(testDb, input)
    expect(again.toReady).toHaveLength(2)
    const second = await applyReadyUpload(testDb, again, { userId: admin.id, pickupDate: PICKUP, now: new Date() })
    expect(second).toMatchObject({ readied: 2, notReached: 0 })

    // Idempotent: the same list once more has nothing to do.
    const third = await planReadyUpload(testDb, input)
    expect(third.toReady).toEqual([])
    expect(third.counts.ALREADY_READY).toBe(2)
  })
})

/** ADD or REPLACE (user request 2026-11-05, spec `2026-11-05-ready-upload-replace-design.md`). */
describe('mergeUploads', () => {
  const one = (sheet: string, voucher: string) => ({
    rows: [{ sheet, row: 2, keyedBy: 'BILL' as const, checkNumber: null, voucher, rawCheckNumber: null, rawVoucher: voucher }],
    sheets: [{ sheet, read: true, rows: 1, keyedBy: 'BILL' as const }],
  })
  it('leaves a single file as it is', () => {
    const l = one('local', 'AP-ST000001')
    expect(mergeUploads([{ name: 'LOCAL.xlsx', list: l }])).toBe(l)
  })
  it('reads several files as one list, each sheet named after its file', () => {
    const m = mergeUploads([{ name: 'LOCAL.xlsx', list: one('local', 'AP-ST000001') }, { name: 'BROKERS.xlsx', list: one('local', 'AP-ST000002') }])
    expect(m.rows.map((r) => [r.sheet, r.voucher])).toEqual([['LOCAL.xlsx › local', 'AP-ST000001'], ['BROKERS.xlsx › local', 'AP-ST000002']])
    expect(m.sheets.map((s) => s.sheet)).toEqual(['LOCAL.xlsx › local', 'BROKERS.xlsx › local'])
  })
})

describe('checkReplaceDecision', () => {
  const off = [{ id: 'a', checkNumber: '1' }, { id: 'b', checkNumber: '2' }]
  it('needs every off-list check decided', () => {
    expect(checkReplaceDecision(off, { revert: ['a'], keep: [], reason: 'x' })).toMatchObject({ ok: false, message: expect.stringContaining('1 undecided (2)') })
    expect(checkReplaceDecision(off, { revert: ['a'], keep: ['b'], reason: 'x' })).toEqual({ ok: true })
    expect(checkReplaceDecision(off, { revert: [], keep: ['a', 'b'], reason: '' })).toEqual({ ok: true })
  })
  it('refuses a check both kept and reverted, and a revert with no reason', () => {
    expect(checkReplaceDecision(off, { revert: ['a', 'b'], keep: ['a'], reason: 'x' }).ok).toBe(false)
    expect(checkReplaceDecision(off, { revert: ['a', 'b'], keep: [], reason: '  ' })).toEqual({ ok: false, message: 'Enter a reason for reverting checks to SIGNED.' })
  })
  it('has nothing to decide when every ready check is on the list', () => {
    expect(checkReplaceDecision([], { revert: [], keep: [], reason: '' })).toEqual({ ok: true })
  })
})

describe('REPLACE: checks ready now and not on the list', () => {
  beforeEach(async () => { await resetDb() })
  const billList = (vouchers: string[], numbers: string[] = []) => ({
    rows: [
      ...vouchers.map((voucher, i): UploadRow => ({ sheet: 'LIST', row: i + 2, keyedBy: 'BILL', checkNumber: null, voucher, rawCheckNumber: null, rawVoucher: voucher })),
      ...numbers.map((n, i): UploadRow => ({ sheet: 'BROKERS', row: i + 2, keyedBy: 'NUMBER', checkNumber: n, voucher: 'AP-ST999999', rawCheckNumber: n, rawVoucher: 'AP-ST999999' })),
    ],
    sheets: [{ sheet: 'LIST', read: true, rows: vouchers.length, keyedBy: 'BILL' as const }],
  })

  async function scene() {
    const admin = await makeUser('FINANCE_ADMIN')
    const byBill = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000500001', apvNumbers: ['AP-ST000001'] })
    const byNumber = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000500002', apvNumbers: ['AP-ST000002'] })
    const off = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000500003', apvNumbers: ['AP-ST000003'] })
    const offScheduled = await makeCheck({ status: 'SCHEDULED', checkNumber: '6000500004', apvNumbers: ['AP-ST000004'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000500005', apvNumbers: ['AP-ST000005'] })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000500006', apvNumbers: ['AP-ST000006'] })
    // Named by a bill whose row is AMBIGUOUS (two live checks) — never offered.
    const ambiguous = await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000500007', apvNumbers: ['AP-ST000007'] })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000500008', apvNumbers: ['AP-ST000007'] })
    return { admin, byBill, byNumber, off, offScheduled, ambiguous }
  }

  it('lists every READY or SCHEDULED check no row names, by number or by bill; ADD lists none', async () => {
    const { off, offScheduled } = await scene()
    const list = billList(['AP-ST000001', 'AP-ST000007'], ['6000500002'])
    const replace = await planReadyUpload(testDb, { file: 'list.xlsx', pickupDate: PICKUP, list, mode: 'REPLACE' })
    expect(replace.mode).toBe('REPLACE')
    expect(replace.offList.map((c) => [c.id, c.status])).toEqual([[off.id, 'READY_FOR_RELEASE'], [offScheduled.id, 'SCHEDULED']])
    const add = await planReadyUpload(testDb, { file: 'list.xlsx', pickupDate: PICKUP, list })
    expect(add).toMatchObject({ mode: 'ADD', offList: [] })
  })

  it('reverts only the checks decided REVERT, through the domain, with the reason and a portal REVERT', async () => {
    const { admin, off, offScheduled } = await scene()
    const list = billList(['AP-ST000001', 'AP-ST000007'], ['6000500002'])
    const plan = await planReadyUpload(testDb, { file: 'list.xlsx', pickupDate: PICKUP, list, mode: 'REPLACE' })
    const summary = await applyReadyUpload(testDb, plan, {
      userId: admin.id, pickupDate: PICKUP, now: new Date(),
      replace: { revert: [off.id, 'not-off-list'], keep: [offScheduled.id], reason: 'Not on the 11.6 list' },
    })
    expect(summary).toMatchObject({ reverted: 1, revertRequested: 0, kept: 1, notReached: 0 })
    expect(summary.failed).toEqual([{ checkNumber: 'not-off-list', message: expect.stringContaining('not reverted') }])
    expect(await testDb.check.findUniqueOrThrow({ where: { id: off.id } })).toMatchObject({ status: 'SIGNED', availablePickupDate: null })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: offScheduled.id } })).status).toBe('SCHEDULED')
    expect(await testDb.portalEvent.findMany({ select: { checkId: true, kind: true } })).toEqual([{ checkId: off.id, kind: 'REVERT' }])
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: off.id, action: 'reverted_availability' } })
    expect(audit.remarks).toBe('Not on the 11.6 list')
    expect(audit.details).toMatchObject({ source: { file: 'list.xlsx', replacement: true } })
  })

  it("a user who is not the approver sends the reverts to the approver as WITHDRAW requests; nothing moves", async () => {
    const { admin, off, offScheduled } = await scene()
    const paolo = await makeUser('FINANCE_ADMIN')
    const plan = await planReadyUpload(testDb, {
      file: 'list.xlsx', pickupDate: PICKUP, list: billList(['AP-ST000001', 'AP-ST000007'], ['6000500002']), mode: 'REPLACE',
    })
    const summary = await applyReadyUpload(testDb, plan, {
      userId: admin.id, pickupDate: PICKUP, now: new Date(), approver: { id: paolo.id, name: paolo.name, email: paolo.email },
      replace: { revert: [off.id, offScheduled.id], keep: [], reason: 'Not on the list' },
    })
    expect(summary).toMatchObject({ reverted: 0, revertRequested: 2, failed: [] })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: off.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.portalEvent.count()).toBe(0)
    const requests = await testDb.availabilityRequest.findMany({ select: { kind: true, reason: true, status: true } })
    expect(requests).toEqual([
      { kind: 'WITHDRAW', reason: 'Not on the list', status: 'PENDING' },
      { kind: 'WITHDRAW', reason: 'Not on the list', status: 'PENDING' },
    ])
  })
})
