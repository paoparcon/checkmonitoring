import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import {
  readReadyUpload, judgeUploadRow, planReadyUpload, applyReadyUpload,
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
    expect(summary).toEqual({ readied: 3, signed: 1, failed: [], notReached: 0 })
    for (const id of [signed.id, pending.id, reissue.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_RELEASE')
    }
    const audit = await testDb.auditLog.findFirst({ where: { checkId: pending.id, action: 'ready_for_release' } })
    expect(audit?.details).toMatchObject({ source: { file: 'bills.xlsx', listRows: [{ sheet: 'LIST', row: 4, voucher: 'AP-ST000002', checkNumber: null }] } })
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
    expect(summary).toEqual({ readied: 2, signed: 1, failed: [], notReached: 0 })

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
    expect(first).toEqual({ readied: 0, signed: 0, failed: [], notReached: 2 })

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
