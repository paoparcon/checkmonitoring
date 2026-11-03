import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Prisma, type Check } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import {
  upsertCheck, importRows, IMMUTABLE_ON_UPDATE, IMPORT_WRITABLE, FINANCE_RULING_BASIS,
  COMPANY_RULING_BASIS,
} from '@/lib/import/upsert'
import { VOID_AFTER_RELEASE_WARNING } from '@/lib/domain/actions'
import type { NormalisedRow } from '@/lib/normalised-row'
import { mapPayment } from '@/lib/integrations/acumatica/map'

const NOW = new Date('2026-09-04T13:32:00+08:00')
const OWN_COMPANIES = ['STARKSON PACKAGING INC.']

beforeEach(resetDb)

// The import is the path most likely to grow a stray PortalEvent by accident:
// it touches every cheque in the register and it runs unattended. Publishing
// to the supplier portal is a Finance action, never an import consequence.
// Until 2026-10-29 the one exception was CANCELLED, queued through `voidCheck`
// when Acumatica reported a portal-routed cheque voided; the user then ruled
// that a cancelled cheque is detached from its AP bills and the portal is not
// told (see the `upsertCheck — voiding` tests below). So NO event at all is
// asserted after EVERY test in the file rather than in one test that a later
// author could forget to extend.
afterEach(async () => {
  expect(await testDb.portalEvent.count()).toBe(0)
})

async function seedCompany(code = 'STK', name = 'Starkson Packaging Inc.') {
  const company = await testDb.company.create({
    data: { code, name, legalNames: [name.toUpperCase()] },
  })
  const bank = await testDb.bank.create({ data: { code: `BPI-${code}`, name: 'BPI' } })
  const cashAccount = await testDb.cashAccount.create({
    data: { code: `BPI ${code}`, bankId: bank.id, companyId: company.id },
  })
  const checkBook = await testDb.checkBook.create({
    data: { code: `BPI-${code}-4636`, bankId: bank.id, companyId: company.id },
  })
  return { company, cashAccount, checkBook }
}

// A full NormalisedRow, so a test states only what it is about. Typed
// `Partial<NormalisedRow>` deliberately: a misspelt override is a compile error
// rather than a silently ignored key.
function row(overrides: Partial<NormalisedRow> = {}): NormalisedRow {
  return {
    source: 'WORKBOOK',
    acumaticaPaymentId: null,
    checkNumber: '6000319079',
    statedCheckRef: '6000319079',
    cvNumber: 'CV-ST-004112',
    checkDate: new Date('2026-01-19T00:00:00Z'),
    amount: '197715.42',
    currency: 'PHP',
    payeeName: 'HENKEL PHILIPPINES INC.',
    vendorCode: null,
    companyCode: 'STK',
    cashAccountCode: 'BPI STK',
    checkBookCode: 'BPI-STK-4636',
    category: null,
    apvNumbers: ['APV-ST-009911'],
    poNumbers: [],
    receiptRef: 'CR 12345',
    isCheque: true,
    voided: false,
    acumaticaDocType: null,
    acumaticaStatus: null,
    acumaticaBranch: null,
    acumaticaTenant: null,
    lastModifiedOn: null,
    sourceSheet: 'BPI RELEASED',
    sourceRow: 412,
    ...overrides,
  }
}

const upsert = (r: NormalisedRow, sheets?: readonly string[]) =>
  upsertCheck(testDb, { row: r, ownCompanyNames: OWN_COMPANIES, now: NOW, sheets })

// An Acumatica row exactly as the sync hands it over: a raw `AP-Checks and
// Payments` feed row through the real `mapPayment`, so `checkBookCode`,
// `cashAccountCode`, the company (Branch ST -> STK in Go-Live) and the empty
// voucher array are the mapper's, not a hand-built imitation of them.
function acumaticaRow(feed: Record<string, unknown> = {}): NormalisedRow {
  const mapped = mapPayment({
    Type: 'Payment',
    ReferenceNbr: 'CV-ST-1',
    Vendor: 'V001234',
    VendorName: 'HENKEL PHILIPPINES INC.',
    Status: 'Balanced',
    PaymentDate: '2026-09-30T00:00:00',
    PaymentRef: 'BPI 6000400001',
    PaymentAmount: '1000.00',
    Currency: 'PHP',
    CashAccount: 'BPI-S-4636',
    PaymentMethod: 'CHK',
    Branch: 'ST',
    LastModifiedOn: '2026-09-30T09:15:00',
    ...feed,
  }, 'GOLIVE')
  if (!mapped) throw new Error('fixture is not an imported document type')
  return mapped
}

describe('upsertCheck — creating', () => {
  it('creates a check that does not exist, at the status the sheet implies', async () => {
    await seedCompany()
    const out = await upsert(row({ sourceSheet: 'BPI RELEASED' }))
    expect(out).toMatchObject({ outcome: 'CREATED' })

    const check = await testDb.check.findFirstOrThrow()
    expect(check.checkNumber).toBe('6000319079')
    expect(check.status).toBe('RELEASED')
  })

  it('creates at SIGNATURE_PENDING from a sheet that asserts nothing', async () => {
    await seedCompany()
    await upsert(row({ sourceSheet: 'MBTC P&P' }))
    expect((await testDb.check.findFirstOrThrow()).status).toBe('SIGNATURE_PENDING')
  })

  it('carries the row across, wiring the cash account and checkbook by code', async () => {
    const { company, cashAccount, checkBook } = await seedCompany()
    await upsert(row())

    const check = await testDb.check.findFirstOrThrow()
    expect(check.companyId).toBe(company.id)
    expect(check.cashAccountId).toBe(cashAccount.id)
    expect(check.checkBookId).toBe(checkBook.id)
    expect(check.cvNumber).toBe('CV-ST-004112')
    expect(check.amount?.toString()).toBe('197715.42')
    expect(check.currency).toBe('PHP')
    expect(check.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(check.checkDate).toEqual(new Date('2026-01-19T00:00:00Z'))
    expect(check.sourceSheet).toBe('BPI RELEASED')
    expect(check.sourceRow).toBe(412)
    // The register's REMARKS "CR 12345" is the supplier's Collection Receipt
    // (client ruling 2026-09-11). It lands in the receipt columns on create and
    // never in `crNumber`, which is the BANK's — rule 11.
    expect(check.orNumber).toBe('CR 12345')
    expect(check.receiptType).toBe('CR')
    expect(check.orDate).toBeNull()
    expect(check.crNumber).toBeNull()
  })

  it('an Acumatica row whose CashAccount is a check book gets that book; a non-book code gets none (spec §D)', async () => {
    const { company, cashAccount } = await seedCompany()
    const book = await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: cashAccount.bankId, companyId: company.id } })
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-ST-1', PaymentRef: 'BPI 6000400001', CashAccount: 'BPI-S-4636' }))
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-ST-2', PaymentRef: 'BPI 6000400002', CashAccount: 'PCF-SITIO' }))
    const a = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400001' } })
    const b = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400002' } })
    expect(a.companyId).toBe(company.id)
    expect(a.checkBookId).toBe(book.id)
    expect(b.checkBookId).toBeNull()
    // No refusal is ever noted: there is no company check any more (spec §E).
    const audits = await testDb.auditLog.findMany({ where: { action: 'imported' } })
    expect(audits).toHaveLength(2)
    for (const audit of audits) expect(audit.details).not.toHaveProperty('checkBookRefused')
  })

  it('sets a check book filed under another company on create: books are shared (spec §E)', async () => {
    await seedCompany()
    const a1 = await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')
    // The code names a book on record under A1+; Branch ST files the cheque under STK.
    const shared = await testDb.checkBook.create({
      data: { code: 'BPI-A-7001', bankId: a1.cashAccount.bankId, companyId: a1.company.id },
    })
    const out = await upsert(acumaticaRow({ CashAccount: 'BPI-A-7001' }))
    expect(out).toMatchObject({ outcome: 'CREATED' })

    const check = await testDb.check.findFirstOrThrow()
    expect(check.companyId).not.toBe(a1.company.id)
    expect(check.checkBookId).toBe(shared.id)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'imported', checkId: check.id } })
    expect(audit.details).not.toHaveProperty('checkBookRefused')
  })

  it('creates with no receipt when the source states none', async () => {
    await seedCompany()
    await upsert(row({ receiptRef: null }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.orNumber).toBeNull()
    expect(check.receiptType).toBeNull()
    expect(check.crNumber).toBeNull()
  })

  it('writes the vouchers the source states onto the check', async () => {
    // The whole point of the change. `AP-ST042652` was parsed out of the
    // register on every import and then dropped on the floor, because `Check`
    // had no column to put it in — so 84 vouchers were in the database against
    // the register's 10,985, and a cheque nobody could find by its voucher
    // never reached the supplier portal.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-ST042652'] }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.apvNumbers).toEqual(['AP-ST042652'])
  })

  it('deduplicates and orders the vouchers it stores', async () => {
    // Deterministic, so a re-import is a no-op rather than a reordering, and so
    // two cheques carrying the same pair read the same way on screen.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-ST042653', 'AP-ST042652', 'AP-ST042653'] }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.apvNumbers).toEqual(['AP-ST042652', 'AP-ST042653'])
  })

  it('leaves an unknown cash account or checkbook code unwired rather than inventing one', async () => {
    await seedCompany()
    await upsert(row({ cashAccountCode: 'PAYROLL', checkBookCode: 'NOT-A-BOOK' }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.cashAccountId).toBeNull()
    expect(check.checkBookId).toBeNull()
  })

  it('stores a check the register records no amount or payee for', async () => {
    await seedCompany()
    await upsert(row({ amount: null, payeeName: null }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.amount).toBeNull()
    expect(check.payeeName).toBeNull()
  })

  it('writes a SYSTEM audit row on every create', async () => {
    await seedCompany()
    const out = await upsert(row())
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'imported' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.checkId).toBe(out.outcome === 'CREATED' ? out.checkId : null)
    expect(audit.details).toMatchObject({ source: 'WORKBOOK', status: 'RELEASED' })
  })
})

describe('upsertCheck — re-importing', () => {
  it('updates rather than duplicating on the same company and check number', async () => {
    await seedCompany()
    const first = await upsert(row())
    const second = await upsert(row({ amount: '200000.00', sourceRow: 900 }))

    expect(second).toMatchObject({ outcome: 'UPDATED' })
    expect(first.outcome === 'CREATED' && second.outcome === 'UPDATED'
      && first.checkId === second.checkId).toBe(true)
    expect(await testDb.check.count()).toBe(1)

    const check = await testDb.check.findFirstOrThrow()
    expect(check.amount?.toString()).toBe('200000')
    expect(check.sourceRow).toBe(900)
  })

  it('adds a voucher a second register row states, rather than replacing the first', async () => {
    // A cheque appearing on two register sheets is one cheque recorded twice.
    // Measured 2026-09-07: 360 cheque numbers sit on more than one parsed row,
    // and 11 of them state a DIFFERENT non-empty voucher set on each. Under
    // last-writer-wins those 11 lose a voucher to whichever sheet was read last,
    // which is the exact failure this whole change exists to stop.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-ST042652'] }))
    await upsert(row({ apvNumbers: ['AP-ST042653'], sourceSheet: 'CANCELLED' }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.apvNumbers).toEqual(['AP-ST042652', 'AP-ST042653'])
  })

  it('is idempotent on the vouchers', async () => {
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-ST042652'] }))
    await upsert(row({ apvNumbers: ['AP-ST042652'] }))
    expect((await testDb.check.findFirstOrThrow()).apvNumbers).toEqual(['AP-ST042652'])
  })

  it('never clears a recorded voucher because this source carries none', async () => {
    // Every Acumatica row arrives with an empty array — the payments generic
    // inquiry publishes no voucher at all. An empty array means "this source
    // does not carry one", never "clear the ones you have", exactly as `keep()`
    // treats a null. Without this, one sync wipes the register's 10,985
    // vouchers and the dashboard silently goes back to 84.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-ST042652'] }))
    await upsert(row({ source: 'ACUMATICA', apvNumbers: [], sourceSheet: null, sourceRow: null }))
    expect((await testDb.check.findFirstOrThrow()).apvNumbers).toEqual(['AP-ST042652'])
  })

  it('does not write apvNumbers when the merge adds nothing, so a concurrent BILLS append survives', async () => {
    // The race, made deterministic: upsertCheck reads the cheque holding
    // ['AP-OLD'], then (as the BILLS read would) the row gains 'AP-NEW' before
    // upsertCheck writes. A whole-array write of the stale merge would erase it.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-OLD'] }))
    const writes: Record<string, unknown>[] = []
    const racing = new Proxy(testDb, {
      has: (t, p) => (p === '$transaction' ? false : Reflect.has(t, p)),
      get(t, p, r) {
        if (p !== 'check') return Reflect.get(t, p, r)
        return new Proxy(t.check, {
          get(ct, cp, cr) {
            if (cp === 'findUnique') {
              return async (...a: unknown[]) => {
                const found = await (ct.findUnique as (...x: unknown[]) => Promise<Check | null>)(...a)
                if (found) {
                  await t.check.update({ where: { id: found.id }, data: { apvNumbers: ['AP-NEW', 'AP-OLD'] } })
                }
                return found
              }
            }
            if (cp === 'update') {
              return (arg: { data: Record<string, unknown> }) => {
                writes.push(arg.data)
                return (ct.update as (x: unknown) => unknown)(arg)
              }
            }
            return Reflect.get(ct, cp, cr)
          },
        })
      },
    }) as unknown as typeof testDb
    await upsertCheck(racing, {
      row: row({ source: 'ACUMATICA', apvNumbers: [], sourceSheet: null, sourceRow: null }),
      ownCompanyNames: OWN_COMPANIES,
      now: NOW,
    })
    expect(writes.length).toBe(1)
    expect(writes[0].apvNumbers).toBeUndefined()
    expect((await testDb.check.findFirstOrThrow()).apvNumbers).toEqual(['AP-NEW', 'AP-OLD'])
  })

  it('does not write apvNumbers for an empty incoming array when the stored array is unsorted', async () => {
    // The BILLS read appends missing vouchers at the END ("apvNumbers" || missing),
    // so a stored array need not be sorted. A positional comparison against the
    // sorted merge would call that an addition and rewrite the whole array from
    // an unlocked read — the race the skip exists to close.
    await seedCompany()
    await upsert(row({ apvNumbers: ['AP-Z'] }))
    const id = (await testDb.check.findFirstOrThrow()).id
    await testDb.check.update({ where: { id }, data: { apvNumbers: ['AP-Z', 'AP-A'] } })
    const writes: Record<string, unknown>[] = []
    const spying = new Proxy(testDb, {
      has: (t, p) => (p === '$transaction' ? false : Reflect.has(t, p)),
      get(t, p, r) {
        if (p !== 'check') return Reflect.get(t, p, r)
        return new Proxy(t.check, {
          get(ct, cp, cr) {
            if (cp === 'update') {
              return (arg: { data: Record<string, unknown> }) => {
                writes.push(arg.data)
                return (ct.update as (x: unknown) => unknown)(arg)
              }
            }
            return Reflect.get(ct, cp, cr)
          },
        })
      },
    }) as unknown as typeof testDb
    await upsertCheck(spying, {
      row: row({ source: 'ACUMATICA', apvNumbers: [], sourceSheet: null, sourceRow: null }),
      ownCompanyNames: OWN_COMPANIES,
      now: NOW,
    })
    expect(writes.length).toBe(1)
    expect(writes[0].apvNumbers).toBeUndefined()
    expect((await testDb.check.findFirstOrThrow()).apvNumbers).toEqual(['AP-Z', 'AP-A'])
  })

  // INVERTED 2026-09-06. This used to assert that the same cheque number under
  // a different company was a DIFFERENT cheque, because `@@unique([companyId,
  // checkNumber])` is the only key duplicate prevention had. That assumption is
  // the defect: the register resolves a company from the cheque book and
  // Acumatica from the payment's Branch, they disagree on 1,865 cheques, and
  // every disagreement stored the one physical cheque twice. A BPI cheque
  // number belongs to exactly one cheque book, so two companies cannot both own
  // it — see the fallback block below for what happens instead now.
  //
  // What survives unchanged is the reason a row with NO company is staged
  // rather than guessed at, which the staging tests still pin.
  it('treats the same check number under a different company as the same check', async () => {
    await seedCompany('STK')
    await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')
    await upsert(row({ companyCode: 'STK', cashAccountCode: 'BPI STK', checkBookCode: null }))
    await upsert(row({ companyCode: 'A1+', cashAccountCode: 'BPI A1+', checkBookCode: null }))
    expect(await testDb.check.count()).toBe(1)
  })

  it('never changes status: a check a Finance user has SIGNED stays SIGNED', async () => {
    await seedCompany()
    const created = await upsert(row({ sourceSheet: 'MBTC P&P' }))
    const id = created.outcome === 'CREATED' ? created.checkId : ''
    await testDb.check.update({ where: { id }, data: { status: 'SIGNED' } })

    // The sheet says RELEASED. Acumatica and the register have no notion of
    // signing, so an import that wrote status would silently undo Finance's work.
    await upsert(row({ sourceSheet: 'BPI RELEASED' }))
    expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('SIGNED')
  })

  it('never changes any field Finance owns', async () => {
    const user = await makeUser()
    await seedCompany()
    const created = await upsert(row())
    const id = created.outcome === 'CREATED' ? created.checkId : ''

    // Every one of the immutable fields set to a distinctive value, so a field
    // the update touches shows up as a difference rather than as a coincidence.
    await testDb.check.update({
      where: { id },
      data: {
        status: 'RELEASED',
        signedById: user.id, signedAt: new Date('2026-02-01T01:00:00Z'),
        readyById: user.id, readyAt: new Date('2026-02-02T02:00:00Z'),
        availablePickupDate: new Date('2026-02-03T00:00:00Z'),
        scheduledPickupDate: new Date('2026-02-04T00:00:00Z'),
        scheduledPickupTime: '10:30', pickupRep: 'J. CRUZ',
        portalConfirmedAt: new Date('2026-02-05T03:00:00Z'),
        releasedById: user.id, releasedAt: new Date('2026-02-06T04:00:00Z'),
        orNumber: 'OR-000123', orDate: new Date('2026-02-07T00:00:00Z'), receiptType: 'OR',
        clearingStatus: 'DEPOSITED', crNumber: 'CR 6336',
        clearedDate: new Date('2026-02-08T00:00:00Z'),
        cancelledById: user.id, cancelledAt: new Date('2026-02-09T05:00:00Z'),
        cancelReason: 'a reason a human wrote',
        // Typed by Finance on the cheque page since 2026-09-11; a re-import
        // stating a different one below must not win.
        category: 'PAYROLL',
      },
    })
    const before = await testDb.check.findUniqueOrThrow({ where: { id } })

    await upsert(row({
      sourceSheet: 'CANCELLED', amount: '1.00', payeeName: 'SOMEONE ELSE',
      receiptRef: 'CR 99999', cvNumber: 'CV-ST-999999', category: 'UTILITIES',
    }))
    const after = await testDb.check.findUniqueOrThrow({ where: { id } })

    // Driven off the exported constant, so adding a field to it extends this
    // test automatically.
    for (const field of IMMUTABLE_ON_UPDATE) {
      expect({ [field]: after[field] }).toEqual({ [field]: before[field] })
    }
    // ...and the import did do its job on the fields it does own.
    expect(after.payeeName).toBe('SOMEONE ELSE')
    expect(after.cvNumber).toBe('CV-ST-999999')
  })

  // A future author adding a column to `Check` has to decide which of the three
  // it is. Doing nothing leaves it in none, and this fails.
  it('accounts for every column of Check exactly once', () => {
    // Written by neither path, and each for its own stated reason.
    const NEVER_WRITTEN_BY_IMPORT: readonly (keyof Check)[] = [
      'id', 'createdAt', 'updatedAt',
      'vendorId',                   // vendor merges are reported, never applied (Task 6)
      'eligibilityOverriddenById',  // a Finance override; the import reads it, never sets it
      'portalTradeId',              // the supplier portal's own key — Plan 3
      'remarks', 'pointPerson', 'checksPossession',   // free text Finance maintains
      'expectedOutflowDate',        // typed by Finance on the cheque page (2026-09-12); neither source can know it
      'statedReleaseDate',          // the register's stated day; written only by the stated-release-dates backfill (2026-09-28)
      'isStale',
      'voidedAt',                   // written only through voidCheck, never by a bare update
    ]

    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Check')
    expect(model).toBeDefined()
    const columns = model!.fields.filter((f) => f.kind !== 'object').map((f) => f.name)

    const all = [...IMMUTABLE_ON_UPDATE, ...IMPORT_WRITABLE, ...NEVER_WRITTEN_BY_IMPORT]
    expect(new Set(all).size).toBe(all.length)          // no field in two lists
    expect([...columns].sort()).toEqual([...all].sort())
  })

  it('writes a SYSTEM audit row on every update', async () => {
    await seedCompany()
    await upsert(row())
    await upsert(row({ amount: '200000.00' }))
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'import_updated' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
  })

  it('does not clear a stored value because the other source cannot see it', async () => {
    await seedCompany()
    await upsert(row())
    // An Acumatica row for the same cheque: the payments inquiry publishes no
    // category and no receipt reference, and its CashAccount (the cheque book,
    // spec §D) can be blank. Null there means "this feed does not carry it",
    // not "the register was wrong".
    await upsert(row({
      source: 'ACUMATICA', checkBookCode: null, cvNumber: null,
      checkDate: null, amount: null, sourceSheet: null, sourceRow: null,
      acumaticaDocType: 'Payment', acumaticaStatus: 'Closed',
    }))

    const check = await testDb.check.findFirstOrThrow()
    expect(check.cvNumber).toBe('CV-ST-004112')
    expect(check.amount?.toString()).toBe('197715.42')
    expect(check.checkDate).toEqual(new Date('2026-01-19T00:00:00Z'))
    expect(check.sourceSheet).toBe('BPI RELEASED')
    expect(check.checkBookId).not.toBeNull()
    // ...while what the feed does state is written.
    expect(check.acumaticaDocType).toBe('Payment')
  })

  it('moves a check to another book of its own company Acumatica now names, and records the move', async () => {
    const { company, cashAccount } = await seedCompany()
    const bookA = await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: cashAccount.bankId, companyId: company.id } })
    const bookB = await testDb.checkBook.create({ data: { code: 'BPI-S-4637', bankId: cashAccount.bankId, companyId: company.id } })
    await upsert(acumaticaRow({ CashAccount: 'BPI-S-4636' }))
    expect((await testDb.check.findFirstOrThrow()).checkBookId).toBe(bookA.id)

    const out = await upsert(acumaticaRow({ CashAccount: 'BPI-S-4637' }))
    expect(out).toMatchObject({ outcome: 'UPDATED' })
    const check = await testDb.check.findFirstOrThrow()
    expect(check.checkBookId).toBe(bookB.id)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'import_updated', checkId: check.id } })
    expect(audit.details).toMatchObject({
      checkBookChanged: { from: bookA.id, to: bookB.id, code: 'BPI-S-4637' },
    })
    expect(audit.details).not.toHaveProperty('checkBookRefused')
  })

  it('moves a check to a book Acumatica names under another company, and records the move (spec §E)', async () => {
    const { company, cashAccount } = await seedCompany()
    const a1 = await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')
    const bookA = await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: cashAccount.bankId, companyId: company.id } })
    const shared = await testDb.checkBook.create({ data: { code: 'BPI-A-7001', bankId: a1.cashAccount.bankId, companyId: a1.company.id } })
    await upsert(acumaticaRow({ CashAccount: 'BPI-S-4636' }))

    const out = await upsert(acumaticaRow({ CashAccount: 'BPI-A-7001' }))
    expect(out).toMatchObject({ outcome: 'UPDATED' })
    const check = await testDb.check.findFirstOrThrow()
    expect(check.companyId).toBe(company.id)
    expect(check.checkBookId).toBe(shared.id)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'import_updated', checkId: check.id } })
    expect(audit.details).toMatchObject({
      checkBookChanged: { from: bookA.id, to: shared.id, code: 'BPI-A-7001' },
    })
    expect(audit.details).not.toHaveProperty('checkBookRefused')
  })

  it('records no book change when Acumatica names the book already recorded', async () => {
    const { company, cashAccount } = await seedCompany()
    await testDb.checkBook.create({ data: { code: 'BPI-S-4636', bankId: cashAccount.bankId, companyId: company.id } })
    await upsert(acumaticaRow())
    await upsert(acumaticaRow())
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'import_updated' } })
    expect(audit.details).not.toHaveProperty('checkBookChanged')
    expect(audit.details).not.toHaveProperty('checkBookRefused')
  })
})

describe('upsertCheck — eligibility and the portal', () => {
  it('classifies through classifyEligibility and routes a supplier check', async () => {
    await seedCompany()
    await upsert(row({ payeeName: 'HENKEL PHILIPPINES INC.' }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.eligibility).toBe('SUPPLIER')
    expect(check.portalDomain).toBe('LOCAL')
    // Routing is decided; publishing is not. An import never queues a push.
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
  })

  it('gives an INTERNAL check no portal routing state at all', async () => {
    await seedCompany()
    await upsert(row({ payeeName: 'BUREAU OF INTERNAL REVENUE' }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.eligibility).toBe('INTERNAL')
    expect(check.portalDomain).toBeNull()
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
  })

  it('classifies a check with no payee INTERNAL, which is what keeps it off the portal', async () => {
    await seedCompany()
    await upsert(row({ payeeName: null }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.eligibility).toBe('INTERNAL')
    expect(check.portalDomain).toBeNull()
  })

  it('clears portal routing when a re-import reclassifies a check INTERNAL', async () => {
    await seedCompany()
    await upsert(row({ payeeName: 'HENKEL PHILIPPINES INC.' }))
    await upsert(row({ payeeName: 'SSS CONTRIBUTIONS' }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.eligibility).toBe('INTERNAL')
    expect(check.portalDomain).toBeNull()
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
  })

  it('leaves an eligibility a Finance user has overridden alone', async () => {
    const user = await makeUser()
    await seedCompany()
    const created = await upsert(row({ payeeName: 'HENKEL PHILIPPINES INC.' }))
    const id = created.outcome === 'CREATED' ? created.checkId : ''
    await testDb.check.update({
      where: { id },
      data: { eligibility: 'BROKER', portalDomain: 'BROKER', eligibilityOverriddenById: user.id },
    })

    await upsert(row({ payeeName: 'HENKEL PHILIPPINES INC.' }))
    const check = await testDb.check.findUniqueOrThrow({ where: { id } })
    expect(check.eligibility).toBe('BROKER')
    expect(check.portalDomain).toBe('BROKER')
  })

  // Not that the code sets the right thing — that the database refuses the wrong
  // thing. The application enforces this through portalRoute(); the constraint is
  // what stops a future caller, a migration or a manual UPDATE doing otherwise.
  it('is a database constraint, not a convention: the alternative is rejected', async () => {
    await seedCompany()
    const created = await upsert(row({ payeeName: 'BUREAU OF INTERNAL REVENUE' }))
    const id = created.outcome === 'CREATED' ? created.checkId : ''

    await expect(testDb.check.update({
      where: { id }, data: { portalDomain: 'LOCAL' },
    })).rejects.toThrow()

    await expect(testDb.check.update({
      where: { id }, data: { portalSyncStatus: 'PENDING' },
    })).rejects.toThrow()

    const check = await testDb.check.findUniqueOrThrow({ where: { id } })
    expect(check.portalDomain).toBeNull()
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
  })
})

describe('upsertCheck — staging', () => {
  it('stages a row whose company nothing resolves, whole and not dropped', async () => {
    await seedCompany()
    const out = await upsert(row({
      companyCode: null, cashAccountCode: null, checkBookCode: null, sourceRow: 77,
    }))
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'NO_COMPANY' })
    expect(await testDb.check.count()).toBe(0)

    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.reason).toBe('NO_COMPANY')
    expect(staged.checkNumber).toBe('6000319079')
    expect(staged.cvNumber).toBe('CV-ST-004112')
    expect(staged.amount?.toString()).toBe('197715.42')
    expect(staged.currency).toBe('PHP')
    expect(staged.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(staged.apvNumbers).toEqual(['APV-ST-009911'])
    expect(staged.receiptRef).toBe('CR 12345')
    expect(staged.checkDate).toEqual(new Date('2026-01-19T00:00:00Z'))
    // The status the sheet implied is kept, so promotion later does not have to
    // re-derive it from a sheet name nobody has any more.
    expect(staged.impliedStatus).toBe('RELEASED')
    expect(staged.sourceSheet).toBe('BPI RELEASED')
    expect(staged.sourceRow).toBe(77)
    expect(staged.promotedCheckId).toBeNull()
  })

  it('stages a row that cannot be keyed at all', async () => {
    await seedCompany()
    const out = await upsert(row({ checkNumber: null }))
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'NO_CHECK_NUMBER' })
    expect(await testDb.check.count()).toBe(0)
    expect((await testDb.stagedCheck.findFirstOrThrow()).checkNumber).toBeNull()
  })

  it('re-staging the same sheet and row updates rather than duplicating', async () => {
    await seedCompany()
    await upsert(row({ companyCode: null, amount: '1.00' }))
    await upsert(row({ companyCode: null, amount: '2.00' }))
    expect(await testDb.stagedCheck.count()).toBe(1)
    expect((await testDb.stagedCheck.findFirstOrThrow()).amount?.toString()).toBe('2')
  })

  it('refuses to drop a row it cannot stage for want of provenance', async () => {
    // CHANGED 2026-09-04. This used to assert that EVERY Acumatica row was
    // unstageable, because `StagedCheck` could only be keyed on a sheet and a
    // row number. That was the schema obstacle behind defect 4, and it is gone:
    // an Acumatica row is now keyed on its own ReferenceNbr. What survives is
    // the real rule — a row with NO identity of either kind is thrown rather
    // than silently returned, because silently returning loses a payment.
    await seedCompany()
    await expect(upsert(row({
      source: 'ACUMATICA', companyCode: null,
      sourceSheet: null, sourceRow: null,
      acumaticaPaymentId: null, acumaticaTenant: 'GOLIVE',
    }))).rejects.toMatchObject({ code: 'CANNOT_STAGE' })

    // Nor a tenant-less one: `ST` is a different company in each tenant, so a
    // staged row that does not say which tenant it came from is not keyable.
    await expect(upsert(row({
      source: 'ACUMATICA', companyCode: null,
      sourceSheet: null, sourceRow: null,
      acumaticaPaymentId: 'CV-ST-004112', acumaticaTenant: null,
    }))).rejects.toMatchObject({ code: 'CANNOT_STAGE' })
  })

  it('refuses a company code no Company row carries, rather than staging thousands', async () => {
    // A code the row states but the database does not hold is a seeding fault,
    // not a fact about the cheque. Staging it would bury a configuration error
    // under thousands of "unknown company" rows.
    await seedCompany('STK')
    await expect(upsert(row({ companyCode: 'NOPE' })))
      .rejects.toMatchObject({ code: 'UNKNOWN_COMPANY' })
  })
})

describe('upsertCheck — another payment on a number already held (full check 2026-10-06)', () => {
  it('stages a voided original instead of voiding the live re-issue that holds its number', async () => {
    await seedCompany()
    // The re-issue is here first (CV-A1009798 in production), live.
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-RE-2', PaymentRef: 'BPI 6000400009', Status: 'Closed' }))
    // The voided original on the same number, under its own payment reference.
    const out = await upsert(acumaticaRow({ ReferenceNbr: 'CV-RE-1', PaymentRef: 'BPI 6000400009', Status: 'Voided' }))

    expect(out.outcome).toBe('STAGED')
    if (out.outcome === 'STAGED') expect(out.reason).toBe('SHARED_NUMBER')
    const check = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400009' } })
    expect(check.status).not.toBe('VOIDED')
    expect(check.acumaticaPaymentId).toBe('CV-RE-2')
    expect(check.acumaticaStatus).toBe('Closed')
    const staged = await testDb.stagedCheck.findFirstOrThrow({ where: { acumaticaRef: 'CV-RE-1' } })
    expect(staged.reason).toBe('SHARED_NUMBER')
  })

  it('stages a second LIVE payment on a held number rather than writing its facts over the first', async () => {
    await seedCompany()
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-TWO-1', PaymentRef: 'BPI 6000400010', PaymentAmount: '100.00' }))
    const out = await upsert(acumaticaRow({ ReferenceNbr: 'CV-TWO-2', PaymentRef: 'BPI 6000400010', PaymentAmount: '999.00' }))
    expect(out.outcome).toBe('STAGED')
    const check = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400010' } })
    expect(check.amount?.toFixed(2)).toBe('100.00')
  })

  it('stages a payment under ANOTHER company whose number a different payment holds (shared books)', async () => {
    await seedCompany()
    await seedCompany('A1+', 'A1 Plus Inc.')
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-ST-HELD', PaymentRef: 'BPI 6000400012', Branch: 'ST' }))
    const out = await upsert(acumaticaRow({ ReferenceNbr: 'CV-A1-NEW', PaymentRef: 'BPI 6000400012', Branch: 'A1+', Status: 'Voided' }))

    expect(out.outcome).toBe('STAGED')
    if (out.outcome === 'STAGED') expect(out.reason).toBe('SHARED_NUMBER')
    const check = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000400012' }, include: { company: true } })
    expect(check.acumaticaPaymentId).toBe('CV-ST-HELD')
    expect(check.company.code).toBe('STK')
    expect(check.status).not.toBe('VOIDED')
  })

  it('still updates the payment it holds, re-read under its own reference', async () => {
    await seedCompany()
    await upsert(acumaticaRow({ ReferenceNbr: 'CV-SAME', PaymentRef: 'BPI 6000400011', PaymentAmount: '100.00' }))
    const out = await upsert(acumaticaRow({ ReferenceNbr: 'CV-SAME', PaymentRef: 'BPI 6000400011', PaymentAmount: '150.00' }))
    expect(out.outcome).toBe('UPDATED')
  })
})

describe('upsertCheck — voiding', () => {
  it('voids a check Acumatica reports voided, through the domain action', async () => {
    await seedCompany()
    await upsert(row({
      source: 'ACUMATICA', voided: true, sourceSheet: null, sourceRow: null,
      acumaticaDocType: 'Voided Payment', acumaticaStatus: 'Closed',
    }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.status).toBe('VOIDED')
    expect(check.voidedAt).toEqual(NOW)

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'voided' } })
    expect(audit.actorType).toBe('SYSTEM')

    // The row's payee (HENKEL) is a SUPPLIER, and still nothing is queued
    // (user ruling 2026-10-29): the void detaches the cheque from the voucher
    // the row carried, so the portal has no APV to match it on and the bill
    // belongs to whichever live cheque pays it now.
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(check.apvNumbers).toEqual([])
    expect(audit.details).toMatchObject({ portalNotified: false, apvNumbersDetached: ['APV-ST-009911'] })
  })

  it('a re-import of a voided check does not re-link the voucher the void detached', async () => {
    await seedCompany()
    const voidedRow = row({
      source: 'ACUMATICA', voided: true, sourceSheet: null, sourceRow: null,
      acumaticaDocType: 'Voided Payment', acumaticaStatus: 'Closed',
    })
    await upsert(voidedRow)
    // The register's row for the same cheque, naming the voucher again.
    await upsert(row({ apvNumbers: ['APV-ST-009911', 'APV-ST-009912'] }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.status).toBe('VOIDED')
    expect(check.apvNumbers).toEqual([])
  })

  it('a check created already voided, with no APV, queues no portal event (spec 2026-10-01 §A1)', async () => {
    await seedCompany()
    await upsert(row({
      source: 'ACUMATICA', voided: true, sourceSheet: null, sourceRow: null, apvNumbers: [],
      acumaticaDocType: 'Voided Payment', acumaticaStatus: 'Closed',
    }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.status).toBe('VOIDED')
    expect(check.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: check.id } })).toBe(0)
  })

  it('is idempotent: re-importing a voided check does not void it twice', async () => {
    await seedCompany()
    const voidedRow = row({
      source: 'ACUMATICA', voided: true, sourceSheet: null, sourceRow: null,
      acumaticaDocType: 'Voided Payment', acumaticaStatus: 'Closed',
    })
    await upsert(voidedRow)
    await upsert(voidedRow)
    const check = await testDb.check.findFirstOrThrow()
    expect(check.status).toBe('VOIDED')
    expect(await testDb.auditLog.count({ where: { action: 'voided' } })).toBe(1)
  })

  it('records a void it cannot apply instead of throwing the import away', async () => {
    // CANCELLED is a terminal Finance decision with a recorded reason, so the
    // state machine refuses CANCELLED -> VOIDED. The disagreement between this
    // system and the ERP is still a fact somebody has to see.
    await seedCompany()
    const created = await upsert(row())
    const id = created.outcome === 'CREATED' ? created.checkId : ''
    await testDb.check.update({ where: { id }, data: { status: 'CANCELLED' } })

    await upsert(row({ voided: true, acumaticaDocType: 'Voided Payment' }))
    const check = await testDb.check.findUniqueOrThrow({ where: { id } })
    expect(check.status).toBe('CANCELLED')

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'void_not_applied' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({ currentStatus: 'CANCELLED' })

    // The refused transition never calls `voidCheck`, so it queues nothing —
    // covered by the file's blanket afterEach for non-CANCELLED kinds, and
    // asserted directly here because this is the one test in the file where a
    // CANCELLED event could otherwise slip through unnoticed.
    expect(await testDb.portalEvent.count({ where: { checkId: id } })).toBe(0)
  })

  it('makes a void after release conspicuous', async () => {
    await seedCompany()
    const created = await upsert(row({ sourceSheet: 'BPI RELEASED' }))
    const id = created.outcome === 'CREATED' ? created.checkId : ''
    expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('RELEASED')

    await upsert(row({ sourceSheet: 'BPI RELEASED', voided: true, acumaticaDocType: 'Voided Payment' }))
    const check = await testDb.check.findUniqueOrThrow({ where: { id } })
    expect(check.status).toBe('VOIDED')

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'voided_after_release' } })
    expect(audit.remarks).toContain(VOID_AFTER_RELEASE_WARNING)

    // A cheque already published as AVAILABLE and then voided still needs the
    // supplier told — the portal event is queued here too, warning or not.
    expect(await testDb.portalEvent.count({ where: { checkId: id, kind: 'CANCELLED' } })).toBe(1)
  })
})

describe('upsertCheck — the contradiction ruling', () => {
  const SHEETS = ['BPI RELEASED', 'CANCELLED']

  it('applies the ruling and records why, naming sheets, statuses and the choice', async () => {
    await seedCompany()
    await upsert(row({ sourceSheet: 'CANCELLED' }), SHEETS)

    const check = await testDb.check.findFirstOrThrow()
    // 25 cheques. RELEASED + CANCELLED resolves to RELEASED.
    expect(check.status).toBe('RELEASED')

    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: 'implied_status_resolved' },
    })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.details).toMatchObject({
      sheets: SHEETS,
      implied: ['CANCELLED', 'RELEASED'],
      chosen: 'RELEASED',
      status: 'RELEASED',
      basis: FINANCE_RULING_BASIS,
    })
    expect(audit.remarks).toContain('BPI RELEASED')
    expect(audit.remarks).toContain('CANCELLED')
    expect(audit.remarks).toContain(FINANCE_RULING_BASIS)
  })

  it('records nothing when the sheets do not clash', async () => {
    await seedCompany()
    await upsert(row({ sourceSheet: 'BPI RELEASED' }))
    expect(await testDb.auditLog.count({ where: { action: 'implied_status_resolved' } })).toBe(0)
  })

  it('lets an unruled clash throw, and writes nothing', async () => {
    // A combination Finance has not ruled on is a fact about money nobody has
    // decided. Picking one of the candidates is exactly the invention this
    // importer exists to avoid.
    await seedCompany()
    await expect(upsert(row(), ['FT & MC', 'BPI RELEASED']))
      .rejects.toMatchObject({ code: 'UNRULED_STATUS_CLASH' })
    expect(await testDb.check.count()).toBe(0)
    expect(await testDb.stagedCheck.count()).toBe(0)
  })
})

// Finance ruling of 2026-09-03. Measured against the real register: 27 cheque
// numbers resolve to more than one company, across 61 rows. 25 of the 27 are one
// cheque entered twice under a different checkbook code with an identical amount
// and payee; importing both rows would file one physical cheque under two
// companies and double-count PHP 6,779,371.05. The other 2 carry genuinely
// different payees and amounts under one number — the register disagreeing with
// itself. One rule covers all 27: stage every row, import none.
//
// This is NOT the conflict `resolveCompany` settles. That one is within a single
// row (both signals present and disagreeing, 17 rows, cash account wins). This
// one is across rows sharing a cheque number, which `resolveCompany` cannot see
// because it only ever looks at one row.
describe('upsertCheck — a check number claimed by two companies', () => {
  async function twoCompanies() {
    await seedCompany('STK')
    await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')
  }

  it('stages every row for the check number and imports none of them', async () => {
    await twoCompanies()
    const claimed = ['STK', 'A1+']

    const a = await upsertCheck(testDb, {
      row: row({ checkNumber: '6000146861', companyCode: 'STK', sourceSheet: 'BPI A1 RELEASED', sourceRow: 5 }),
      ownCompanyNames: OWN_COMPANIES, now: NOW, companies: claimed,
    })
    const b = await upsertCheck(testDb, {
      row: row({ checkNumber: '6000146861', companyCode: 'A1+', sourceSheet: 'BPI A1 RELEASED', sourceRow: 6 }),
      ownCompanyNames: OWN_COMPANIES, now: NOW, companies: claimed,
    })

    expect(a).toMatchObject({ outcome: 'STAGED', reason: 'AMBIGUOUS_COMPANY' })
    expect(b).toMatchObject({ outcome: 'STAGED', reason: 'AMBIGUOUS_COMPANY' })
    expect(await testDb.check.count()).toBe(0)
    expect(await testDb.stagedCheck.count()).toBe(2)
  })

  it('records what each row claimed, so a human can settle it without the workbook', async () => {
    await twoCompanies()
    await upsertCheck(testDb, {
      row: row({
        checkNumber: '6000146861', companyCode: 'STK',
        checkBookCode: 'BPI-S-4636', sourceSheet: 'BPI A1 RELEASED', sourceRow: 5,
      }),
      ownCompanyNames: OWN_COMPANIES, now: NOW, companies: ['STK', 'A1+'],
    })
    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.companyCode).toBe('STK')                 // what this row's signal claimed
    expect(staged.conflictingCompanies).toEqual(['STK', 'A1+'])  // and what the number claimed
    expect(staged.checkBookCode).toBe('BPI-S-4636')
    expect(staged.sourceSheet).toBe('BPI A1 RELEASED')
    expect(staged.sourceRow).toBe(5)
  })

  // The other 2 of the 27 carry different payees and amounts. Deliberately not
  // special-cased: the same rule catches them, and a rule with an exception for
  // "obviously the same cheque" is a rule that decides which cheque is real.
  it('does not special-case the rows that genuinely differ', async () => {
    await twoCompanies()
    const out = await upsertCheck(testDb, {
      row: row({ checkNumber: '6000308995', companyCode: 'STK', amount: '1000.00', sourceRow: 1 }),
      ownCompanyNames: OWN_COMPANIES, now: NOW, companies: ['STK', 'A1+'],
    })
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'AMBIGUOUS_COMPANY' })
  })

  // A row of an ambiguous number that resolves no company of its own is still a
  // row of that number, and the ruling says every one of them is staged. Filing
  // it under NO_COMPANY instead would split one cheque's evidence across two
  // buckets, which is exactly what a human settling it must not have to notice.
  it('stages an unresolved row of an ambiguous number under the ambiguity', async () => {
    await twoCompanies()
    const out = await upsertCheck(testDb, {
      row: row({ checkNumber: '6000146861', companyCode: null, sourceRow: 7 }),
      ownCompanyNames: OWN_COMPANIES, now: NOW, companies: ['STK', 'A1+'],
    })
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'AMBIGUOUS_COMPANY' })
  })
})

describe('upsertCheck — a check already stored under the wrong company', () => {
  async function twoCompanies() {
    const stk = await seedCompany('STK')
    const a1 = await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')
    return { stk: stk.company, a1: a1.company }
  }

  // The Acumatica half of the pair, as the sync presents it: no sheet, no row
  // number, a Branch and a tenant, and the company that Branch resolves to.
  const feed = (overrides: Partial<NormalisedRow> = {}): NormalisedRow => row({
    source: 'ACUMATICA',
    companyCode: 'A1+',
    cashAccountCode: null,
    checkBookCode: null,
    cvNumber: null,
    sourceSheet: null,
    sourceRow: null,
    acumaticaPaymentId: 'CV-A1-004112',
    acumaticaDocType: 'Payment',
    acumaticaStatus: 'Closed',
    acumaticaBranch: 'A1+',
    acumaticaTenant: 'GOLIVE',
    ...overrides,
  })

  it('finds the check under the other company and corrects it, rather than storing it twice', async () => {
    const { a1 } = await twoCompanies()
    const first = await upsert(row({ checkNumber: '6000308848', companyCode: 'STK' }))
    const second = await upsert(feed({ checkNumber: '6000308848' }))

    expect(second).toMatchObject({ outcome: 'UPDATED' })
    expect(first.outcome === 'CREATED' && second.outcome === 'UPDATED'
      && first.checkId === second.checkId).toBe(true)
    expect(await testDb.check.count()).toBe(1)

    const check = await testDb.check.findFirstOrThrow()
    expect(check.companyId).toBe(a1.id)
    expect(check.acumaticaBranch).toBe('A1+')
  })

  it('audits the correction, naming the company it left, the one it moved to and who said so', async () => {
    await twoCompanies()
    await upsert(row({ checkNumber: '6000308848', companyCode: 'STK' }))
    await upsert(feed({ checkNumber: '6000308848' }))

    const audit = await testDb.auditLog.findFirstOrThrow({
      where: { action: 'check_company_corrected' },
    })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.details).toMatchObject({
      source: 'ACUMATICA',
      checkNumber: '6000308848',
      previousCompanyCode: 'STK',
      companyCode: 'A1+',
      acumaticaBranch: 'A1+',
      acumaticaTenant: 'GOLIVE',
      basis: COMPANY_RULING_BASIS,
    })
    expect(audit.remarks).toContain('STK')
    expect(audit.remarks).toContain('A1+')
  })

  it('leaves the status and releasedAt the register established untouched', async () => {
    const user = await makeUser()
    const { a1 } = await twoCompanies()
    const created = await upsert(row({ checkNumber: '6000308848', companyCode: 'STK' }))
    const id = created.outcome === 'CREATED' ? created.checkId : ''
    await testDb.check.update({
      where: { id },
      data: {
        status: 'RELEASED',
        releasedById: user.id,
        releasedAt: new Date('2026-02-06T04:00:00Z'),
      },
    })
    const before = await testDb.check.findUniqueOrThrow({ where: { id } })

    // Acumatica reports this one as SIGNATURE_PENDING work in progress. Only
    // the company moves.
    await upsert(feed({ checkNumber: '6000308848' }))
    const after = await testDb.check.findUniqueOrThrow({ where: { id } })

    for (const field of IMMUTABLE_ON_UPDATE) {
      expect({ [field]: after[field] }).toEqual({ [field]: before[field] })
    }
    expect(after.status).toBe('RELEASED')
    expect(after.releasedAt).toEqual(new Date('2026-02-06T04:00:00Z'))
    expect(after.companyId).toBe(a1.id)
  })

  it('stages rather than guessing when two checks already carry the number', async () => {
    const { stk, a1 } = await twoCompanies()
    await seedCompany('STPP', 'Starkson Paper and Plastic')
    // The pre-existing pair this fix exists to prevent, created directly so the
    // test states the state it is about rather than depending on how it arose.
    for (const company of [stk, a1]) {
      await testDb.check.create({
        data: { companyId: company.id, checkNumber: '6000308848', eligibility: 'SUPPLIER' },
      })
    }

    const out = await upsert(feed({ checkNumber: '6000308848', companyCode: 'STPP' }))
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'AMBIGUOUS_COMPANY' })
    // Nothing written, nothing chosen.
    expect(await testDb.check.count()).toBe(2)

    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.checkNumber).toBe('6000308848')
    expect(staged.companyCode).toBe('STPP')
    expect([...staged.conflictingCompanies].sort()).toEqual(['A1+', 'STK', 'STPP'])
  })

  it('still creates a check whose number nothing carries', async () => {
    await twoCompanies()
    await upsert(row({ checkNumber: '6000308848', companyCode: 'STK' }))
    const out = await upsert(feed({ checkNumber: '6000399999' }))

    expect(out).toMatchObject({ outcome: 'CREATED' })
    expect(await testDb.check.count()).toBe(2)
    expect(await testDb.auditLog.count({ where: { action: 'check_company_corrected' } })).toBe(0)
  })

  it('does not audit a correction on an ordinary re-import of the same company', async () => {
    await twoCompanies()
    await upsert(row({ checkNumber: '6000308848', companyCode: 'STK' }))
    await upsert(row({ checkNumber: '6000308848', companyCode: 'STK', amount: '200000.00' }))
    expect(await testDb.auditLog.count({ where: { action: 'check_company_corrected' } })).toBe(0)
  })
})

describe('importRows — running the whole import', () => {
  // The ambiguity cannot be decided row by row as the register streams past: a
  // cheque number's full set of companies has to be known before any row for it
  // is written. So the batch groups first and writes second, and this is the
  // entry point the importer uses.
  function batch(): NormalisedRow[] {
    return [
      row({ checkNumber: '6000000001', sourceRow: 1 }),
      row({ checkNumber: '6000000002', sourceRow: 2, payeeName: 'BUREAU OF INTERNAL REVENUE' }),
      row({ checkNumber: '6000000003', sourceRow: 3, companyCode: null, checkBookCode: null }),
      row({ checkNumber: null, sourceRow: 4 }),
      // One cheque number, two companies, on two rows.
      row({ checkNumber: '6000146861', companyCode: 'STK', sourceRow: 5 }),
      row({ checkNumber: '6000146861', companyCode: 'A1+', checkBookCode: null, sourceRow: 6 }),
    ]
  }

  const runImport = () =>
    importRows(testDb, { rows: batch(), ownCompanyNames: OWN_COMPANIES, now: NOW })

  it('accounts for every row: nothing imported twice and nothing dropped', async () => {
    await seedCompany('STK')
    await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')

    const summary = await runImport()
    expect(summary).toEqual({
      rows: 6,
      created: 2,
      updated: 0,
      staged: 4,
      stagedByReason: { NO_COMPANY: 1, NO_CHECK_NUMBER: 1, AMBIGUOUS_COMPANY: 2, SHARED_NUMBER: 0 },
    })
    expect(summary.created + summary.updated + summary.staged).toBe(summary.rows)
    expect(await testDb.check.count()).toBe(2)
    expect(await testDb.stagedCheck.count()).toBe(4)
  })

  it('is idempotent: same counts, no duplicate checks, no duplicate staged rows', async () => {
    await seedCompany('STK')
    await seedCompany('A1+', 'A1+ Multinational Packaging Inc.')

    await runImport()
    const second = await runImport()
    expect(second).toEqual({
      rows: 6,
      created: 0,
      updated: 2,
      staged: 4,
      stagedByReason: { NO_COMPANY: 1, NO_CHECK_NUMBER: 1, AMBIGUOUS_COMPANY: 2, SHARED_NUMBER: 0 },
    })
    expect(await testDb.check.count()).toBe(2)
    expect(await testDb.stagedCheck.count()).toBe(4)
  })

  it('resolves the implied status from every sheet a check appears on', async () => {
    await seedCompany('STK')
    await importRows(testDb, {
      rows: [
        row({ checkNumber: '6000319079', sourceSheet: 'BPI RELEASED', sourceRow: 10 }),
        row({ checkNumber: '6000319079', sourceSheet: 'CANCELLED', sourceRow: 11 }),
      ],
      ownCompanyNames: OWN_COMPANIES,
      now: NOW,
    })
    // 25 cheques: RELEASED + CANCELLED resolves to RELEASED, and the ruling is
    // recorded once, on the create.
    expect((await testDb.check.findFirstOrThrow()).status).toBe('RELEASED')
    expect(await testDb.auditLog.count({ where: { action: 'implied_status_resolved' } })).toBe(1)
  })
})

describe('upsertCheck — staging a payment that came from Acumatica', () => {
  // 80 live rows are PaymentMethod CHK — genuinely cheques — whose PaymentRef
  // is free text ("Oct interest"). They cannot be keyed on (company,
  // checkNumber), and Finance ruled on 2026-09-04 that they are staged like the
  // register's 66 numberless rows rather than dropped or given an invented
  // number. `StagedCheck` could only be keyed on (sourceSheet, sourceRow) until
  // then, which an Acumatica row has neither of.
  const feedRow = (overrides: Partial<NormalisedRow> = {}): NormalisedRow => row({
    source: 'ACUMATICA',
    checkNumber: null,
    statedCheckRef: 'Oct interest',
    acumaticaPaymentId: 'CV-ST011550',
    cvNumber: 'CV-ST011550',
    acumaticaTenant: 'GOLIVE',
    acumaticaDocType: 'Payment',
    acumaticaStatus: 'Closed',
    acumaticaBranch: 'ST',
    checkBookCode: null,
    apvNumbers: [],
    poNumbers: [],
    receiptRef: null,
    sourceSheet: null,
    sourceRow: null,
    ...overrides,
  })

  it('stages a check whose reference is a memo instead of a number', async () => {
    await seedCompany()
    const out = await upsert(feedRow())
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'NO_CHECK_NUMBER' })
    expect(await testDb.check.count()).toBe(0)

    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.source).toBe('ACUMATICA')
    expect(staged.checkNumber).toBeNull()
    // The memo is preserved so a human can supply the real cheque number. It is
    // NEVER written to checkNumber — that would be a made-up key.
    expect(staged.statedCheckRef).toBe('Oct interest')
  })

  it('keys the staged row on the payment’s own ReferenceNbr, not an invented sheet', async () => {
    await seedCompany()
    await upsert(feedRow())

    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.acumaticaRef).toBe('CV-ST011550')
    expect(staged.acumaticaTenant).toBe('GOLIVE')
    // No fake sheet name to squeeze into the register's key. A row that never
    // came from a workbook has no cell to point a human at, and pretending
    // otherwise would put 'ACUMATICA' in a column a reconciliation report reads
    // as a sheet.
    expect(staged.sourceSheet).toBeNull()
    expect(staged.sourceRow).toBeNull()
  })

  it('preserves the payment whole, so nothing has to be looked up again', async () => {
    await seedCompany()
    await upsert(feedRow())
    const staged = await testDb.stagedCheck.findFirstOrThrow()

    expect(staged.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(staged.amount?.toString()).toBe('197715.42')
    expect(staged.currency).toBe('PHP')
    expect(staged.checkDate).toEqual(new Date('2026-01-19T00:00:00Z'))
    expect(staged.cvNumber).toBe('CV-ST011550')
    expect(staged.companyCode).toBe('STK')
    expect(staged.promotedCheckId).toBeNull()
  })

  it('re-running the sync over the same payment updates rather than duplicating', async () => {
    await seedCompany()
    await upsert(feedRow({ amount: '1.00' }))
    await upsert(feedRow({ amount: '2.00' }))

    expect(await testDb.stagedCheck.count()).toBe(1)
    expect((await testDb.stagedCheck.findFirstOrThrow()).amount?.toString()).toBe('2')
  })

  it('keeps the two tenants apart, because ReferenceNbr repeats across them', async () => {
    // Go-Live ST is Starkson Packaging and MANUFACTURING ST is Starkson Paper
    // and Plastic, and both tenants number their vouchers CV-ST…. One key on
    // the reference alone would collapse two different payments into one.
    await seedCompany('STK')
    await seedCompany('STPP', 'Starkson Paper and Plastic Inc.')
    await upsert(feedRow({ acumaticaTenant: 'GOLIVE', companyCode: 'STK' }))
    await upsert(feedRow({ acumaticaTenant: 'MANUFACTURING', companyCode: 'STPP' }))

    expect(await testDb.stagedCheck.count()).toBe(2)
  })

  it('does not collide with a register row staged under the same check number', async () => {
    await seedCompany()
    await upsert(row({ companyCode: null, sourceSheet: 'BPI RELEASED', sourceRow: 77 }))
    await upsert(feedRow({ checkNumber: null }))
    expect(await testDb.stagedCheck.count()).toBe(2)

    const rows = await testDb.stagedCheck.findMany()
    expect(rows.map((s) => s.source).sort()).toEqual(['ACUMATICA', 'WORKBOOK'])
  })

  it('stages an Acumatica row whose branch resolves no company, rather than losing it', async () => {
    // Not the defect-4 case, but the same obstacle: before the source
    // discriminator existed this threw and the payment was counted as an error
    // and left nowhere. 0 of 320 measured live rows resolved no company, so
    // this is rare — which is exactly why it must not be a silent loss.
    await seedCompany()
    const out = await upsert(feedRow({ checkNumber: '6000319079', companyCode: null }))
    expect(out).toMatchObject({ outcome: 'STAGED', reason: 'NO_COMPANY' })
    expect((await testDb.stagedCheck.findFirstOrThrow()).source).toBe('ACUMATICA')
  })
})

// `isIncomplete` is a stored derivation of "the amount is not recorded", and a
// stored derivation drifts unless every writer maintains it. The import is the
// only writer of `amount`, so it is the only place that can.
describe('upsertCheck — the incomplete flag', () => {
  it('flags a created check whose row carries no amount', async () => {
    await seedCompany()
    await upsert(row({ amount: null }))
    expect((await testDb.check.findFirstOrThrow()).isIncomplete).toBe(true)
  })

  it('does not flag a created check that has an amount', async () => {
    await seedCompany()
    await upsert(row())
    expect((await testDb.check.findFirstOrThrow()).isIncomplete).toBe(false)
  })

  it('clears the flag when a later row finally supplies the amount', async () => {
    await seedCompany()
    await upsert(row({ amount: null }))
    await upsert(row({ amount: '197715.42' }))
    expect((await testDb.check.findFirstOrThrow()).isIncomplete).toBe(false)
  })

  // The counterpart of `keep()`: a null amount on an update means "this source
  // does not carry it", never "clear what you have". The stored amount stands,
  // so the flag must stand with it — deriving the flag from `row.amount` alone
  // would flag a cheque whose amount the register recorded perfectly well, on
  // the next Acumatica sync that happened not to publish one.
  it('does not flag a check whose amount the other source simply does not carry', async () => {
    await seedCompany()
    await upsert(row())
    await upsert(row({
      source: 'ACUMATICA', amount: null, checkBookCode: null, cvNumber: null,
      sourceSheet: null, sourceRow: null,
    }))
    const check = await testDb.check.findFirstOrThrow()
    expect(check.amount?.toString()).toBe('197715.42')
    expect(check.isIncomplete).toBe(false)
  })
})
