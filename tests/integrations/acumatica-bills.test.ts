import { describe, it, expect } from 'vitest'
import {
  BILL_FEED_COLUMNS, billsSinceFilter, billsInScopeFilter, mapBillApplication, billsForPaymentFilter,
} from '@/lib/integrations/acumatica/bills'

const golive = (o: Record<string, unknown> = {}) => ({
  AdjgDocType: 'CHK', AdjgRefNbr: 'CV-ST012345', AdjdDocType: 'Bill', AdjdRefNbr: 'ap-st042652 ',
  LastModifiedOn: '2026-09-29T08:15:00', ...o,
})
const mfg = (o: Record<string, unknown> = {}) => ({
  AdjgDocType: 'CHK', ReferenceNbr: 'CV-MF000123', DocumentType: 'Bill', ReferenceNbr_2: 'A1PP-AP-000014',
  APAdjust_lastModifiedDateTime: '2026-09-29T08:15:00', ...o,
})

describe('BILL_FEED_COLUMNS', () => {
  it('names each tenant’s own columns', () => {
    expect(BILL_FEED_COLUMNS.GOLIVE).toEqual({ date: 'LastModifiedOn', paymentRef: 'AdjgRefNbr', paymentType: 'AdjgDocType', billRef: 'AdjdRefNbr', billType: 'AdjdDocType' })
    expect(BILL_FEED_COLUMNS.MANUFACTURING).toEqual({ date: 'APAdjust_lastModifiedDateTime', paymentRef: 'ReferenceNbr', paymentType: 'AdjgDocType', billRef: 'ReferenceNbr_2', billType: 'DocumentType' })
  })
})

describe('filters', () => {
  it('uses the datetime literal on the tenant’s own date column, no zone', () => {
    const since = new Date('2026-09-29T06:15:00.000Z')
    expect(billsSinceFilter('GOLIVE', since)).toBe("LastModifiedOn ge datetime'2026-09-29T06:15:00'")
    expect(billsSinceFilter('MANUFACTURING', since)).toBe("APAdjust_lastModifiedDateTime ge datetime'2026-09-29T06:15:00'")
    expect(billsInScopeFilter('GOLIVE')).toBe("LastModifiedOn ge datetime'2026-01-01T00:00:00'")
  })
})

describe('mapBillApplication', () => {
  it('maps a check paying a bill, trimmed and upper-cased voucher', () => {
    expect(mapBillApplication(golive(), 'GOLIVE')).toEqual({
      paymentRef: 'CV-ST012345', voucher: 'AP-ST042652', lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
    expect(mapBillApplication(mfg(), 'MANUFACTURING')).toEqual({
      paymentRef: 'CV-MF000123', voucher: 'A1PP-AP-000014', lastModifiedOn: new Date('2026-09-29T08:15:00Z'),
    })
  })

  it('billsForPaymentFilter asks for ONE payment by the tenant’s own column, quotes doubled', () => {
    // The direct lookup of 2026-10-26 (a held check with no APV). The Go-Live
    // column name is a 500 on MANUFACTURING, so each tenant gets its own.
    expect(billsForPaymentFilter('GOLIVE', 'CV-HF000161')).toBe("AdjgRefNbr eq 'CV-HF000161'")
    expect(billsForPaymentFilter('MANUFACTURING', 'CV-MF000123')).toBe("ReferenceNbr eq 'CV-MF000123'")
    expect(billsForPaymentFilter('GOLIVE', "O'BRIEN")).toBe("AdjgRefNbr eq 'O''BRIEN'")
  })

  it('keeps only CHK paying a Bill', () => {
    for (const t of ['VCK', 'PPM', 'ADR', 'REF']) expect(mapBillApplication(golive({ AdjgDocType: t }), 'GOLIVE'), t).toBeNull()
    expect(mapBillApplication(golive({ AdjdDocType: 'Debit Adj.' }), 'GOLIVE')).toBeNull()
    expect(mapBillApplication(golive({ AdjdDocType: 'PPM', AdjdRefNbr: 'ap-st044462' }), 'GOLIVE')).toMatchObject({ voucher: 'AP-ST044462' })
  })

  it('refuses a row with no payment or no voucher', () => {
    expect(mapBillApplication(golive({ AdjgRefNbr: '  ' }), 'GOLIVE')).toBeNull()
    expect(mapBillApplication(golive({ AdjdRefNbr: null }), 'GOLIVE')).toBeNull()
    expect(mapBillApplication(null, 'GOLIVE')).toBeNull()
  })

  it('keeps a row whose date cannot be read, with a null date', () => {
    expect(mapBillApplication(golive({ LastModifiedOn: 'nonsense' }), 'GOLIVE')?.lastModifiedOn).toBeNull()
  })
})
