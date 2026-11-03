import { describe, it, expect } from 'vitest'
import {
  RECEIPT_TYPES, isReceiptType, checkReceipt, normaliseReceipt, hasReceipt,
  checkReceiptAmount, checkReceiptFile, MAX_RECEIPT_FILE_BYTES, PORTAL_RECEIPT_TYPES, portalAcceptsReceiptType,
} from '@/lib/domain/receipt'

// Pure. No database, no clock — every way a receipt can be typed wrong is
// answerable here, which is why the guard lives outside `actions.ts`.

describe('the receipt types', () => {
  it('is OR, CR, AR, PR, SI and OTHERS — the papers a supplier hands over', () => {
    expect([...RECEIPT_TYPES]).toEqual(['OR', 'CR', 'AR', 'PR', 'SI', 'OTHERS'])
    expect(isReceiptType('AR') && isReceiptType('PR') && isReceiptType('SI')).toBe(true)
    expect(isReceiptType('XX')).toBe(false)
  })

  it('tells the portal only about the kinds it accepts (OR and CR)', () => {
    expect(PORTAL_RECEIPT_TYPES).toEqual(['OR', 'CR'])
    expect(portalAcceptsReceiptType('CR')).toBe(true)
    for (const t of ['AR', 'PR', 'SI', 'OTHERS', null, undefined, '']) expect(portalAcceptsReceiptType(t), String(t)).toBe(false)
  })

  it('recognises its own values and nothing else', () => {
    expect(isReceiptType('OR')).toBe(true)
    expect(isReceiptType('CR')).toBe(true)
    // The bank clearing reference lives in `crNumber` beside `clearingStatus`
    // and is a different fact entirely. Nothing here may be coaxed into it.
    expect(isReceiptType('CRN')).toBe(false)
    expect(isReceiptType('or')).toBe(false)
    expect(isReceiptType('')).toBe(false)
    expect(isReceiptType(null)).toBe(false)
    expect(isReceiptType(7)).toBe(false)
  })
})

describe('checkReceipt', () => {
  // The client's own wording: "It is optional. A cheque can be released with
  // the box empty and the receipt added later." RELEASE ALL at the counter
  // depends on this being true.
  it('permits no receipt at all', () => {
    expect(checkReceipt({})).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: null, receiptType: null })).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: '   ', receiptType: null })).toEqual({ ok: true })
  })

  it('permits a reference with a type', () => {
    expect(checkReceipt({ orNumber: 'OR-000123', receiptType: 'OR' })).toEqual({ ok: true })
    expect(checkReceipt({ orNumber: '4471', receiptType: 'CR' })).toEqual({ ok: true })
  })

  // The one combination refused. A reference stored without its kind is a
  // number nobody can classify later, and defaulting it to OR would invent the
  // answer rather than ask for it.
  it('refuses a reference with no type chosen', () => {
    const guard = checkReceipt({ orNumber: 'OR-000123', receiptType: null })
    expect(guard.ok).toBe(false)
    if (guard.ok) return
    expect(guard.code).toBe('RECEIPT_TYPE_REQUIRED')
    expect(guard.message).toContain('Official Receipt')
    expect(guard.message).toContain('Collection Receipt')
  })

  it('refuses a reference that is whitespace-padded but real, with no type', () => {
    expect(checkReceipt({ orNumber: '  OR-9  ', receiptType: null }).ok).toBe(false)
  })

  // Not a refusal: there is simply nothing to record. See `normaliseReceipt`.
  it('permits a type with no reference', () => {
    expect(checkReceipt({ orNumber: null, receiptType: 'OR' })).toEqual({ ok: true })
  })
})

describe('normaliseReceipt', () => {
  it('trims the reference', () => {
    expect(normaliseReceipt({ orNumber: '  OR-000123 ', receiptType: 'OR' })).toEqual({
      orNumber: 'OR-000123', orDate: null, receiptType: 'OR',
    })
  })

  it('keeps the date that belongs to a reference', () => {
    const d = new Date('2026-09-08T00:00:00Z')
    expect(normaliseReceipt({ orNumber: 'CR-77', orDate: d, receiptType: 'CR' })).toEqual({
      orNumber: 'CR-77', orDate: d, receiptType: 'CR',
    })
  })

  // A type and a date with no reference describe a receipt nobody can look up.
  // They are dropped rather than stored, so a report of "the CRs issued in
  // September" counts pieces of paper and not half-filled forms.
  it('drops a type and a date when there is no reference', () => {
    expect(normaliseReceipt({
      orNumber: '   ', orDate: new Date('2026-09-08T00:00:00Z'), receiptType: 'OR',
    })).toEqual({ orNumber: null, orDate: null, receiptType: null })
  })

  it('answers null for everything when it is given nothing', () => {
    expect(normaliseReceipt({})).toEqual({ orNumber: null, orDate: null, receiptType: null })
  })
})

describe('hasReceipt', () => {
  it('is true only when a reference was recorded', () => {
    expect(hasReceipt({ orNumber: 'OR-1', orDate: null, receiptType: 'OR' })).toBe(true)
    expect(hasReceipt({ orNumber: null, orDate: null, receiptType: null })).toBe(false)
  })
})

describe('checkReceiptAmount', () => {
  it('normalises commas and two decimals, keeps blank as null', () => {
    expect(checkReceiptAmount('1,000.5')).toEqual({ ok: true, amount: '1000.50' })
    expect(checkReceiptAmount('')).toEqual({ ok: true, amount: null })
    expect(checkReceiptAmount(undefined)).toEqual({ ok: true, amount: null })
  })
  it('keeps sixteen integer digits exactly, which a JS number would not', () => {
    expect(checkReceiptAmount('9999999999999999.99')).toEqual({ ok: true, amount: '9999999999999999.99' })
    expect(checkReceiptAmount('007')).toEqual({ ok: true, amount: '7.00' })
    expect(checkReceiptAmount('0')).toEqual({ ok: true, amount: '0.00' })
  })
  it('refuses negatives, three decimals and words', () => {
    for (const bad of ['-1', '1.005', 'abc', '1e5', '12345678901234567']) expect(checkReceiptAmount(bad).ok).toBe(false)
  })
})

describe('checkReceiptFile', () => {
  const pdf = (n = 10) => { const b = new Uint8Array(n); b.set([0x25, 0x50, 0x44, 0x46]); return b }
  it('accepts a PDF whose bytes say PDF', () => {
    expect(checkReceiptFile({ fileName: 'or.pdf', contentType: 'application/pdf', bytes: pdf() })).toEqual({ ok: true })
    expect(checkReceiptFile(null)).toEqual({ ok: true })
  })
  it('refuses size, type and a mismatched signature', () => {
    expect(checkReceiptFile({ fileName: 'x', contentType: 'application/pdf', bytes: pdf(MAX_RECEIPT_FILE_BYTES + 1) })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TOO_LARGE' })
    expect(checkReceiptFile({ fileName: 'x', contentType: 'text/html', bytes: pdf() })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TYPE' })
    expect(checkReceiptFile({ fileName: 'x.png', contentType: 'image/png', bytes: pdf() })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_TYPE' })
    expect(checkReceiptFile({ fileName: 'x', contentType: 'application/pdf', bytes: new Uint8Array(0) })).toMatchObject({ ok: false, code: 'RECEIPT_FILE_EMPTY' })
  })
})
