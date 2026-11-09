import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { computeReconciliation } from '@/lib/recon/monthly/compute'
import { buildPeriodWorkbook } from '@/lib/export/recon-period-workbook'

describe('buildPeriodWorkbook', () => {
  it('writes the summary, both calculations and every list', async () => {
    const c = computeReconciliation({
      month: '2026-10', openingMonth: '2026-10', beginningBank: '100.00', beginningBook: '100.00',
      statementBeginningBalance: null, statementEndingBalance: '100.00',
      checks: [{ id: 'a', checkNumber: '6000000001', payee: 'X', amount: '40.00', checkDate: new Date('2026-10-02T00:00:00Z'), releasedAt: null, clearingStatus: 'NONE', clearedDate: null, status: 'RELEASED' }],
      lines: [], bookEntries: [], adjustments: [],
    })
    const buf = await buildPeriodWorkbook(c, {
      accountCode: 'BPI-S-4636', bankCode: 'BPI', month: '2026-10', currency: 'PHP', status: 'DRAFT', frozen: false,
      generatedAt: new Date('2026-11-09T00:00:00Z'), generatedBy: 'Tester', approvedBy: null, history: [],
    })
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'SUMMARY', 'OUTSTANDING CHECKS', 'CLEARED CHECKS', 'CHECKS RELEASED', 'BANK STATEMENT', 'BOOK ENTRIES',
      'DEPOSITS IN TRANSIT', 'ADJUSTMENTS', 'APPROVAL HISTORY',
    ])
    const summary = wb.getWorksheet('SUMMARY')!
    const values = summary.getColumn(1).values.map(String)
    const row = (label: string) => summary.getRow(values.indexOf(label)).getCell(2).value
    expect(row('ADJUSTED BANK BALANCE')).toBe(60)
    expect(row('ADJUSTED BOOK BALANCE')).toBe(60)
    expect(wb.getWorksheet('OUTSTANDING CHECKS')!.getRow(2).getCell(1).value).toBe('6000000001')
  })
})
