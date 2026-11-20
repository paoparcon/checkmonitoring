import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  ARRIVAL_MARKER, PAYMENTS_ALL_SHEET, PAYMENTS_SUMMARY_SHEET, PAYMENT_HEADERS, TOTAL_LABEL, buildPaymentsWorkbook, paymentsFilename,
} from '@/lib/export/payments-workbook'
import type { PaymentRow } from '@/lib/payments/query'
import { paymentRow } from '../helpers/payment-row'

async function load(rows: PaymentRow[]) {
  const buf = await buildPaymentsWorkbook({ rows, generatedAt: new Date('2026-11-20T10:00:00+08:00'), generatedBy: 'Paolo Parcon' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(new Uint8Array(buf).buffer)
  return wb
}
const col = (h: string) => PAYMENT_HEADERS.indexOf(h as (typeof PAYMENT_HEADERS)[number]) + 1
const blank = (v: unknown) => v === null || v === undefined || v === ''

/** The row of a summary block whose first cell is `label`, after the block's caption. */
function line(ws: ExcelJS.Worksheet, caption: string, label: string): ExcelJS.Row {
  let inBlock = false
  for (let r = 1; r <= ws.rowCount; r++) {
    const first = ws.getRow(r).getCell(1).value
    if (first === caption) inBlock = true
    else if (inBlock && first === label) return ws.getRow(r)
  }
  throw new Error(`no ${label} line under ${caption}`)
}
function header(ws: ExcelJS.Worksheet, caption: string): unknown[] {
  for (let r = 1; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value === caption) return ws.getRow(r + 1).values as unknown[]
  throw new Error(`no ${caption} block`)
}

const ROWS = [
  paymentRow({ id: 'a', referenceNbr: 'CV-1', amount: '1000.10', currency: 'USD', paymentDate: '2026-05-12' }),
  paymentRow({ id: 'b', referenceNbr: 'CV-2', amount: '2000.20', currency: 'CNY', paymentDate: '2026-05-20', marking: 'PROCESSED', display: 'PROCESSED', processedDate: '2026-05-21', markedBy: 'Trisha' }),
  paymentRow({ id: 'c', referenceNbr: 'CV-3', amount: '0.05', currency: 'USD', paymentDate: '2026-06-01', marking: 'CLEARED', display: 'CLEARED', clearedDate: '2026-06-03' }),
  paymentRow({ id: 'd', referenceNbr: 'CV-4', amount: '999.00', currency: 'USD', paymentDate: '2026-06-02', voided: true, display: 'CANCELLED' }),
  paymentRow({ id: 'e', referenceNbr: 'CV-5', amount: '877000.00', currency: 'PHP', paymentDate: '2026-05-05', method: 'MC', methodLabel: "MANAGER'S CHECK" }),
  paymentRow({ id: 'f', referenceNbr: 'CV-6', amount: null, currency: 'USD', paymentDate: null }),
]

describe('buildPaymentsWorkbook', () => {
  it('names the file by the Manila day', () => {
    expect(paymentsFilename(new Date('2026-11-19T17:00:00Z'))).toBe('OTHER PAYMENTS 2026-11-20.xlsx')
  })

  it('has the summary, every payment, and a sheet per method that has one', async () => {
    const wb = await load(ROWS)
    expect(wb.worksheets.map((w) => w.name)).toEqual([PAYMENTS_SUMMARY_SHEET, PAYMENTS_ALL_SHEET, 'TELEGRAPHIC TRANSFER', "MANAGER'S CHECK"])
    expect((wb.getWorksheet(PAYMENTS_ALL_SHEET)!.getRow(1).values as unknown[]).slice(1)).toEqual([...PAYMENT_HEADERS])
  })

  it('totals each currency on its own and leaves CANCELLED out of every amount', async () => {
    const ws = (await load(ROWS)).getWorksheet(PAYMENTS_SUMMARY_SHEET)!
    const head = header(ws, 'BY MARKING')
    const usd = head.indexOf('AMOUNT USD')
    const cny = head.indexOf('AMOUNT CNY')
    const php = head.indexOf('AMOUNT PHP')
    expect(usd).toBeGreaterThan(0)
    expect(line(ws, 'BY MARKING', 'ON PROCESS').getCell(2).value).toBe(3)
    expect(line(ws, 'BY MARKING', 'ON PROCESS').getCell(usd).value).toBe(1000.1)
    expect(line(ws, 'BY MARKING', 'ON PROCESS').getCell(php).value).toBe(877000)
    expect(line(ws, 'BY MARKING', 'PROCESSED').getCell(cny).value).toBe(2000.2)
    expect(blank(line(ws, 'BY MARKING', 'PROCESSED').getCell(usd).value)).toBe(true)
    const cancelled = line(ws, 'BY MARKING', 'CANCELLED')
    expect(cancelled.getCell(2).value).toBe(1)
    expect(blank(cancelled.getCell(usd).value)).toBe(true)
    const total = line(ws, 'BY MARKING', TOTAL_LABEL)
    expect(total.getCell(2).value).toBe(5)
    expect(total.getCell(usd).value).toBe(1000.15)
    expect(total.getCell(usd).numFmt).toContain('$')
    expect(total.getCell(cny).numFmt).toContain('¥')
  })

  it('counts each marking per method and lists the months', async () => {
    const ws = (await load(ROWS)).getWorksheet(PAYMENTS_SUMMARY_SHEET)!
    const head = header(ws, 'BY METHOD')
    const tt = line(ws, 'BY METHOD', 'TELEGRAPHIC TRANSFER')
    expect(tt.getCell(2).value).toBe(5)
    expect(tt.getCell(head.indexOf('ON PROCESS')).value).toBe(2)
    expect(tt.getCell(head.indexOf('CANCELLED')).value).toBe(1)
    expect(line(ws, 'BY METHOD', "MANAGER'S CHECK").getCell(2).value).toBe(1)
    expect(line(ws, 'BY PAYMENT MONTH', 'May 2026').getCell(2).value).toBe(3)
    expect(line(ws, 'BY PAYMENT MONTH', '(NO PAYMENT DATE)').getCell(2).value).toBe(1)
  })

  it('writes dates as dates, an unknown amount as blank, and who marked it', async () => {
    const ws = (await load(ROWS)).getWorksheet(PAYMENTS_ALL_SHEET)!
    const find = (cv: string) => {
      for (let r = 2; r <= ws.rowCount; r++) if (ws.getRow(r).getCell(1).value === cv) return ws.getRow(r)
      throw new Error(cv)
    }
    expect(find('CV-2').getCell(col('PAYMENT DATE')).value).toEqual(new Date('2026-05-20T00:00:00Z'))
    expect(find('CV-2').getCell(col('PROCESSED ON')).value).toEqual(new Date('2026-05-21T00:00:00Z'))
    expect(find('CV-2').getCell(col('MARKED BY')).value).toBe('Trisha')
    expect(find('CV-1').getCell(col('MARKED BY')).value).toBe(ARRIVAL_MARKER)
    expect(find('CV-1').getCell(col('AMOUNT')).value).toBe(1000.1)
    expect(find('CV-1').getCell(col('AMOUNT')).numFmt).toContain('$')
    expect(blank(find('CV-6').getCell(col('AMOUNT')).value)).toBe(true)
    expect(blank(find('CV-6').getCell(col('PAYMENT DATE')).value)).toBe(true)
    expect(find('CV-4').getCell(col('MARKING')).value).toBe('CANCELLED')
  })

  it('puts a total per currency under the list, excluding CANCELLED', async () => {
    const ws = (await load(ROWS)).getWorksheet('TELEGRAPHIC TRANSFER')!
    const totals = new Map<string, unknown>()
    for (let r = 2; r <= ws.rowCount; r++) {
      const label = ws.getRow(r).getCell(4).value
      if (typeof label === 'string' && label.startsWith(TOTAL_LABEL)) totals.set(String(ws.getRow(r).getCell(col('CURRENCY')).value), ws.getRow(r).getCell(col('AMOUNT')).value)
    }
    expect(totals.get('USD')).toBe(1000.15)
    expect(totals.get('CNY')).toBe(2000.2)
    expect(totals.has('PHP')).toBe(false)
  })

  it('builds for no payments at all', async () => {
    const wb = await load([])
    expect(wb.worksheets.map((w) => w.name)).toEqual([PAYMENTS_SUMMARY_SHEET, PAYMENTS_ALL_SHEET])
  })
})
