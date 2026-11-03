import { describe, it, expect, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { testDatabaseUrl } from './helpers/test-db-url'
import { checkReadyForRelease } from '@/lib/domain/check-status'

const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } })

const createdCompanyIds: string[] = []
const createdBankIds: string[] = []

// The test database is a real cloud database, not an ephemeral container.
// A test that inserts without cleaning up grows it without bound on every run.
// Order matters: children before parents, and a cash account is a child of both
// a company and a bank.
afterAll(async () => {
  // PortalEvent is a child of Check and the queue tests below write them
  // directly, so it goes before the checks it references.
  await prisma.portalEvent.deleteMany({
    where: { check: { companyId: { in: createdCompanyIds } } },
  })
  await prisma.check.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.cashAccount.deleteMany({ where: { companyId: { in: createdCompanyIds } } })
  await prisma.company.deleteMany({ where: { id: { in: createdCompanyIds } } })
  await prisma.bank.deleteMany({ where: { id: { in: createdBankIds } } })
  await prisma.$disconnect()
})

describe('schema', () => {
  it('enforces the composite unique key on company + check number', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}`, name: 'Test Co', legalNames: [] },
    })
    createdCompanyIds.push(company.id)

    const base = {
      companyId: company.id,
      checkNumber: '6000000001',
      amount: '100.00',
      payeeName: 'ACME',
      eligibility: 'SUPPLIER' as const,
    }
    await prisma.check.create({ data: base })
    await expect(prisma.check.create({ data: base })).rejects.toThrow()
  })

  // The register does not always know what it is paying or to whom: 397 of its
  // 12,161 rows carry no amount and 153 no payee. Storing 0.00 would understate
  // every total the cheque appears in and storing '' would read as a cheque
  // payable to nobody, so both columns are NULL-able and NULL means exactly
  // "the register does not record it".
  it('stores a check whose amount and payee the register does not record', async () => {
    const company = await prisma.company.create({
      data: { code: `T${Date.now()}N`, name: 'Test Co', legalNames: [] },
    })
    createdCompanyIds.push(company.id)
    const bank = await prisma.bank.create({ data: { code: `B${Date.now()}`, name: 'BPI' } })
    createdBankIds.push(bank.id)
    const cashAccount = await prisma.cashAccount.create({
      data: { code: `BPI STK ${Date.now()}`, bankId: bank.id, companyId: company.id },
    })

    const created = await prisma.check.create({
      data: {
        companyId: company.id,
        cashAccountId: cashAccount.id,
        checkNumber: '6000000002',
        checkDate: new Date('2026-09-01'),
        amount: null,
        payeeName: null,
        eligibility: 'INTERNAL',      // which is what a null payee classifies as
        status: 'SIGNED',
      },
    })

    const row = await prisma.check.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.amount).toBeNull()
    expect(row.payeeName).toBeNull()

    // And the consequence that makes the nulls safe to store: the release guard
    // already refuses such a cheque, naming both gaps, so it imports and is
    // visible but cannot be handed to a supplier until someone fills them in.
    // The exact string is the one Plan 1 shipped - it is user-facing copy, so
    // assert it verbatim rather than matching a substring.
    const guard = checkReadyForRelease({
      status: row.status,
      checkNumber: row.checkNumber,
      payeeName: row.payeeName,
      amount: row.amount?.toString() ?? null,
      checkDate: row.checkDate,
      cashAccountCode: cashAccount.code,
      availablePickupDate: new Date('2026-09-02'),
      isCheque: row.isCheque,
    })
    expect(guard.ok).toBe(false)
    expect(guard).toEqual({
      ok: false,
      code: 'MISSING_FIELDS',
      message: 'This check cannot be released because required information is missing: PAYEE, AMOUNT.',
    })
  })
})

// Shared by the queue tests below and the CANCELLED test further down.
// Fixtures are built with this file's own `prisma` client and registered in
// `createdCompanyIds` for the `afterAll` cleanup, rather than through
// `tests/helpers/factory.ts`. The factory writes through `testDb` and creates
// a bank and a cash account this file's `afterAll` does not know about, and
// this suite runs against a real cloud database that a leaking test grows on
// every run.
async function makeQueueCheck(
  suffix: string,
  status?: 'GENERATED' | 'SIGNATURE_PENDING' | 'SIGNED' | 'READY_FOR_RELEASE' | 'SCHEDULED' | 'RELEASED' | 'CANCELLED' | 'VOIDED',
) {
  const company = await prisma.company.create({
    data: { code: `T${Date.now()}${suffix}`, name: 'Test Co', legalNames: [] },
  })
  createdCompanyIds.push(company.id)
  return prisma.check.create({
    data: {
      companyId: company.id,
      checkNumber: `600000${suffix}`,
      amount: '100.00',
      payeeName: 'ACME',
      eligibility: 'SUPPLIER',
      ...(status ? { status } : {}),
    },
  })
}

// The queue `lib/portal/outbox.ts` will work. Both properties asserted here are
// about the same thing: a worker must never be handed the same instruction
// twice, because a duplicate MARK_AVAILABLE is a second message to a supplier
// about one cheque.
describe('PortalEvent as a queue', () => {
  it('rejects a status outside the enum', async () => {
    const check = await makeQueueCheck('Q1')
    await expect(prisma.portalEvent.create({
      data: {
        checkId: check.id, direction: 'OUT', kind: 'MARK_AVAILABLE',
        // @ts-expect-error - proving the column is an enum, not a free string
        status: 'DEFINITELY_NOT_A_STATUS',
        payload: {},
        idempotencyKey: `${check.id}:MARK_AVAILABLE:enum-probe`,
      },
    })).rejects.toThrow()
  })

  // The other direction of the same key — that a genuinely NEW instruction gets
  // a new key — is asserted at the domain level in tests/actions/actions.test.ts,
  // where the timestamp that distinguishes them is actually produced.
  //
  // There is deliberately no domain-level version of THIS test. A second submit
  // of the same action cannot reach the key at all: `TRANSITIONS` in
  // lib/domain/check-status.ts has no READY_FOR_RELEASE -> READY_FOR_RELEASE
  // edge, so `markReadyForRelease` throws ILLEGAL_TRANSITION before an event is
  // built. The constraint is asserted here, against the database, because that
  // is the only layer where it can be. Do not read its absence upstairs as an
  // oversight and "fix" it by loosening the transition table.
  it('refuses two events with the same idempotency key', async () => {
    const check = await makeQueueCheck('Q2')
    const data = {
      checkId: check.id, direction: 'OUT' as const, kind: 'MARK_AVAILABLE' as const,
      payload: {}, idempotencyKey: `${check.id}:MARK_AVAILABLE:1`,
    }
    await prisma.portalEvent.create({ data })
    // The outbox must not be able to queue the same instruction twice — a
    // double MARK_AVAILABLE is a second notification to a supplier.
    await expect(prisma.portalEvent.create({ data })).rejects.toThrow()
  })
})

describe('PortalEventKind CANCELLED', () => {
  it('accepts a CANCELLED event', async () => {
    const check = await makeQueueCheck('Q3', 'CANCELLED')
    const ev = await prisma.portalEvent.create({
      data: {
        checkId: check.id, direction: 'OUT', kind: 'CANCELLED', status: 'PENDING',
        idempotencyKey: `${check.id}:CANCELLED:test`, payload: { action: 'CANCELLED', checkNumber: check.checkNumber },
      },
    })
    expect(ev.kind).toBe('CANCELLED')
  })
})

describe('AcumaticaBill', () => {
  const APV = `TEST-SCHEMA-AP-${Date.now()}`
  afterAll(async () => {
    await prisma.acumaticaBill.deleteMany({ where: { apvNumber: APV } })
  })

  it('is keyed by the APV alone: a second row for the same voucher is refused', async () => {
    await prisma.acumaticaBill.create({
      data: { apvNumber: APV, tenant: 'GOLIVE', vendorRef: 'PO-ST-031109.', poNumbers: ['PO-ST-031109'] },
    })
    await expect(prisma.acumaticaBill.create({
      data: { apvNumber: APV, tenant: 'MANUFACTURING', vendorRef: 'A1PP-PO-000123', poNumbers: ['A1PP-PO-000123'] },
    })).rejects.toThrow()
    const row = await prisma.acumaticaBill.findUniqueOrThrow({ where: { apvNumber: APV } })
    expect(row.poNumbers).toEqual(['PO-ST-031109'])
    expect(row.lastModifiedOn).toBeNull()
    expect(row.updatedAt).toBeInstanceOf(Date)
  })
})

describe('AcumaticaBillTerms', () => {
  const APV = `TEST-SCHEMA-TERMS-${Date.now()}`
  afterAll(async () => {
    await prisma.acumaticaBillTerms.deleteMany({ where: { apvNumber: APV } })
  })

  it('is keyed by the APV alone, and both values may be absent', async () => {
    await prisma.acumaticaBillTerms.create({ data: { apvNumber: APV, tenant: 'GOLIVE' } })
    await expect(prisma.acumaticaBillTerms.create({
      data: { apvNumber: APV, tenant: 'MANUFACTURING', termsCode: '30D' },
    })).rejects.toThrow()
    const row = await prisma.acumaticaBillTerms.findUniqueOrThrow({ where: { apvNumber: APV } })
    expect(row.dueDate).toBeNull()
    expect(row.termsCode).toBeNull()
    expect(row.lastModifiedOn).toBeNull()
    expect(row.updatedAt).toBeInstanceOf(Date)
  })
})
