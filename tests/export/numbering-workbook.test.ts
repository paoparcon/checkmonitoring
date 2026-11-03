// tests/export/numbering-workbook.test.ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  buildNumberingWorkbook, sheetNameFor, NUMBERING_SUMMARY_SHEET, NUMBERING_ACCOUNT_HEADERS, NUMBERING_TO_FIX_SHEET, NUMBERING_TO_FIX_HEADERS,
} from '@/lib/export/numbering-workbook'
import { buildSeries, type AccountSeries, type SeriesCheque, type SeriesStaged } from '@/lib/numbering/series'
import { toInventoryLines, inventoryCounts, type InventoryNote } from '@/lib/numbering/inventory'
import type { NumberingAccount } from '@/lib/numbering/query'

const ch = (n: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
  ({ id: `id-${n}`, checkNumber: n, checkDate: new Date('2026-09-01T00:00:00Z'), payeeName: 'HENKEL', amount: '197715.42', currency: 'PHP', status, cv: `CV-${n}` })
/** A NumberingAccount as the query builds one: the series plus its inventory lines (spec §H). */
const withLines = (
  a: { accountId: string; account: string; bank: string; company: string; series: AccountSeries }, notes: InventoryNote[] = [],
): NumberingAccount => {
  const lines = toInventoryLines(a.series.entries, notes)
  return { ...a, lines, inventory: inventoryCounts(lines) }
}
const account = (code: string, cheques: SeriesCheque[], notes: InventoryNote[] = []): NumberingAccount =>
  withLines({ accountId: `acc-${code}`, account: code, bank: 'BPI', company: 'STK', series: buildSeries(cheques) }, notes)
const note = (checkNumber: string, o: Partial<InventoryNote> = {}): InventoryNote =>
  ({ checkNumber, runTo: null, ticked: true, remarks: 'spoiled form', updatedAt: new Date('2026-11-03T02:00:00Z'), updatedBy: 'Ana', ...o })
const META = { generatedAt: new Date('2026-10-01T02:00:00Z'), generatedBy: 'Paolo Parcon', filterDescription: 'No filters applied', missingOnly: false, noAccountCount: 3, registerOnlyCount: 5, rowLimit: 50_000 }

async function load(buf: ArrayBuffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

describe('sheetNameFor', () => {
  it('strips the characters Excel refuses, caps at 31, and de-duplicates case-insensitively', () => {
    const used = new Set(['SUMMARY'])
    expect(sheetNameFor('BPI/STK [1]', used)).toBe('BPI STK  1')
    expect(sheetNameFor('summary', used)).toBe('summary (2)')
    const long = 'X'.repeat(40)
    expect(sheetNameFor(long, used)).toHaveLength(31)
    expect(sheetNameFor(long, used)).toBe(`${'X'.repeat(27)} (2)`)
  })
})

describe('sheetNameFor apostrophes', () => {
  it('never starts or ends with an apostrophe', () => {
    expect(sheetNameFor("'X'", new Set())).toBe('X')
    expect(sheetNameFor("''", new Set())).toBe('ACCOUNT')
  })
})

describe('buildNumberingWorkbook', () => {
  it('sets an auto-filter over the header and every written row', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101'), ch('104')])], meta: META }))
    const af = wb.getWorksheet('BPI STK')!.autoFilter
    expect(af).toBe('A1:N5') // header, 101, 102 MISSING, 103 MISSING, 104
  })

  it('writes a null amount as an empty cell and a real amount as a number', async () => {
    const noAmount = { ...ch('5'), amount: null }
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [noAmount, ch('6')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(2).getCell(6).value ?? null).toBeNull()
    expect(ws.getRow(3).getCell(6).value).toBe(197715.42)
  })

  it('notes DUPLICATE NUMBER on both checks sharing a number', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('8'), { ...ch('8'), id: 'id-8b' }])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(2).getCell(10).value).toBe('DUPLICATE NUMBER')
    expect(ws.getRow(3).getCell(10).value).toBe('DUPLICATE NUMBER')
  })

  it('shades the NOTE cell of a MISSING row', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101'), ch('104')])], meta: META }))
    expect(wb.getWorksheet('BPI STK')!.getRow(3).getCell(10).fill).toMatchObject({ type: 'pattern' })
  })

  it('writes SUMMARY and one sheet per account, each MISSING number as its own row with FROM, TO and COUNT, numbers as text', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104', 'VOIDED')]), account('MBTC A1', [ch('7')])],
      meta: META,
    }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'BPI STK', 'MBTC A1'])

    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(1).values).toEqual([undefined, ...NUMBERING_ACCOUNT_HEADERS])
    expect(ws.getRow(2).getCell(1).value).toBe('101')
    expect(ws.getRow(3).getCell(1).value).toBe('102')
    expect(ws.getRow(3).getCell(4).value).toBe('MISSING')
    expect(ws.getRow(3).getCell(7).value).toBe('102')
    expect(ws.getRow(3).getCell(8).value).toBe('102')
    expect(ws.getRow(3).getCell(9).value).toBe(1)
    expect(ws.getRow(4).getCell(1).value).toBe('103')
    expect(ws.getRow(4).getCell(4).value).toBe('MISSING')
    expect(ws.getRow(5).getCell(4).value).toBe('VOIDED')

    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('BPI STK')
    expect(text).toContain('3 CHECKS WITH NO CHECK BOOK')
  })

  it('prints no "Not in any series" sentence when noAccountCount is null', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101')])],
      meta: { ...META, noAccountCount: null, registerOnlyCount: null },
    }))
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).not.toContain('Not in any series')
    expect(text).not.toContain('REGISTER-ONLY')
  })

  it('states the register-only count on A4, after the no-book sentence (spec §G2)', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101')])], meta: META }))
    const a4 = String(wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getCell('A4').value)
    expect(a4).toContain('5 REGISTER-ONLY CHECKS (NOT IN ACUMATICA) ARE NOT SHOWN.')
    expect(a4.indexOf('3 CHECKS WITH NO CHECK BOOK')).toBeLessThan(a4.indexOf('5 REGISTER-ONLY'))
    const one = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('101')])], meta: { ...META, registerOnlyCount: 1 } }))
    expect(String(one.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getCell('A4').value)).toContain('1 REGISTER-ONLY CHECK (NOT IN ACUMATICA) IS NOT SHOWN.')
  })

  it('missing-only keeps just the MISSING lines', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104')])],
      meta: { ...META, missingOnly: true },
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(3) // 102 and 103, one row each
    expect(ws.getRow(2).getCell(4).value).toBe('MISSING')
    expect(ws.getRow(3).getCell(4).value).toBe('MISSING')
  })

  it('missing-only writes no sheet for an account with nothing missing', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('FULL', [ch('101'), ch('102')]), account('GAPPY', [ch('201'), ch('204')])],
      meta: { ...META, missingOnly: true },
    }))
    expect(wb.getWorksheet('FULL')).toBeUndefined()
    expect(wb.getWorksheet('GAPPY')).toBeDefined()
    expect(wb.getWorksheet(NUMBERING_SUMMARY_SHEET)).toBeDefined()
  })

  it('lists non-numeric checks after the sequence', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [ch('5'), ch('MEMO')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(3).getCell(1).value).toBe('MEMO')
    expect(ws.getRow(3).getCell(10).value).toBe('NOT NUMERIC')
  })

  it('stops at the row limit and says so on SUMMARY', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('A', [ch('1'), ch('2'), ch('3')]), account('B', [ch('9')])],
      meta: { ...META, rowLimit: 2 },
    }))
    expect(wb.getWorksheet('A')!.rowCount).toBe(3)
    expect(wb.getWorksheet('B')).toBeUndefined()
    const text = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('first 2 of 4 lines')
  })
})

describe('the inventory columns (spec §H)', () => {
  it('writes the tick, remark, who and when (Manila) on a MISSING number row, and nothing on an unnoted one', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('104')], [note('102', { remarks: 'spoiled form' }), note('103', { ticked: false, remarks: null })])],
      meta: META,
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(NUMBERING_ACCOUNT_HEADERS.slice(10)).toEqual(['TICKED', 'REMARKS', 'RECORDED BY', 'RECORDED AT'])
    const r102 = ws.getRow(3)
    expect(r102.getCell(1).value).toBe('102')
    expect(r102.getCell(11).value).toBe('YES')
    expect(r102.getCell(12).value).toBe('spoiled form')
    expect(r102.getCell(13).value).toBe('Ana')
    expect(r102.getCell(14).value).toEqual(new Date('2026-11-03T10:00:00Z')) // 02:00Z shown as 10:00 Manila
    const r103 = ws.getRow(4)
    expect(r103.getCell(11).value).toBe('NO')
    expect(r103.getCell(12).value ?? null).toBeNull()
    const r101 = ws.getRow(2)
    expect(r101.getCell(11).value ?? null).toBeNull()
  })

  it('a run too long to list is one MISSING row carrying its run note, with the reason in NOTE', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('1'), ch('500')], [note('2', { runTo: '499', remarks: 'booklet in vault' })])],
      meta: META,
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(4)
    const run = ws.getRow(3)
    expect(run.getCell(1).value).toBe('2 – 499')
    expect(run.getCell(9).value).toBe(498)
    expect(String(run.getCell(10).value)).toContain('TOO LONG TO LIST')
    expect(run.getCell(11).value).toBe('YES')
    expect(run.getCell(12).value).toBe('booklet in vault')
  })

  it('a check holding a noted number shows its remark, NOTE untouched, and SUMMARY counts its tick', async () => {
    const wb = await load(await buildNumberingWorkbook({
      accounts: [account('BPI STK', [ch('101'), ch('102'), ch('105')], [note('101', { remarks: 'was missing' }), note('103'), note('104')])],
      meta: META,
    }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.getRow(2).getCell(10).value).toBeNull()
    expect(ws.getRow(2).getCell(11).value).toBe('YES')
    expect(ws.getRow(2).getCell(12).value).toBe('was missing')
    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const labels = Array.from({ length: 14 }, (_, i) => summary.getRow(6).getCell(i + 1).value)
    const col = labels.indexOf('TICKED') + 1
    expect(col).toBe(labels.indexOf('MISSING RUNS') + 2)
    expect(summary.getRow(7).getCell(col).value).toBe(3) // 101 (held), 103 and 104
  })
})

const stg = (ref: string, cv: string): SeriesStaged =>
  ({ acumaticaTenant: 'GOLIVE', acumaticaRef: cv, statedCheckRef: ref, checkDate: new Date('2026-09-02T00:00:00Z'), payeeName: 'HENKEL', amount: '500.00', currency: 'PHP' })

describe('STAGED lines', () => {
  it('writes a STAGED row with the stated reference verbatim and the CV in NOTE', async () => {
    const acc = withLines({ accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101'), ch('103')], [stg('102.', 'CV-ST000102')]) })
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    const row = ws.getRow(3)
    expect(row.getCell(1).value).toBe('102.')
    expect(row.getCell(4).value).toBe('STAGED')
    expect(row.getCell(6).value).toBe(500)
    expect(String(row.getCell(10).value)).toContain('CV-ST000102')
    expect(ws.rowCount).toBe(4) // header, 101, STAGED 102, 103 — no MISSING line
  })

  it('an out-of-pattern check is written after the sequence with its note, and SUMMARY counts it', async () => {
    const inPattern = Array.from({ length: 25 }, (_, i) => ch(String(6000100000 + i)))
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('BPI STK', [...inPattern, ch('1791361374')])], meta: META }))
    const ws = wb.getWorksheet('BPI STK')!
    expect(ws.rowCount).toBe(27) // header, 25 in sequence, 1 out of pattern — no MISSING line
    expect(ws.getRow(27).getCell(1).value).toBe('1791361374')
    expect(ws.getRow(27).getCell(10).value).toBe('OUT OF PATTERN (expected 10 digits starting 60)')
    expect(ws.getRow(26).getCell(1).value).toBe('6000100024')

    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const labels = Array.from({ length: 14 }, (_, i) => summary.getRow(6).getCell(i + 1).value)
    const col = labels.indexOf('OUT OF PATTERN') + 1
    expect(col).toBe(labels.indexOf('NOT NUMERIC') + 2)
    expect(summary.getRow(7).getCell(col).value).toBe(1)
  })

  it('SUMMARY carries a STAGED column', async () => {
    const acc = withLines({ accountId: 'acc-X', account: 'BPI STK', bank: 'BPI', company: 'STK', series: buildSeries([ch('101')], [stg('102.', 'CV-1'), stg('102..', 'CV-2')]) })
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const header = summary.getRow(6)
    const labels = Array.from({ length: 12 }, (_, i) => header.getCell(i + 1).value)
    const col = labels.indexOf('STAGED') + 1
    expect(col).toBeGreaterThan(0)
    expect(summary.getRow(7).getCell(col).value).toBe(2)
  })
})

describe('TO FIX IN ACUMATICA (spec §G3)', () => {
  /** BPI STK: 25 in pattern (6000100000..24), a stray first 6000000001, one cheque and one staged line out of pattern. */
  function toFixBook(): NumberingAccount {
    const inPattern = Array.from({ length: 25 }, (_, i) => ch(String(6000100000 + i)))
    return withLines({
      accountId: 'acc-BPI', account: 'BPI STK', bank: 'BPI', company: 'STK',
      series: buildSeries([ch('6000000001'), ...inPattern, ch('1791361374', 'VOIDED')], [stg('1791361375.', 'CV-ST000777')]),
    })
  }
  const rowsOf = (ws: ExcelJS.Worksheet) =>
    Array.from({ length: ws.rowCount - 1 }, (_, i) => Array.from({ length: 7 }, (_, c) => ws.getRow(i + 2).getCell(c + 1).value))

  it('sits right after SUMMARY with its header, and lists every entry newest check date first, each with its CV', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [toFixBook(), account('MBTC A1', [ch('7')])], meta: META }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'BPI STK', 'MBTC A1'])
    const ws = wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!
    expect(ws.getRow(1).values).toEqual([undefined, ...NUMBERING_TO_FIX_HEADERS])
    expect(NUMBERING_TO_FIX_HEADERS).toEqual(['CHECK BOOK', 'CHECK NUMBER', 'CV', 'CHECK DATE', 'PAYEE', 'STATUS', 'REASON'])
    const sept1 = new Date('2026-09-01T00:00:00Z')
    const sept2 = new Date('2026-09-02T00:00:00Z')
    // Newest cheque date first; on the same date, by cheque book, then cheque number.
    expect(rowsOf(ws)).toEqual([
      ['BPI STK', '1791361375.', 'CV-ST000777', sept2, 'HENKEL', 'STAGED', 'OUT OF PATTERN — expected 10 digits starting 60'],
      ['BPI STK', '1791361374', 'CV-1791361374', sept1, 'HENKEL', 'VOIDED', 'OUT OF PATTERN — expected 10 digits starting 60'],
      ['BPI STK', '6000000001', 'CV-6000000001', sept1, 'HENKEL', 'RELEASED', 'STRAY FIRST NUMBER — next is 99999 higher'],
    ])
    expect(ws.autoFilter).toBe('A1:G4')
  })

  it('sorts across check books newest first, with an undated check last (user request 2026-10-06)', async () => {
    const dated = (n: string, day: string | null, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque =>
      ({ ...ch(n, status), checkDate: day ? new Date(`${day}T00:00:00Z`) : null })
    const inPattern = (base: number) => Array.from({ length: 25 }, (_, i) => ch(String(base + i)))
    const older: NumberingAccount = withLines({
      accountId: 'acc-A', account: 'AAA BOOK', bank: 'BPI', company: 'STK',
      series: buildSeries([...inPattern(6000100000), dated('1791000001', '2026-02-10'), dated('1791000002', null)]),
    })
    const newer: NumberingAccount = withLines({
      accountId: 'acc-Z', account: 'ZZZ BOOK', bank: 'BPI', company: 'STK',
      series: buildSeries([...inPattern(6000200000), dated('1791000003', '2026-10-05', 'SIGNATURE_PENDING')]),
    })
    const wb = await load(await buildNumberingWorkbook({ accounts: [older, newer], meta: META }))
    const numbers = rowsOf(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!).map((r) => r[1])
    expect(numbers).toEqual(['1791000003', '1791000001', '1791000002'])
  })

  it('is written in full under MISSING ONLY and past the row limit', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [toFixBook()], meta: { ...META, missingOnly: true, rowLimit: 1 } }))
    expect(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!.rowCount).toBe(4)
  })

  it('holds only its header when there is nothing to fix, and its name is never reused by a book', async () => {
    const wb = await load(await buildNumberingWorkbook({ accounts: [account('TO FIX IN ACUMATICA', [ch('1'), ch('2')])], meta: META }))
    expect(wb.worksheets.map((w) => w.name)).toEqual([NUMBERING_SUMMARY_SHEET, NUMBERING_TO_FIX_SHEET, 'TO FIX IN ACUMATICA (2)'])
    expect(wb.getWorksheet(NUMBERING_TO_FIX_SHEET)!.rowCount).toBe(1)
  })
})

describe('NO CHECK BOOK (spec §I)', () => {
  it('writes the placed check as a row with its NOTE, counts it on SUMMARY, and A4 says how many are shown', async () => {
    const unbooked: SeriesCheque = { ...ch('102', 'SIGNED'), cashAccount: 'PAYROLL' }
    const acc = withLines({ accountId: 'acc-1', account: 'MBT-A-9048', bank: 'MBTC', company: 'A1+', series: buildSeries([ch('101'), ch('104')], [], [unbooked]) })
    const wb = await load(await buildNumberingWorkbook({ accounts: [acc], meta: META }))
    const ws = wb.getWorksheet('MBT-A-9048')!
    expect(ws.getRow(3).getCell(1).value).toBe('102')
    expect(ws.getRow(3).getCell(4).value).toBe('SIGNED')
    expect(ws.getRow(3).getCell(10).value).toBe('NO CHECK BOOK — Acumatica cash account PAYROLL; shown where its number falls')
    expect(ws.getRow(4).getCell(4).value).toBe('MISSING')
    const summary = wb.getWorksheet(NUMBERING_SUMMARY_SHEET)!
    const labels = Array.from({ length: 15 }, (_, i) => summary.getRow(6).getCell(i + 1).value)
    expect(labels[14]).toBe('NO CHECK BOOK')
    expect(summary.getRow(7).getCell(15).value).toBe(1)
    expect(summary.getRow(7).getCell(10).value).toBe(1) // MISSING NUMBERS: 103 only
    const a4 = String(summary.getCell('A4').value)
    expect(a4).toContain('3 CHECKS WITH NO CHECK BOOK (ACUMATICA POSTED THEM ON A CASH ACCOUNT SUCH AS PAYROLL): 1 SHOWN IN THE SERIES ITS NUMBER FALLS IN')
  })
})
