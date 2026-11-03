import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import {
  BILL_CHECK_REF_RULING, importBills, isBillSheet, parseBillRows, type ParsedBill,
} from '@/lib/import/bills'
import type { RawRow } from '@/lib/import/workbook'

// A bill sheet's measured layout, 0-indexed exactly as `readWorkbook` yields
// a row's cells. Restated here rather than imported from the parser so this
// file pins the mapping against the workbook, instead of agreeing with whatever
// the parser happens to believe.
const COL = {
  date: 0, postPeriod: 1, referenceNbr: 2, vendorRef: 3, vendorName: 4,
  balanceAmount: 5, description: 6, dueDate: 7, type: 8, detailTotal: 9,
  termsCode: 10, createdBy: 11, glAccount: 17, financeRemarks: 18,
  paymentRef: 19, checkNo: 20, bank: 21,
} as const

const WIDTH = 24

// Row 1 of every data sheet, verbatim as ExcelJS yields it — measured on the
// 4, 7 and 10 September workbooks, which agree to the character including the
// trailing space in `check No. ` and the two empty trailing cells. This is what
// the parser identifies a bill sheet BY, so it is restated here for the same
// reason `COL` is.
const HEADER: readonly (string | null)[] = [
  'Date', 'Post Period', 'Reference Nbr.', 'Vendor Ref.', 'Vendor Name', 'Balance Amount',
  'Description', 'Due Date', 'Type', 'Detail Total', 'Terms Code', 'Created By', 'NO. OF DAYS',
  '1-30 days Over due', '31-60 days Over due', '61-90days Over due', 'OVER 90 DAYS', 'GL Account',
  'FINANCE REMARKS', 'Payment Ref. #', 'check No. ', 'bank', null, null,
]

// The 7 September workbook's two data sheets. Deliberately NOT `LIST`: the
// sheet the 4 September file called LIST is called `local supplier` now, and a
// test that kept using the old name would keep passing while the importer read
// nothing at all — which is exactly the defect this file exists to prevent.
const SHEET = 'local supplier'
const BROKERAGE = 'BROKERAGE'

function listRow(
  row: number,
  values: Partial<Record<keyof typeof COL, unknown>>,
  sheet: string = SHEET,
): RawRow {
  const cells: unknown[] = new Array<unknown>(WIDTH).fill(null)
  for (const key of Object.keys(values) as (keyof typeof COL)[]) cells[COL[key]] = values[key]
  return { sheet, row, cells, header: HEADER }
}

// A complete, well-formed bill row, so a test states only what it is about.
// Typed against `COL` deliberately: a misspelt override is a compile error
// rather than a silently ignored key.
function billRow(
  row: number,
  values: Partial<Record<keyof typeof COL, unknown>> = {},
  sheet: string = SHEET,
): RawRow {
  return listRow(row, {
    date: new Date('2026-08-04T00:00:00Z'),
    postPeriod: '08-2026',
    referenceNbr: 'AP-A1033419',
    vendorRef: 'PO-A1-025543',
    vendorName: 'ACME TRADING INC.',
    balanceAmount: 0,
    description: 'CORRUGATED SHEETS',
    dueDate: new Date('2026-09-03T00:00:00Z'),
    type: 'Bill',
    detailTotal: 197715.42,
    termsCode: '30D',
    createdBy: 'JASMINE RABANG',
    glAccount: 'RAW MATERIALS',
    financeRemarks: 'AVAILABLE',
    checkNo: 6000338925,
    bank: 'BPI STK',
    ...values,
  }, sheet)
}

// A row on a sheet with no header at all — the pivot, whatever it is called in
// this week's export. Its cells are deliberately shaped like a pivot's: a
// cash-account label, a count and a subtotal, which read as a voucher and an
// amount if anybody ever reads them positionally.
function pivotRow(row: number, sheet = 'Sheet3'): RawRow {
  return { sheet, row, cells: ['BPI STK', 39, 1234567.89], header: [] }
}

function only(result: { bills: ParsedBill[] }): ParsedBill {
  expect(result.bills).toHaveLength(1)
  return result.bills[0]
}

describe('parseBillRows', () => {
  it('maps each LIST column onto its CheckBill field', () => {
    const b = only(parseBillRows([billRow(2)]))
    expect(b.apvNumber).toBe('AP-A1033419')
    expect(b.poNumber).toBe('PO-A1-025543')
    expect(b.description).toBe('CORRUGATED SHEETS')
    expect(b.glAccount).toBe('RAW MATERIALS')
    expect(b.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-03')
    expect(b.termsCode).toBe('30D')
    expect(b.amount).toBe('197715.42')
    expect(b.createdByName).toBe('JASMINE RABANG')
    expect(b.checkNumber).toBe('6000338925')
    expect(b.cashAccountLabel).toBe('BPI STK')
    expect(b.sheet).toBe(SHEET)
    expect(b.row).toBe(2)
  })

  it('reads a numeric check cell as digits, not as a float rendering', () => {
    // Every one of the 84 usable `check No.` cells is a numeric cell, so the
    // cheque number arrives as a JS number and has to survive the trip back to
    // a string intact.
    const b = only(parseBillRows([billRow(2, { checkNo: 1791361727 })]))
    expect(b.checkNumber).toBe('1791361727')
  })

  it('canonicalises a bank-prefixed check number through the shared rule', () => {
    // Acumatica prefixes 90.0% of its refs with a bank code. Matching a bill to
    // a cheque on the raw string would silently match nothing, so this must go
    // through `canonicalCheckNumber` rather than a second normalisation.
    const b = only(parseBillRows([billRow(2, { checkNo: 'BPI 6000240287' })]))
    expect(b.checkNumber).toBe('6000240287')
    expect(b.statedCheckRef).toBe('BPI 6000240287')
  })

  it('keeps the amount a decimal string and never a JS number', () => {
    for (const [cell, expected] of [
      [197715.42, '197715.42'],
      [7950, '7950'],
      ['1,234.56', '1234.56'],
      [0.05, '0.05'],
    ] as const) {
      const b = only(parseBillRows([billRow(2, { detailTotal: cell })]))
      expect(b.amount, String(cell)).toBe(expected)
      expect(typeof b.amount).toBe('string')
    }
  })

  it('sends an exponent-form total to review rather than expanding it', () => {
    // Same rule `readAmount` already applies to the register: expanding an
    // exponent risks inventing digits, and nothing in that range is a bill.
    const { bills, review } = parseBillRows([billRow(2, { detailTotal: 1e21 })])
    expect(bills).toHaveLength(0)
    expect(review[0]?.reason).toBe('NO_AMOUNT')
  })

  // CHANGED 2026-09-07. This used to assert that a row whose `check No.` is not
  // a cheque number goes to review at parse time. That was correct and it lost
  // a cheque: row 81 of the real LIST sheet holds a date there, and its voucher
  // AP-ST042652 therefore never reached the supplier portal. Whether such a row
  // is fatal is a question about the DATABASE — the voucher may name exactly
  // one cheque — and a pure parser cannot answer it. It is decided in
  // `matchBills`, which the tests below pin.
  it('keeps a row whose check No. is not a check number, with the cell verbatim', () => {
    const { bills, review } = parseBillRows([
      billRow(2, { checkNo: new Date('2026-08-13T00:00:00Z') }),
      billRow(3, { checkNo: null }),
      billRow(4, { checkNo: 'pls check w/ jasmine' }),
    ])
    expect(review).toHaveLength(0)
    expect(bills.map((b) => b.checkNumber)).toEqual([null, null, null])
    // Rendered as a date rather than through `String(new Date(...))`, which
    // yields "Thu Aug 13 2026 00:00:00 GMT+0800 (…)" — unusable to the person
    // who has to find the cheque this row means.
    expect(bills[0].statedCheckRef).toBe('2026-08-13')
    expect(bills[1].statedCheckRef).toBeNull()
    expect(bills[2].statedCheckRef).toBe('pls check w/ jasmine')
    // Everything else about the row survives, which is what makes it resolvable.
    expect(bills[0].apvNumber).toBe('AP-A1033419')
    expect(bills[0].amount).toBe('197715.42')
  })


  it('keeps a bill whose Type and Created By cells are blank', () => {
    // Measured: row 41 of the real LIST sheet has neither, and is a genuine
    // bill with a proper cheque number. Filtering on `Type = Bill` would drop it.
    const b = only(parseBillRows([billRow(2, { type: null, createdBy: null, postPeriod: null })]))
    expect(b.apvNumber).toBe('AP-A1033419')
    expect(b.createdByName).toBeNull()
  })

  it('reviews a row with no APV and one with no amount', () => {
    // `CheckBill.apvNumber` and `CheckBill.amount` are both NOT NULL. A bill
    // missing either cannot be written without inventing it.
    const { bills, review } = parseBillRows([
      billRow(2, { referenceNbr: null }),
      billRow(3, { detailTotal: null }),
      billRow(4, { detailTotal: 'CANCELLED' }),
    ])
    expect(bills).toHaveLength(0)
    expect(review.map((r) => r.reason)).toEqual(['NO_APV', 'NO_AMOUNT', 'NO_AMOUNT'])
    // A staged row has to be legible without reopening the workbook: the sheet
    // and row alone leave a human hunting for which of 85 rows it was.
    expect(review[1]).toMatchObject({ apvNumber: 'AP-A1033419', checkNumber: '6000338925' })
    expect(review[0].apvNumber).toBeNull()
  })

  it('drops nothing: every LIST row is either a bill or a review item', () => {
    const rows = [
      billRow(2),
      billRow(3, { checkNo: new Date('2026-08-13T00:00:00Z') }),
      billRow(4, { referenceNbr: '#N/A' }),
      billRow(5),
    ]
    const { bills, review } = parseBillRows(rows)
    expect(bills.length + review.length).toBe(rows.length)
  })

  it('reads a due date from an Excel serial as well as a date cell', () => {
    const serial = only(parseBillRows([billRow(2, { dueDate: 46164 })]))
    expect(serial.dueDate?.toISOString().slice(0, 10)).toBe('2026-05-22')

    // ExcelJS yields an Invalid Date for a malformed date cell; it passes
    // `instanceof Date` and would throw on write.
    const bad = only(parseBillRows([billRow(2, { dueDate: new Date('nonsense') })]))
    expect(bad.dueDate).toBeNull()

    const none = only(parseBillRows([billRow(2, { dueDate: null })]))
    expect(none.dueDate).toBeNull()
  })

  it('carries the finance remark as evidence and states no status', () => {
    // AVAILABLE on all 85 rows corroborates READY_FOR_RELEASE, but import never
    // changes release status (D4). The remark is for a human to read.
    const b = only(parseBillRows([billRow(2)]))
    expect(b.financeRemark).toBe('AVAILABLE')
    expect(b).not.toHaveProperty('status')
  })
})

// The 7 September defect. The parser knew one sheet name, `LIST`, and the new
// export has no sheet by that name — so it read zero rows out of a workbook of
// 238 bills and reported success. A sheet is now identified by the header it
// carries, which is the one thing that has not changed across the 4, 7 and 10
// September exports.
describe('parseBillRows — which sheets hold bills', () => {
  it('reads every sheet carrying the Acumatica bill header, whatever it is called', () => {
    const { bills, sheets } = parseBillRows([
      billRow(2),
      billRow(3),
      billRow(2, { referenceNbr: 'AP-ST043131' }, BROKERAGE),
    ])

    expect(bills).toHaveLength(3)
    // And each bill remembers which sheet it came from. `BROKERAGE` is a
    // distinct stream — the supplier portal exposes broker cheques on their own
    // endpoint — and nothing may flatten the two together.
    expect(bills.map((b) => b.sheet)).toEqual([SHEET, SHEET, BROKERAGE])
    expect(sheets).toEqual([
      { sheet: SHEET, rows: 2, read: true, bills: 2, review: 0 },
      { sheet: BROKERAGE, rows: 1, read: true, bills: 1, review: 0 },
    ])
  })

  it('skips a sheet with no header and says so, rather than reading it', () => {
    // The pivot. Its column 3 holds a subtotal, so reading it positionally
    // files an AMOUNT as a voucher reference — and its rows are derived from
    // the data sheets, so importing one double-counts a bill.
    const { bills, review, sheets } = parseBillRows([pivotRow(2), pivotRow(3), billRow(2)])

    expect(bills).toHaveLength(1)
    expect(review).toHaveLength(0)
    // Reported, not passed over in silence: "we read no rows off that sheet"
    // and "that sheet had no rows" are the two things this importer must never
    // confuse.
    expect(sheets).toEqual([
      { sheet: 'Sheet3', rows: 2, read: false, bills: 0, review: 0 },
      { sheet: SHEET, rows: 1, read: true, bills: 1, review: 0 },
    ])
  })

  it('skips a sheet whose header has moved, rather than reading the wrong column', () => {
    // A renamed or shifted column is not a smaller problem than a pivot. Every
    // column this parser reads is positional, and its safety comes entirely
    // from the header having been checked first.
    const shifted = HEADER.map((h) => (h === 'Detail Total' ? 'Amount' : h))
    const row = { ...billRow(2), header: shifted }

    const { bills, sheets } = parseBillRows([row])
    expect(bills).toHaveLength(0)
    expect(sheets[0]).toMatchObject({ sheet: SHEET, rows: 1, read: false })
  })

  it('accepts the header however it is cased, spaced or padded', () => {
    // Measured: the real header reads `check No. ` with a trailing space. A
    // signature that broke on whitespace would be its own version of the bug.
    const noisy = HEADER.map((h) => (h === null ? null : `  ${h.toLowerCase()}  `))
    const { bills } = parseBillRows([{ ...billRow(2), header: noisy }])
    expect(bills).toHaveLength(1)
  })

  it('treats a row with no header at all as belonging to no bill sheet', () => {
    // Not a fallback to positional reading. A grid that says nothing about its
    // shape is not evidence that it has the shape we want.
    const { sheets } = parseBillRows([{ sheet: SHEET, row: 2, cells: [] }])
    expect(sheets[0].read).toBe(false)
    expect(isBillSheet(undefined)).toBe(false)
    expect(isBillSheet([])).toBe(false)
  })

  it('accounts for every row of every sheet it read', () => {
    const rows = [
      pivotRow(2),
      billRow(2),
      billRow(3, { referenceNbr: null }),
      billRow(2, { detailTotal: null }, BROKERAGE),
    ]
    const { bills, review, sheets } = parseBillRows(rows)

    expect(bills.length + review.length).toBe(
      sheets.filter((s) => s.read).reduce((n, s) => n + s.rows, 0),
    )
    // And every sheet in the file appears, read or not, so the totals above can
    // be reconciled against the workbook rather than against themselves.
    expect(sheets.map((s) => s.sheet)).toEqual(['Sheet3', SHEET, BROKERAGE])
    expect(sheets.reduce((n, s) => n + s.rows, 0)).toBe(rows.length)
  })
})

describe('importBills', () => {
  beforeEach(resetDb)

  // Bill detail is data about a cheque, never a reason to tell a supplier
  // anything. Asserted after every test rather than in one a later author could
  // forget to extend.
  afterEach(async () => {
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  const NOW = new Date('2026-09-04T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review, sheets } = parseBillRows(rows)
    return importBills(testDb, { bills, review, sheets, now: NOW })
  }

  it('writes a bill against the check its check No. names', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    const summary = await run([billRow(2)])

    expect(summary).toMatchObject({ bills: 1, created: 1, updated: 0 })
    expect(summary.unmatched).toHaveLength(0)

    const [bill] = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bill.apvNumber).toBe('AP-A1033419')
    expect(bill.poNumber).toBe('PO-A1-025543')
    expect(bill.description).toBe('CORRUGATED SHEETS')
    expect(bill.glAccount).toBe('RAW MATERIALS')
    expect(bill.termsCode).toBe('30D')
    expect(bill.createdByName).toBe('JASMINE RABANG')
    expect(bill.dueDate?.toISOString().slice(0, 10)).toBe('2026-09-03')
    // To the centavo. A float round-trip is how the .42 goes missing.
    expect(bill.amount.toFixed(2)).toBe('197715.42')
  })

  it('is idempotent on (checkId, apvNumber)', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([billRow(2)])
    const second = await run([billRow(2, { detailTotal: 197715.43 })])

    expect(second).toMatchObject({ bills: 1, created: 0, updated: 1 })
    const bills = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bills).toHaveLength(1)
    expect(bills[0].amount.toFixed(2)).toBe('197715.43')
  })

  it('lets one check carry several bills', async () => {
    // One bill per cheque is a property of the 4 September snapshot, not of the
    // domain: the register carries cheques settling several bills, and
    // `CheckBill` is correctly one-to-many. Nothing here may harden the
    // snapshot's one-to-one shape into a constraint.
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([
      billRow(2, { referenceNbr: 'AP-ST036371' }),
      billRow(3, { referenceNbr: 'AP-ST036372' }),
    ])

    const bills = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bills.map((b) => b.apvNumber).sort()).toEqual(['AP-ST036371', 'AP-ST036372'])
  })

  it('sends a bill whose check is not imported to review, not the bin', async () => {
    // Not an error: the cheque may be staged for want of a company, or simply
    // absent from the register. This file is a snapshot and says nothing about
    // a cheque's absence.
    const summary = await run([billRow(2, { checkNo: 6000999999 })])

    expect(summary).toMatchObject({ bills: 1, created: 0, updated: 0 })
    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'NO_MATCHING_CHECK', checkNumber: '6000999999', row: 2 }),
    ])
    expect(await testDb.checkBill.count()).toBe(0)
  })

  it('sends a check number claimed by two companies to review', async () => {
    await makeCheck({ checkNumber: '6000338925' })
    await makeCheck({ checkNumber: '6000338925' })
    const summary = await run([billRow(2)])

    expect(summary.unmatched[0]).toMatchObject({ reason: 'AMBIGUOUS_CHECK', checkNumber: '6000338925' })
    expect(await testDb.checkBill.count()).toBe(0)
  })

  it('never changes a check\'s release status', async () => {
    // FINANCE REMARKS is AVAILABLE on all 85 rows. It corroborates
    // READY_FOR_RELEASE; it does not instruct. Import never changes release
    // status (D4) and a bill import is an import.
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await run([billRow(2, { checkNo: Number(check.checkNumber) })])

    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.readyAt).toBeNull()
    expect(after.readyById).toBeNull()
    expect(after.availablePickupDate).toBeNull()
    expect(after.amount?.toFixed(2)).toBe(check.amount?.toFixed(2))
  })

  it('records the import in the check\'s audit trail as SYSTEM', async () => {
    const check = await makeCheck({ checkNumber: '6000338925' })
    await run([billRow(2)])

    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', action: 'bill_imported', userId: null })
  })
})

describe('importBills — a check No. cell that is not a check number', () => {
  beforeEach(resetDb)

  afterEach(async () => {
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  const NOW = new Date('2026-09-07T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review, sheets } = parseBillRows(rows)
    return importBills(testDb, { bills, review, sheets, now: NOW })
  }

  // The measured case, and the reason for the whole change: row 81 of the
  // 4 September LIST sheet holds the date 2026-08-13 where the cheque number
  // belongs. The cheque is fine — 6000353106, SIGNED, dated 2026-08-13, which
  // is the very date somebody typed into the wrong column — and it carries the
  // voucher AP-ST042652 in the register.
  const misKeyed = (row: number) => billRow(row, {
    checkNo: new Date('2026-08-13T00:00:00Z'),
    referenceNbr: 'AP-ST042652',
  })

  it('attaches the bill to the one check carrying its voucher', async () => {
    const check = await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    const summary = await run([misKeyed(81)])

    expect(summary).toMatchObject({ bills: 1, created: 1, resolvedByVoucher: 1 })
    expect(summary.unmatched).toHaveLength(0)
    const [bill] = await testDb.checkBill.findMany({ where: { checkId: check.id } })
    expect(bill.apvNumber).toBe('AP-ST042652')
  })

  it('says in the audit trail that it matched on the voucher, and on what basis', async () => {
    // Attaching a bill to a cheque on evidence other than the number printed
    // beside it is a decision somebody may have to defend to Finance. It never
    // happens silently.
    const check = await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    await run([misKeyed(81)])

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.details).toMatchObject({ matchedOn: 'APV', statedCheckRef: '2026-08-13' })
    expect(audit.remarks).toContain('AP-ST042652')
    expect(audit.remarks).toContain(BILL_CHECK_REF_RULING)
  })

  it('stages the row rather than guessing when the voucher names no check', async () => {
    await makeCheck({ checkNumber: '6000353106', apvNumbers: [] })
    const summary = await run([misKeyed(81)])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'NO_CHECK_NUMBER', row: 81, statedCheckRef: '2026-08-13' }),
    ])
  })

  it('stages the row rather than choosing when the voucher names two checks', async () => {
    // Two cheques carrying one voucher is a state the register can produce, and
    // a bill hung on the wrong one is a supplier told the wrong thing. A wrong
    // cheque is far worse than a staged row.
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    await makeCheck({ checkNumber: '6000353107', apvNumbers: ['AP-ST042652'] })
    const summary = await run([misKeyed(81)])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched[0]).toMatchObject({ reason: 'AMBIGUOUS_CHECK', row: 81 })
    expect(summary.unmatched[0].companies).toHaveLength(2)
  })

  // USER RULING 2026-10-29: a cancelled cheque is no longer connected to the AP
  // it was applied to, so it is never a match for a bill — by voucher or by number.
  it('resolves a voucher to the live re-issue when the other cheque carrying it is VOIDED', async () => {
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'], status: 'VOIDED' })
    const reissue = await makeCheck({ checkNumber: '6000353107', apvNumbers: ['AP-ST042652'] })
    const summary = await run([misKeyed(81)])

    expect(summary.unmatched).toEqual([])
    const [bill] = await testDb.checkBill.findMany()
    expect(bill.checkId).toBe(reissue.id)
  })

  it('stages a check number that names only a CANCELLED or VOIDED cheque as NO_MATCHING_CHECK', async () => {
    await makeCheck({ checkNumber: '6000338925', status: 'CANCELLED' })
    const summary = await run([billRow(2)])

    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'NO_MATCHING_CHECK', checkNumber: '6000338925', row: 2 }),
    ])
    expect(await testDb.checkBill.count()).toBe(0)
  })

  it('does not re-resolve a good check number that names no check', async () => {
    // The fallback is for a cell that holds no cheque number, and only that. A
    // perfectly good number naming no cheque here is not an invitation to
    // overrule the workbook on evidence it did not offer — the cheque is simply
    // not in this system yet.
    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-A1033419'] })
    const summary = await run([billRow(2, { checkNo: 6000999999 })])

    expect(await testDb.checkBill.count()).toBe(0)
    expect(summary.unmatched[0]).toMatchObject({
      reason: 'NO_MATCHING_CHECK', checkNumber: '6000999999',
    })
  })
})

describe('stageBills — the rows that did not attach', () => {
  beforeEach(resetDb)

  const NOW = new Date('2026-09-07T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review, sheets } = parseBillRows(rows)
    return importBills(testDb, { bills, review, sheets, now: NOW })
  }

  it('writes every refused row where somebody sees it', async () => {
    // The defect this whole change exists for. The importer already REPORTED
    // the mis-keyed cell — to a terminal, once, during a run nobody was
    // watching — and the next person to notice was going to be the supplier.
    const summary = await run([
      billRow(2, { checkNo: new Date('2026-08-13T00:00:00Z'), referenceNbr: 'AP-ST042652' }),
      billRow(3, { referenceNbr: null }),
      billRow(4, { detailTotal: null }),
    ])
    expect(summary.staged).toBe(3)

    const staged = await testDb.stagedBill.findMany({ orderBy: { sourceRow: 'asc' } })
    expect(staged.map((s) => [s.sourceRow, s.reason])).toEqual([
      [2, 'NO_CHECK_NUMBER'], [3, 'NO_APV'], [4, 'NO_AMOUNT'],
    ])
    expect(staged[0]).toMatchObject({
      sourceSheet: SHEET, statedCheckRef: '2026-08-13', apvNumber: 'AP-ST042652',
    })
  })

  it('is idempotent on the cell it points at', async () => {
    await run([billRow(2, { referenceNbr: null })])
    await run([billRow(2, { referenceNbr: null })])
    expect(await testDb.stagedBill.count()).toBe(1)
  })

  it('takes a row away once it attaches to a check', async () => {
    // Otherwise the queue only ever grows and a corrected cell never stops
    // being reported, which is how a queue stops being read.
    await run([misKeyedForClearing()])
    expect(await testDb.stagedBill.count()).toBe(1)

    await makeCheck({ checkNumber: '6000353106', apvNumbers: ['AP-ST042652'] })
    const second = await run([misKeyedForClearing()])

    expect(second.cleared).toBe(1)
    expect(await testDb.stagedBill.count()).toBe(0)
    expect(await testDb.checkBill.count()).toBe(1)
  })

  function misKeyedForClearing() {
    return billRow(81, {
      checkNo: new Date('2026-08-13T00:00:00Z'), referenceNbr: 'AP-ST042652',
    })
  }

  it('holds no amount and no vendor name', async () => {
    // Deliberate. This table is displayed beside one whose amounts are CHEQUE
    // amounts, and a bill's Detail Total sitting in that column would be read
    // as a cheque's figure sooner or later. The sheet, the row, the voucher and
    // what the cell actually said are what a human needs to fix a mis-keyed
    // cell; the rest is in the workbook.
    await run([billRow(2, { referenceNbr: null })])
    const [staged] = await testDb.stagedBill.findMany()
    expect(Object.keys(staged)).not.toContain('amount')
    expect(Object.keys(staged)).not.toContain('payeeName')
  })
})

// The 7 September workbook: two data sheets and a pivot, 238 bills, 50 rows
// whose `check No.` cell holds a date, and two vouchers that appear on both
// data sheets.
describe('importBills — a workbook of several sheets', () => {
  beforeEach(resetDb)

  afterEach(async () => {
    expect(await testDb.portalEvent.count()).toBe(0)
  })

  const NOW = new Date('2026-09-07T13:32:00+08:00')

  async function run(rows: RawRow[]) {
    const { bills, review, sheets } = parseBillRows(rows)
    return importBills(testDb, { bills, review, sheets, now: NOW })
  }

  it('imports from both data sheets and reports what came from where', async () => {
    await makeCheck({ checkNumber: '6000338925' })
    await makeCheck({ checkNumber: '6000353377' })

    const summary = await run([
      pivotRow(2),
      billRow(2),
      billRow(9, { checkNo: 6000353377, referenceNbr: 'AP-ST043131' }, BROKERAGE),
    ])

    expect(summary).toMatchObject({ bills: 2, created: 2, updated: 0 })
    expect(summary.sheets).toEqual([
      { sheet: 'Sheet3', rows: 1, read: false, bills: 0, review: 0 },
      { sheet: SHEET, rows: 1, read: true, bills: 1, review: 0 },
      { sheet: BROKERAGE, rows: 1, read: true, bills: 1, review: 0 },
    ])
  })

  it('records which sheet a bill came from, so a broker check stays identifiable', async () => {
    // The supplier portal exposes broker cheques on
    // `POST /api/broker-checks/mark-available`, separately from
    // `POST /api/checks/mark-available`. Nothing routes on this yet — that is
    // Plan 3, blocked on the portal's encoder account — but the evidence for
    // routing later must survive today's import.
    const check = await makeCheck({ checkNumber: '6000353377' })
    await run([billRow(9, { checkNo: 6000353377, referenceNbr: 'AP-ST043131' }, BROKERAGE)])

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: check.id } })
    expect(audit.details).toMatchObject({ sourceSheet: BROKERAGE, sourceRow: 9 })
    expect(audit.remarks).toContain(BROKERAGE)
  })

  it('folds a voucher that appears on both sheets onto one bill', async () => {
    // Measured on the 7 September workbook: `local supplier` and `BROKERAGE`
    // share exactly two vouchers, and both name the SAME cheque. The
    // `(checkId, apvNumber)` unique index is what makes that a duplicate rather
    // than a conflict — the second row updates the first — and both rows leave
    // their own audit entry naming their own sheet.
    const check = await makeCheck({ checkNumber: '6000353377' })
    const summary = await run([
      billRow(215, { checkNo: 6000353377, referenceNbr: 'AP-ST043131' }),
      billRow(9, { checkNo: 6000353377, referenceNbr: 'AP-ST043131' }, BROKERAGE),
    ])

    expect(summary).toMatchObject({ bills: 2, created: 1, updated: 1 })
    expect(await testDb.checkBill.count()).toBe(1)
    const audit = await testDb.auditLog.findMany({ where: { checkId: check.id } })
    expect(audit.map((a) => (a.details as { sourceSheet: string }).sourceSheet).sort())
      .toEqual([BROKERAGE, SHEET])
  })

  it('stages the same row number on two sheets separately', async () => {
    // `StagedBill` is keyed on `(sourceSheet, sourceRow)`. Row 6 of
    // `local supplier` and row 6 of `BROKERAGE` are different cells, and a key
    // that collided them would hide one behind the other.
    const summary = await run([
      billRow(6, { referenceNbr: null }),
      billRow(6, { referenceNbr: null }, BROKERAGE),
    ])

    expect(summary.staged).toBe(2)
    const staged = await testDb.stagedBill.findMany({ orderBy: { sourceSheet: 'asc' } })
    expect(staged.map((s) => s.sourceSheet)).toEqual([BROKERAGE, SHEET])
  })

  // 150 seconds, against the file default of 30 and the run default of 60.
  //
  // Not a flake and not papering over one. This test drives 50 bill rows through
  // the voucher fallback one at a time, and each is several round trips to Neon in
  // ap-southeast-1 — it measured 62.7s under full-suite load on 2026-09-10 and
  // 41s running alone, so it sits either side of the 60s ceiling depending on what
  // else is talking to the database. Passing alone and failing in the suite is the
  // worst kind of red: it teaches you to re-run rather than to read.
  //
  // Fifty is the real number from the 7 September workbook, so shrinking the
  // fixture would be dropping the thing the test exists to prove.
  it('resolves fifty mis-keyed rows one at a time, and still refuses a tie', async () => {
    // The voucher fallback was written for ONE row. The 7 September workbook
    // has 50 across two sheets. Scale changes nothing: each row is resolved on
    // its own voucher, and the "exactly one cheque, or stage it" rule is the
    // same rule. Fifty rows wanting to resolve is not a reason to relax it.
    const DATE_CELL = new Date('2026-08-13T00:00:00Z')
    const vouchers = Array.from({ length: 50 }, (_, i) => `AP-ST04${3000 + i}`)
    for (const [i, apv] of vouchers.entries()) {
      await makeCheck({ checkNumber: `60003530${String(i).padStart(2, '0')}`, apvNumbers: [apv] })
    }
    // And one voucher two cheques carry, which is not a tie to break.
    await makeCheck({ checkNumber: '6000359001', apvNumbers: ['AP-ST049999'] })
    await makeCheck({ checkNumber: '6000359002', apvNumbers: ['AP-ST049999'] })

    const rows = vouchers.map((apv, i) =>
      billRow(i + 2, { checkNo: DATE_CELL, referenceNbr: apv }, i % 2 ? BROKERAGE : SHEET),
    )
    rows.push(billRow(200, { checkNo: DATE_CELL, referenceNbr: 'AP-ST049999' }))

    const summary = await run(rows)

    expect(summary).toMatchObject({ bills: 51, created: 50, resolvedByVoucher: 50 })
    expect(await testDb.checkBill.count()).toBe(50)
    expect(summary.unmatched).toEqual([
      expect.objectContaining({ reason: 'AMBIGUOUS_CHECK', row: 200, apvNumber: 'AP-ST049999' }),
    ])
    // Each landed on the cheque carrying its own voucher, not on whichever one
    // the query happened to return first.
    for (const [i, apv] of vouchers.entries()) {
      const bill = await testDb.checkBill.findFirstOrThrow({
        where: { apvNumber: apv }, include: { check: true },
      })
      expect(bill.check.checkNumber).toBe(`60003530${String(i).padStart(2, '0')}`)
    }
  }, 150_000)
})
