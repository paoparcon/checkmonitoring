import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildAgingWorkbook, agingFilename, SUMMARY_SHEET, AGING_HEADERS } from '@/lib/export/aging-workbook'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', status: 'SIGNED', ...o,
})

async function load(rows: AgingRow[], truncated?: boolean) {
  const buf = await buildAgingWorkbook({ truncated, rows, generatedAt: new Date('2026-10-15T10:00:00+08:00'), generatedBy: 'Paolo Parcon' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(new Uint8Array(buf).buffer)
  return wb
}

const BUCKET_LABELS = ['CURRENT', '1–30 DAYS', '31–60 DAYS', '61–90 DAYS', 'OVER 90 DAYS', 'NO DUE DATE']

// Column number (1-based) of a header, read off the header row.
function col(sheet: ExcelJS.Worksheet, header: string): number {
  const i = (sheet.getRow(1).values as unknown[]).indexOf(header)
  expect(i).toBeGreaterThan(0)
  return i
}
const blank = (v: unknown) => v === null || v === undefined || v === ''

describe('buildAgingWorkbook', () => {
  it('writes an unreadable amount as an empty cell, not 0', async () => {
    const wb = await load([row({ amount: '1,000.00' })])
    const sheet = wb.getWorksheet('1–30 DAYS')!
    expect(blank(sheet.getRow(2).getCell(col(sheet, '1–30 DAYS')).value)).toBe(true)
  })

  it('orders sheets SUMMARY, ALL CHECKS, then non-empty buckets', async () => {
    const wb = await load([row({ id: 'a', bucket: 'b90plus' }), row({ id: 'b', bucket: 'current' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, 'ALL CHECKS', 'CURRENT', 'OVER 90 DAYS'])
  })

  it('puts a row amount only under its own bucket column', async () => {
    const wb = await load([row({})])
    const sheet = wb.getWorksheet('ALL CHECKS')!
    for (const label of BUCKET_LABELS) {
      const v = sheet.getRow(2).getCell(col(sheet, label)).value
      if (label === '1–30 DAYS') expect(v).toBe(1000.1)
      else expect(blank(v)).toBe(true)
    }
  })

  it('TOTAL (PHP) sums PHP centavos per bucket and excludes other currencies', async () => {
    const wb = await load([
      row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' }),
      row({ id: 'c', amount: '99.00', currency: 'USD' }),
    ])
    const sheet = wb.getWorksheet('ALL CHECKS')!
    const total = sheet.getRow(sheet.rowCount)
    expect(total.getCell(1).value).toBe('TOTAL (PHP)')
    expect(total.getCell(col(sheet, '1–30 DAYS')).value).toBe(0.3)
    expect(blank(total.getCell(col(sheet, 'CURRENT')).value)).toBe(true)
    const usd = [2, 3, 4].map((n) => sheet.getRow(n)).find((r) => r.getCell(col(sheet, 'CURRENCY')).value === 'USD')!
    expect(usd.getCell(col(sheet, '1–30 DAYS')).value).toBe(99)
  })

  it('a bucket sheet uses the same layout and its own TOTAL row', async () => {
    const wb = await load([row({ id: 'a', amount: '1.00' }), row({ id: 'b', bucket: 'current', amount: '5.00' })])
    const sheet = wb.getWorksheet('CURRENT')!
    expect(sheet.getRow(1).values).toEqual([undefined, ...AGING_HEADERS])
    expect(sheet.rowCount).toBe(3)
    expect(sheet.getRow(3).getCell(col(sheet, 'CURRENT')).value).toBe(5)
  })

  it('says CAPPED on SUMMARY only when the list was truncated', async () => {
    const text = async (t: boolean) => (await load([row({})], t)).getWorksheet(SUMMARY_SHEET)!
      .getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(await text(true)).toContain('CAPPED')
    expect(await text(false)).not.toContain('CAPPED')
  })

  it('STATUS is the second header and reads SIGNED or READY FOR RELEASE', async () => {
    expect(AGING_HEADERS[1]).toBe('STATUS')
    const wb = await load([row({ id: 'a' }), row({ id: 'b', checkNumber: '6000000002', status: 'READY_FOR_RELEASE' })])
    const sheet = wb.getWorksheet('ALL CHECKS')!
    expect(col(sheet, 'STATUS')).toBe(2)
    expect([2, 3].map((n) => sheet.getRow(n).getCell(2).value).sort()).toEqual(['READY FOR RELEASE', 'SIGNED'])
    expect(col(wb.getWorksheet('1–30 DAYS')!, 'STATUS')).toBe(2)
  })

  it('says it covers SIGNED and READY FOR RELEASE checks, and totals each bucket in centavos', async () => {
    const wb = await load([row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' })])
    const summary = wb.getWorksheet(SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('AGING — SIGNED AND READY FOR RELEASE CHECKS')
    const b30 = (summary.getColumn(1).values as unknown[]).indexOf('1–30 DAYS')
    expect(summary.getRow(b30).getCell(2).value).toBe(2)
    expect(summary.getRow(b30).getCell(3).value).toBe(0.3)
  })

  it('writes the table columns on a bucket sheet', async () => {
    const wb = await load([row({})])
    const sheet = wb.getWorksheet('1–30 DAYS')!
    expect(sheet.getRow(1).values).toEqual([undefined, ...AGING_HEADERS])
    expect(sheet.getRow(2).getCell(1).value).toBe('6000000001')
    expect([...AGING_HEADERS].slice(-6)).toEqual(BUCKET_LABELS)
  })

  it('names the file by the Manila day', () => {
    expect(agingFilename(new Date('2026-10-15T00:30:00+08:00'))).toBe('AGING 2026-10-15.xlsx')
  })
})
