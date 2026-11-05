import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import {
  candidateNumbers, numericDateOrder, datesOnLine, amountOnLine, readClearingFile, type TextUnit,
} from '@/lib/clearing-upload'
import { tinyPdf } from './helpers/tiny-pdf'

const NOW = new Date('2026-11-05T00:00:00Z')
const unit = (text: string, extra: Partial<TextUnit> = {}): TextUnit => ({ place: 'line 1', text, dates: [], numbers: [], ...extra })
const day = (d: Date | undefined) => d?.toISOString().slice(0, 10)

describe('candidateNumbers', () => {
  it('takes 6-13 digit numbers standing alone, bank prefix and NO. included', () => {
    expect(candidateNumbers('11/03/2026 | BPI 6000354602 | CHK NO.1791404779 | 179174')).toEqual(['6000354602', '1791404779', '179174'])
  })

  it('reads a number between CSV commas', () => {
    expect(candidateNumbers('2026-11-03,6000000001,5000.00')).toEqual(['6000000001'])
  })

  it('leaves amounts, dates, references and words alone', () => {
    expect(candidateNumbers('1234567.89  1,234,567.89  2026-11-03  CV-ST021234  AP-ST045103  ACCT1234567  12345')).toEqual([])
  })
})

describe('dates on a line', () => {
  it('reads the numeric order the file settles, and refuses one nobody can settle', () => {
    const dmy = [unit('25/10/2026 6000000001'), unit('03/11/2026 6000000002')]
    expect(numericDateOrder(dmy)).toBe('DMY')
    expect(day(datesOnLine(dmy[1], 'DMY', NOW)[0])).toBe('2026-11-03')
    const mdy = [unit('10/25/2026'), unit('11/03/2026')]
    expect(numericDateOrder(mdy)).toBe('MDY')
    expect(day(datesOnLine(mdy[1], 'MDY', NOW)[0])).toBe('2026-11-03')
    expect(numericDateOrder([unit('11/03/2026')])).toBeNull()
    expect(datesOnLine(unit('11/03/2026'), null, NOW)).toEqual([])
  })

  it('reads ISO, a month spelled out and an Excel date cell without asking', () => {
    expect(day(datesOnLine(unit('2026-11-03 x'), null, NOW)[0])).toBe('2026-11-03')
    expect(day(datesOnLine(unit('03-Nov-2026 x'), null, NOW)[0])).toBe('2026-11-03')
    expect(day(datesOnLine(unit('Nov 3, 2026 x'), null, NOW)[0])).toBe('2026-11-03')
    const cell = new Date(Date.UTC(2026, 10, 3))
    expect(day(datesOnLine(unit('2026-11-03 | 6000000001', { dates: [cell] }), null, NOW)[0])).toBe('2026-11-03')
  })

  it('gives two different dates back as two, so the line takes none of them', () => {
    expect(datesOnLine(unit('2026-11-02 | 2026-11-03 | 6000000001'), null, NOW)).toHaveLength(2)
  })
})

describe('amountOnLine', () => {
  it('finds the amount written with or without commas, and as a whole number', () => {
    expect(amountOnLine(unit('6000000001 | 197,715.42'), '197715.42')).toBe(true)
    expect(amountOnLine(unit('6000000001 | 197715.42'), '197715.42')).toBe(true)
    expect(amountOnLine(unit('6000000001 | 5,000'), '5000')).toBe(true)
    expect(amountOnLine(unit('6000000001', { numbers: ['197715.42'] }), '197715.42')).toBe(true)
    expect(amountOnLine(unit('6000000001 | 1,197,715.42'), '197715.42')).toBe(false)
    expect(amountOnLine(unit('6000000001'), null)).toBeNull()
  })
})

describe('readClearingFile', () => {
  it('reads a CSV line by line', async () => {
    const r = await readClearingFile('cleared.csv', Buffer.from('date,check,amount\n2026-11-03,6000000001,"5,000.00"\n'))
    expect(r.ok && r.kind).toBe('CSV')
    expect(r.ok && r.units.map((u) => u.place)).toEqual(['line 1', 'line 2'])
  })

  it('reads every sheet of a workbook, keeping date and number cells', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('CLEARED')
    ws.addRow(['DATE', 'CHECK NO', 'AMOUNT'])
    ws.addRow([new Date(Date.UTC(2026, 10, 3)), 6000000001, 5000.5])
    const r = await readClearingFile('bank.xlsx', Buffer.from(await wb.xlsx.writeBuffer()))
    if (!r.ok) throw new Error(r.message)
    expect(r.units[1].place).toBe('CLEARED row 2')
    expect(candidateNumbers(r.units[1].text)).toEqual(['6000000001'])
    expect(r.units[1].dates).toHaveLength(1)
    expect(r.units[1].numbers).toContain('5000.5')
  })

  it('rebuilds a PDF table row from text on one baseline, top of the page first', async () => {
    const pdf = tinyPdf([
      { x: 300, y: 700, text: '5,000.00' }, { x: 50, y: 700, text: '03-Nov-2026' }, { x: 150, y: 700, text: '6000000001' },
      { x: 50, y: 680, text: '04-Nov-2026' }, { x: 150, y: 680, text: '6000000002' },
    ])
    const r = await readClearingFile('statement.pdf', pdf)
    if (!r.ok) throw new Error(r.message)
    expect(r.units.map((u) => u.text)).toEqual(['03-Nov-2026 | 6000000001 | 5,000.00', '04-Nov-2026 | 6000000002'])
    expect(r.units[0].place).toBe('page 1 line 1')
  })

  it('refuses a PDF with no text, and a file type it cannot read', async () => {
    const scan = await readClearingFile('scan.pdf', tinyPdf([]))
    expect(scan.ok).toBe(false)
    expect(!scan.ok && scan.message).toMatch(/no text/)
    const xls = await readClearingFile('old.xls', Buffer.from('x'))
    expect(!xls.ok && xls.message).toMatch(/\.xlsx/)
  })
})
