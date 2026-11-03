import { describe, it, expect } from 'vitest'
import { mapPayment, collapseVoidPairs } from '@/lib/integrations/acumatica/map'
import { mapParsedRow } from '@/lib/import/map-row'
import type { ParsedRow } from '@/lib/import/parse'
import type { CompanyReferenceData } from '@/lib/import/company'
import type { NormalisedRow } from '@/lib/normalised-row'

// The exact field names the `AP-Checks and Payments` generic inquiry exposes.
// Taken from the Supplier Portal's working reader, not guessed.
const paymentRow = {
  Type: 'Payment',
  ReferenceNbr: 'CV-ST011550',
  Vendor: 'V001234',
  VendorName: 'HENKEL PHILIPPINES INC.',
  Status: 'Closed',
  PaymentDate: '2025-12-23T00:00:00',
  Description: 'WEEKLY DIRECT (DISNEY)',
  PaymentRef: '6000308584',
  PaymentAmount: 7950,
  Balance: 0,
  Currency: 'PHP',
  CashAccount: 'BPI STK',
  // The live instance says CHK, not CHECK. Measured 2026-09-04 over 1,987 rows:
  // CHK 1947, DEBIT ADV 35, CASH 5 — nothing anywhere spells it CHECK. The
  // fixture said CHECK while `isCheque` ignored the field entirely, so nothing
  // caught it; now that the method decides whether a SIGN button is offered,
  // the wrong literal here would make every fixture row a non-cheque.
  PaymentMethod: 'CHK',
  Branch: 'ST',
  LastModifiedOn: '2025-12-24T09:15:00',
}

describe('mapPayment: PaymentRef is the check number, ReferenceNbr is the CV', () => {
  it('does NOT put ReferenceNbr in checkNumber or PaymentRef in cvNumber — the single most likely mapping error', () => {
    // Reversing these two files every cheque under its voucher number. The
    // dedup key is (company, checkNumber), so the mistake is not cosmetic: it
    // silently keys 37,000 payments on the wrong identifier and makes them
    // impossible to match against the workbook's "CHECK NUMBER" column.
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.checkNumber).toBe('6000308584')
    expect(r.cvNumber).toBe('CV-ST011550')
    expect(r.checkNumber).not.toBe('CV-ST011550')
    expect(r.cvNumber).not.toBe('6000308584')
  })

  it('keeps the payment document reference as the Acumatica identity as well', () => {
    // ReferenceNbr is the payment document's unique key in this feed — the
    // Supplier Portal's ap_payment.ref is UNIQUE on exactly this value — so it
    // is both the CV number a human reads and the identity the sync matches on.
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.acumaticaPaymentId).toBe('CV-ST011550')
  })
})

describe('mapPayment: document types', () => {
  it('maps a Payment to a normalised row', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r).not.toBeNull()
    expect(r.source).toBe('ACUMATICA')
    expect(r.acumaticaDocType).toBe('Payment')
    expect(r.voided).toBe(false)
  })

  it('maps a Voided Payment to a row flagged voided', () => {
    const r = mapPayment({ ...paymentRow, Type: 'Voided Payment', PaymentAmount: -7950, Status: 'Closed' }, 'GOLIVE')!
    expect(r.voided).toBe(true)
    expect(r.acumaticaDocType).toBe('Voided Payment')
  })

  it('also flags the ORIGINAL row of a voided pair, which carries Status "Voided"', () => {
    // A voided cheque arrives as two rows under one reference: the original
    // (Type Payment, positive, Status "Voided") and its reversal (Type Voided
    // Payment, negative, Status "Closed"). The original is the row that
    // describes what happened, so flagging only the reversal would leave the
    // cheque a human actually looks at unmarked.
    const r = mapPayment({ ...paymentRow, Status: 'Voided' }, 'GOLIVE')!
    expect(r.acumaticaDocType).toBe('Payment')
    expect(r.voided).toBe(true)
  })

  it('returns null for the document types we do not import', () => {
    for (const t of ['Prepayment', 'Debit Adj.', 'Refund']) {
      expect(mapPayment({ ...paymentRow, Type: t }, 'GOLIVE'), t).toBeNull()
    }
  })

  it('returns null for a type it has never seen rather than importing it blind', () => {
    expect(mapPayment({ ...paymentRow, Type: 'Credit Adj.' }, 'GOLIVE')).toBeNull()
    expect(mapPayment({ ...paymentRow, Type: '' }, 'GOLIVE')).toBeNull()
    expect(mapPayment({ ...paymentRow, Type: undefined }, 'GOLIVE')).toBeNull()
  })

  it('returns null for something that is not a feed row at all', () => {
    for (const v of [null, undefined, 'a string', 42, []]) {
      expect(mapPayment(v, 'GOLIVE'), String(v)).toBeNull()
    }
  })
})

describe('mapPayment: company resolution', () => {
  it('resolves the company from the branch, per tenant', () => {
    expect(mapPayment(paymentRow, 'GOLIVE')!.companyCode).toBe('STK')
    expect(mapPayment(paymentRow, 'MANUFACTURING')!.companyCode).toBe('STPP')
    expect(mapPayment(paymentRow, 'MANUFACTURING')!.acumaticaTenant).toBe('MANUFACTURING')
  })

  it('produces a row with NO company for an unrecognised branch rather than defaulting to one', () => {
    // ONEMARANAO exists in the live feed and has no company here. A default
    // would file its cheques under whichever company happens to be first.
    const r = mapPayment({ ...paymentRow, Branch: 'ONEMARANAO' }, 'GOLIVE')!
    expect(r).not.toBeNull()
    expect(r.companyCode).toBeNull()
    // The raw code survives so a human can still see what the feed said.
    expect(r.acumaticaBranch).toBe('ONEMARANAO')
  })

  it('tolerates the padding Acumatica applies to branch codes', () => {
    expect(mapPayment({ ...paymentRow, Branch: '  ST  ' }, 'GOLIVE')!.companyCode).toBe('STK')
  })

  it('leaves the company null when the feed states no branch', () => {
    const r = mapPayment({ ...paymentRow, Branch: '' }, 'GOLIVE')!
    expect(r.companyCode).toBeNull()
    expect(r.acumaticaBranch).toBeNull()
  })
})

describe('mapPayment: not every payment is a check', () => {
  it('flags the China offices as non-check payments', () => {
    // DG (Dongguan) and SH (Shanghai) pay by transfer in CNY, and their
    // PaymentRef carries an AP reference rather than a cheque number. There is
    // no physical document to sign or hand over.
    const dg = mapPayment({
      ...paymentRow,
      Branch: 'DG',
      Currency: 'CNY',
      PaymentRef: 'AP-DG001931',
      PaymentMethod: 'TT',
      CashAccount: 'RMB-C-2213',
    }, 'GOLIVE')!
    expect(dg.isCheque).toBe(false)
    expect(dg.companyCode).toBe('DG')
    expect(dg.currency).toBe('CNY')
    // The AP reference is kept, not discarded: it is the only identifier the
    // payment has, and dropping it would make the row unkeyable.
    expect(dg.checkNumber).toBe('AP-DG001931')

    const sh = mapPayment({ ...paymentRow, Branch: 'SH', Currency: 'CNY', PaymentRef: 'AP-SH000442' }, 'GOLIVE')!
    expect(sh.isCheque).toBe(false)
    expect(sh.companyCode).toBe('SH')
  })

  it('treats every other branch as a check', () => {
    expect(mapPayment(paymentRow, 'GOLIVE')!.isCheque).toBe(true)
    expect(mapPayment({ ...paymentRow, Branch: 'A1+' }, 'GOLIVE')!.isCheque).toBe(true)
    // Even an unrecognised branch: the two non-cheque branches are known by
    // name, and guessing from the PaymentRef's shape would misclassify cheques.
    expect(mapPayment({ ...paymentRow, Branch: 'ONEMARANAO' }, 'GOLIVE')!.isCheque).toBe(true)
  })
})

describe('mapPayment: money never becomes a float', () => {
  it('carries the amount as a decimal string', () => {
    const r = mapPayment({ ...paymentRow, PaymentAmount: 197715.42 }, 'GOLIVE')!
    expect(r.amount).toBe('197715.42')
    expect(typeof r.amount).toBe('string')
  })

  it('accepts an amount the feed sends as a string, unchanged', () => {
    expect(mapPayment({ ...paymentRow, PaymentAmount: '197715.42' }, 'GOLIVE')!.amount).toBe('197715.42')
    expect(mapPayment({ ...paymentRow, PaymentAmount: ' -88426.95 ' }, 'GOLIVE')!.amount).toBe('-88426.95')
  })

  it('keeps a negative reversal negative rather than taking its magnitude', () => {
    const r = mapPayment({ ...paymentRow, Type: 'Voided Payment', PaymentAmount: -88426.95 }, 'GOLIVE')!
    expect(r.amount).toBe('-88426.95')
  })

  it('rejects an exponent form rather than expanding it', () => {
    // Expanding 1e21 invents 21 digits nobody wrote down. Nothing in this feed
    // renders that way, so a value that does is a surprise, not an amount.
    expect(mapPayment({ ...paymentRow, PaymentAmount: 1e21 }, 'GOLIVE')!.amount).toBeNull()
    expect(mapPayment({ ...paymentRow, PaymentAmount: 1e-7 }, 'GOLIVE')!.amount).toBeNull()
    expect(mapPayment({ ...paymentRow, PaymentAmount: '1e21' }, 'GOLIVE')!.amount).toBeNull()
  })

  it('leaves the amount null when the feed does not state one', () => {
    for (const v of [null, undefined, '', 'CANCELLED', NaN]) {
      expect(mapPayment({ ...paymentRow, PaymentAmount: v }, 'GOLIVE')!.amount, String(v)).toBeNull()
    }
  })

  it('leaves the currency null when the feed does not state one, rather than assuming pesos', () => {
    expect(mapPayment({ ...paymentRow, Currency: '' }, 'GOLIVE')!.currency).toBeNull()
    expect(mapPayment({ ...paymentRow, Currency: 'usd' }, 'GOLIVE')!.currency).toBe('USD')
  })
})

describe('mapPayment: dates', () => {
  it('reads the payment date as a UTC day, discarding the time component', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.checkDate?.toISOString()).toBe('2025-12-23T00:00:00.000Z')
  })

  it('does not shift the day by the host machine timezone', () => {
    // Acumatica's timestamps are naive. `new Date('2025-12-23T00:00:00')`
    // parses as LOCAL time, so on a UTC+8 host the cheque would land on the
    // 22nd. The day the feed states is the day we store.
    expect(mapPayment({ ...paymentRow, PaymentDate: '2025-12-23T00:00:00' }, 'GOLIVE')!.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
    expect(mapPayment({ ...paymentRow, PaymentDate: '2025-12-23' }, 'GOLIVE')!.checkDate?.toISOString().slice(0, 10)).toBe('2025-12-23')
  })

  it('preserves the LastModifiedOn wall clock so the watermark round-trips', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.lastModifiedOn?.toISOString().slice(0, 19)).toBe('2025-12-24T09:15:00')
  })

  it('leaves a missing or unparseable date null rather than passing Invalid Date to the database', () => {
    for (const v of [null, undefined, '', 'not a date', 0]) {
      expect(mapPayment({ ...paymentRow, PaymentDate: v }, 'GOLIVE')!.checkDate, String(v)).toBeNull()
      expect(mapPayment({ ...paymentRow, LastModifiedOn: v }, 'GOLIVE')!.lastModifiedOn, String(v)).toBeNull()
    }
  })
})

describe('mapPayment: the rest of the shared row contract', () => {
  it('fills the fields the feed knows and nulls the ones it does not', () => {
    const r = mapPayment(paymentRow, 'GOLIVE')!
    expect(r.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(r.vendorCode).toBe('V001234')
    expect(r.cashAccountCode).toBe('BPI STK')
    expect(r.acumaticaStatus).toBe('Closed')
    // The inquiry's CashAccount IS the cheque book (spec §D); live it reads
    // `BPI-S-4636`. This fixture's `BPI STK` is not a book code, which is the
    // point: the mapper passes the value through verbatim as BOTH codes and
    // judges nothing — upsertCheck resolves it against CheckBook.code or
    // leaves the book null.
    expect(r.checkBookCode).toBe('BPI STK')
    expect(r.category).toBeNull()
    // Provenance belongs to the workbook path.
    expect(r.sourceSheet).toBeNull()
    expect(r.sourceRow).toBeNull()
  })

  it('passes CashAccount through as the check book, trimmed, and null when absent', () => {
    expect(mapPayment({ ...paymentRow, CashAccount: '  BPI-S-4636 ' }, 'GOLIVE')!.checkBookCode).toBe('BPI-S-4636')
    expect(mapPayment({ ...paymentRow, CashAccount: null }, 'GOLIVE')!.checkBookCode).toBeNull()
  })

  it('turns a blank cell into null rather than an empty string', () => {
    const r = mapPayment({ ...paymentRow, VendorName: '   ', Vendor: '', CashAccount: null, PaymentRef: '' }, 'GOLIVE')!
    expect(r.payeeName).toBeNull()
    expect(r.vendorCode).toBeNull()
    expect(r.cashAccountCode).toBeNull()
    expect(r.checkNumber).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Defect 1: the two sources wrote the same physical cheque under two keys.
// ---------------------------------------------------------------------------

// The tiny injected table the workbook mapper's own tests use.
const REF: CompanyReferenceData = {
  cashAccounts: [{ code: 'BPI STK', company: 'STK' }],
  checkBooks: [{ code: 'BPI-S-4636', company: 'STK' }],
}

function registerRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    sheet: 'BPI RELEASED',
    row: 412,
    checkNumber: '6000240287',
    cvNumber: 'CV-ST011550',
    apvNumbers: [],
    poNumbers: [],
    checkBook: 'BPI-S-4636',
    cashAccountLabel: null,
    category: null,
    receiptRef: null,
    checkDate: new Date('2025-12-23T00:00:00Z'),
    amount: '7950.00',
    currency: null,
    payee: 'HENKEL PHILIPPINES INC.',
    unclassified: [],
    ...overrides,
  }
}

describe('mapPayment: the check number both sources must agree on', () => {
  it('keys an Acumatica payment the SAME as the register row for the same check', () => {
    // The register writes a cheque number bare; Acumatica prefixes it with the
    // bank on 90.0% of rows. The dedup key is (companyId, checkNumber), so
    // until this matched, one physical cheque was stored twice — once per
    // source — no staged row could ever be promoted, and every cheque present
    // in both sources double-counted in the dashboard totals.
    const acumatica = mapPayment({ ...paymentRow, PaymentRef: 'BPI 6000240287' }, 'GOLIVE')!
    const register = mapParsedRow(registerRow({ checkNumber: '6000240287' }), REF)

    expect(acumatica.checkNumber).toBe('6000240287')
    expect(acumatica.checkNumber).toBe(register.checkNumber)
    expect(acumatica.companyCode).toBe(register.companyCode)
  })

  it('strips each of the three bank prefixes the live feed actually carries', () => {
    // MBTC 1059, BPI 729, BDO 1 across 2,000 measured rows.
    for (const bank of ['MBTC', 'BPI', 'BDO']) {
      const r = mapPayment({ ...paymentRow, PaymentRef: bank + ' 6000240287' }, 'GOLIVE')!
      expect(r.checkNumber, bank).toBe('6000240287')
    }
  })

  it('keeps the reference the feed actually printed, so the raw value is not lost', () => {
    const r = mapPayment({ ...paymentRow, PaymentRef: 'BPI 6000240287' }, 'GOLIVE')!
    expect(r.statedCheckRef).toBe('BPI 6000240287')
    // Stripping never invents: the canonical key and the stated reference are
    // both kept, so a human can always get back to what Acumatica said.
    expect(r.checkNumber).not.toBe(r.statedCheckRef)
  })
})

// ---------------------------------------------------------------------------
// Defect 3: PaymentMethod says what is actually a cheque, and it was ignored.
// ---------------------------------------------------------------------------

describe('mapPayment: PaymentMethod decides whether there is a physical document', () => {
  it('treats CHK and CASH as a check, nothing else', () => {
    // Finance ruling of 2026-09-04 (CHK only), widened by the user's ruling of
    // 2026-10-23: every AP voucher is paid by a physical check, and a CASH
    // payment method means a check payable to cash or to be encashed — still
    // paper that is signed and handed over. Measured that day over the 2026
    // feed: CHK 13,496, TT 1,680, CASH 271 (242 of them PCF-SITIO petty-cash
    // replenishments), BT 3, DEBIT ADV 1. The wires and debit advices have no
    // document, so Finance must never be offered a SIGN or RELEASE button for
    // them — the NOT_A_CHEQUE guard does that, off this flag.
    expect(mapPayment(paymentRow, 'GOLIVE')!.isCheque).toBe(true)
    expect(mapPayment({ ...paymentRow, PaymentMethod: 'chk' }, 'GOLIVE')!.isCheque).toBe(true)
    expect(mapPayment({ ...paymentRow, PaymentMethod: 'CASH' }, 'GOLIVE')!.isCheque).toBe(true)
    expect(mapPayment({ ...paymentRow, PaymentMethod: 'cash' }, 'GOLIVE')!.isCheque).toBe(true)

    for (const method of ['DEBIT ADV', 'TT', 'BT', 'MC', '']) {
      const r = mapPayment({ ...paymentRow, PaymentMethod: method }, 'GOLIVE')!
      expect(r.isCheque, method || '(blank)').toBe(false)
    }
  })

  it('keeps the China-branch rule as WELL as the method rule, not instead of it', () => {
    // Dongguan and Shanghai pay by wire. Even if their PaymentMethod ever said
    // CHK, there is still no physical document — the branch rule is a stated
    // fact about how those offices pay and must not be replaced.
    for (const branch of ['DG', 'SH']) {
      for (const method of ['CHK', 'CASH']) {
        const r = mapPayment({ ...paymentRow, Branch: branch, PaymentMethod: method }, 'GOLIVE')!
        expect(r.isCheque, `${branch} ${method}`).toBe(false)
      }
    }
  })

  it('imports a non-check payment rather than dropping it', () => {
    // The 40 still import and stay visible; they are simply blocked from the
    // release ladder. Losing them would hide money that actually moved.
    const r = mapPayment({ ...paymentRow, PaymentMethod: 'DEBIT ADV', PaymentRef: 'Oct interest' }, 'GOLIVE')!
    expect(r).not.toBeNull()
    expect(r.amount).toBe('7950')
    expect(r.payeeName).toBe('HENKEL PHILIPPINES INC.')
    // Not a cheque, so its reference is not held to a cheque number's shape.
    expect(r.checkNumber).toBe('Oct interest')
  })
})

// ---------------------------------------------------------------------------
// Defect 4: 80 real cheques carry a memo instead of a cheque number.
// ---------------------------------------------------------------------------

describe('mapPayment: a memo where the check number belongs', () => {
  it('refuses to key a CHK payment whose PaymentRef is free text', () => {
    // 80 live rows. They are genuinely cheques, but nothing in them can key
    // (company, checkNumber). Finance ruled on 2026-09-04 that they are staged
    // for a human to supply the real number.
    for (const memo of ['Oct interest', 'pay 12 25 2nd', 'MBTC 1791 to 1795']) {
      const r = mapPayment({ ...paymentRow, PaymentRef: memo }, 'GOLIVE')!
      expect(r.checkNumber, memo).toBeNull()
      // The payment is kept whole so the staged row can be corrected.
      expect(r.statedCheckRef, memo).toBe(memo)
      expect(r.amount, memo).toBe('7950')
      expect(r.payeeName, memo).toBe('HENKEL PHILIPPINES INC.')
      expect(r.checkDate, memo).not.toBeNull()
      expect(r.isCheque, memo).toBe(true)
    }
  })

  it('stages a CASH check whose reference is a petty-cash memo number, like its CHK siblings', () => {
    // 242 of the 271 CASH payments of 2026 sit on PCF-SITIO and carry the fund's
    // own numbering (`PCF26-0226`). Under the 2026-09-04 ruling a check with a
    // non-numeric reference is staged NO_CHECK_NUMBER for a human to supply the
    // real number — 275 CHK payments numbered PCF… are held that way today —
    // and a CASH one goes the same way, not a different one.
    const r = mapPayment({ ...paymentRow, PaymentMethod: 'CASH', PaymentRef: 'PCF26-0226', CashAccount: 'PCF-SITIO' }, 'GOLIVE')!
    expect(r.isCheque).toBe(true)
    expect(r.checkNumber).toBeNull()
    expect(r.statedCheckRef).toBe('PCF26-0226')
  })

  it('keys a CASH check on a bank book by its plain check number', () => {
    // CV-ST021234, 2026-10-19: Payment Method CASH, Payment Ref 6000354949 on
    // BPI-S-8879. It is the check that started this — absent from the app and
    // so from the portal because the feed asked for CHK only.
    const r = mapPayment({ ...paymentRow, PaymentMethod: 'CASH', PaymentRef: '6000354949', CashAccount: 'BPI-S-8879' }, 'GOLIVE')!
    expect(r.isCheque).toBe(true)
    expect(r.checkNumber).toBe('6000354949')
  })

  it('never invents a check number out of the digits in a memo', () => {
    const r = mapPayment({ ...paymentRow, PaymentRef: 'pay 12 25 2nd' }, 'GOLIVE')!
    expect(r.checkNumber).toBeNull()
    expect(r.checkNumber).not.toBe('12252')
  })

  it('leaves a non-check payment reference alone — it is the only identifier it has', () => {
    // The China rows' AP reference is not a cheque number and never was. It
    // still keys the payment, because dropping it would make the row unkeyable
    // and lose a payment that really happened.
    const dg = mapPayment({
      ...paymentRow, Branch: 'DG', PaymentRef: 'AP-DG001931', PaymentMethod: 'TT',
    }, 'GOLIVE')!
    expect(dg.checkNumber).toBe('AP-DG001931')
    expect(dg.isCheque).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Defect 2: a voided cheque could land holding its own negative reversal.
// ---------------------------------------------------------------------------

describe('collapseVoidPairs', () => {
  const original = (o: Record<string, unknown> = {}) =>
    mapPayment({ ...paymentRow, Type: 'Payment', Status: 'Voided', PaymentAmount: '88426.95', ...o }, 'GOLIVE')!
  const reversal = (o: Record<string, unknown> = {}) =>
    mapPayment({ ...paymentRow, Type: 'Voided Payment', Status: 'Closed', PaymentAmount: '-88426.95', ...o }, 'GOLIVE')!

  it('keeps the ORIGINAL of a voided pair and drops the reversal', () => {
    // A void is TWO feed rows under one PaymentRef, and BOTH carry an identical
    // LastModifiedOn on 62 of the 67 such pairs among 1,836 keyable live cheques — so
    // which one survived a last-write-wins upsert was arbitrary. A cheque could
    // therefore store its own negative reversal as its amount. The original is
    // the row a human reads, which is what the Supplier Portal's dedupePayments
    // deliberately keeps too.
    const out = collapseVoidPairs([original(), reversal()])

    expect(out).toHaveLength(1)
    expect(out[0].acumaticaDocType).toBe('Payment')
    expect(out[0].amount).toBe('88426.95')
    expect(out[0].voided).toBe(true)
  })

  it('collapses the pair whichever order the feed returns it in', () => {
    const out = collapseVoidPairs([reversal(), original()])
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBe('88426.95')
  })

  it('flips no signs and takes no magnitudes — it is a PAIRING decision', () => {
    // map.ts states outright that it does no sign manipulation, and that stays
    // true. A lone reversal is passed through exactly as the feed sent it.
    const out = collapseVoidPairs([reversal()])
    expect(out).toHaveLength(1)
    expect(out[0].amount).toBe('-88426.95')
    expect(out[0].acumaticaDocType).toBe('Voided Payment')
  })

  it('pairs on (company, check number) — the key the upsert actually writes on', () => {
    // Two different cheques, each with its own reversal. Pairing on the cheque
    // number alone would be wrong the moment two companies share a number.
    const out = collapseVoidPairs([
      original({ PaymentRef: '6000240287' }),
      reversal({ PaymentRef: '6000240287' }),
      original({ PaymentRef: '6000240288', PaymentAmount: '100.00' }),
      reversal({ PaymentRef: '6000240288', PaymentAmount: '-100.00' }),
    ])
    expect(out.map((r) => r.checkNumber)).toEqual(['6000240287', '6000240288'])
    expect(out.map((r) => r.amount)).toEqual(['88426.95', '100.00'])
  })

  it('does not pair a reversal with a same-numbered check of ANOTHER company', () => {
    const golive = original({ PaymentRef: '6000240287', Branch: 'ST' })
    const other = mapPayment({
      ...paymentRow, Type: 'Voided Payment', Status: 'Closed',
      PaymentAmount: '-88426.95', PaymentRef: '6000240287', Branch: 'A1+',
    }, 'GOLIVE')!
    expect(golive.companyCode).not.toBe(other.companyCode)

    const out = collapseVoidPairs([golive, other])
    expect(out).toHaveLength(2)
  })

  it('does not pair a void with a RE-ISSUE on the same number under another payment reference', () => {
    // Full check 2026-10-06: CV-A1009705 (voided, with its reversal) and its
    // re-issue CV-A1009798 share cheque number 1791361374. Keyed on the number
    // alone, the live re-issue was flagged voided and the sync voided it here.
    const voidedOriginal = original({ ReferenceNbr: 'CV-A1009705', PaymentRef: '1791361374' })
    const voidReversal = reversal({ ReferenceNbr: 'CV-A1009705', PaymentRef: '1791361374' })
    const reissue = mapPayment({ ...paymentRow, ReferenceNbr: 'CV-A1009798', PaymentRef: '1791361374', Status: 'Closed' }, 'GOLIVE')!

    const out = collapseVoidPairs([voidedOriginal, voidReversal, reissue])

    expect(out).toHaveLength(2)
    const byRef = new Map(out.map((r) => [r.acumaticaPaymentId, r]))
    expect(byRef.get('CV-A1009705')?.voided).toBe(true)
    expect(byRef.get('CV-A1009798')?.voided).toBe(false)
    expect(byRef.get('CV-A1009798')?.acumaticaStatus).toBe('Closed')
  })

  it('leaves rows it has nothing to pair alone, in the order the feed gave them', () => {
    const rows: NormalisedRow[] = [
      mapPayment({ ...paymentRow, PaymentRef: '6000240287' }, 'GOLIVE')!,
      mapPayment({ ...paymentRow, PaymentRef: '6000240288' }, 'GOLIVE')!,
      // Unkeyable: a memo, so it is in no group at all and must survive.
      mapPayment({ ...paymentRow, PaymentRef: 'Oct interest' }, 'GOLIVE')!,
    ]
    const out = collapseVoidPairs(rows)
    expect(out).toEqual(rows)
  })

  it('never drops two unkeyable rows into one another', () => {
    // Both have a null cheque number. Grouping them together would silently
    // discard a payment.
    const out = collapseVoidPairs([
      mapPayment({ ...paymentRow, PaymentRef: 'Oct interest' }, 'GOLIVE')!,
      mapPayment({ ...paymentRow, PaymentRef: 'pay 12 25 2nd' }, 'GOLIVE')!,
    ])
    expect(out).toHaveLength(2)
  })
})
