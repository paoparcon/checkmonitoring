import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetDb, testDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

/**
 * The scheduled route's guard. `middleware.ts` DOES NOT RUN in this project, so
 * a route handler has no perimeter in front of it; this one authenticates
 * itself with a bearer secret on its first line, and an UNSET secret refuses
 * rather than opens. The database is reached through a Proxy that counts every
 * property touch, so "did nothing" is asserted as "never asked the database",
 * the same way tests/export/route.test.ts does it.
 */
const state = vi.hoisted(() => ({
  dbTouches: 0,
  requested: [] as string[],
  failFor: null as string | null,
  failAutoSign: false,
  failBillsFor: null as string | null,
  failBillRefsFor: null as string | null,
  /** When set, the voucher feed moves the (faked) clock on by this much, as a slow read would. */
  advanceClockMs: 0,
}))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

vi.mock('@/lib/integrations/acumatica/from-env', () => ({
  createClientForTenant: (tenant: string) => {
    state.requested.push(tenant)
    if (state.failFor === tenant) throw new Error(`${tenant} cannot be built`)
    return {
      fetchAll: async (feed: string) => {
        if (feed === 'AP-PAYMENTS-WITH-BILLS' && state.failBillsFor === tenant) {
          throw new Error(`${tenant} bills feed down`)
        }
        if (feed === 'AP-PAYMENTS-WITH-BILLS' && state.advanceClockMs > 0) {
          vi.setSystemTime(Date.now() + state.advanceClockMs)
        }
        if (feed === 'AP-Bills and Adjustments' && state.failBillRefsFor === tenant) {
          throw new Error(`${tenant} bill refs feed down`)
        }
        return []
      },
      fetchPage: async () => [],
    }
  },
}))

vi.mock('@/lib/sync/auto-sign', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sync/auto-sign')>()
  return {
    ...real,
    runAutoSign: async (...args: Parameters<typeof real.runAutoSign>) =>
      state.failAutoSign
        ? { outcome: 'FAILED' as const, signed: 0, skipped: 0, enabled: true, error: 'forced' }
        : real.runAutoSign(...args),
  }
})

const SECRET = 'test-cron-secret'

async function get(authorization?: string) {
  const { GET } = await import('@/app/api/cron/sync/route')
  return GET(new Request('http://localhost/api/cron/sync', {
    headers: authorization ? { authorization } : {},
  }))
}

/** A payment watermark only — the voucher read has none. */
const paymentWatermarked = (tenant: 'GOLIVE' | 'MANUFACTURING') =>
  testDb.syncRun.create({
    data: {
      mode: 'INCREMENTAL', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })

/** A payment, a BILLS and a BILL_REFS watermark for the tenant. */
const watermarked = async (tenant: 'GOLIVE' | 'MANUFACTURING') => {
  await paymentWatermarked(tenant)
  await testDb.syncRun.create({
    data: {
      mode: 'BILLS', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })
  await testDb.syncRun.create({
    data: {
      mode: 'BILL_REFS', tenant, trigger: 'MANUAL',
      startedAt: new Date('2026-09-10T10:00:00Z'), finishedAt: new Date('2026-09-10T10:00:05Z'),
      watermark: new Date('2026-09-10T08:00:00Z'),
    },
  })
}

beforeEach(async () => {
  await resetDb()
  process.env.CRON_SECRET = SECRET
  delete process.env.PORTAL_BASE_URL
  delete process.env.PORTAL_TOKEN
  state.dbTouches = 0
  state.requested = []
  state.failFor = null
  state.failAutoSign = false
  state.failBillsFor = null
  state.failBillRefsFor = null
  state.advanceClockMs = 0
})

describe('GET /api/cron/sync — the guard', () => {
  it('refuses with 500 and touches nothing when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })

  it('refuses a request with no bearer', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('refuses the wrong bearer', async () => {
    const res = await get('Bearer not-the-secret')
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
    expect(state.requested).toEqual([])
  })
})

describe('GET /api/cron/sync — the run', () => {
  it('reads both tenants, in order, as SCHEDULED', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.outcomes.map((o: { tenant: string; outcome: string }) => [o.tenant, o.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING', 'GOLIVE', 'MANUFACTURING', 'GOLIVE', 'MANUFACTURING'])

    const scheduled = await testDb.syncRun.findMany({ where: { trigger: 'SCHEDULED' } })
    // A payment read, a voucher read and a PO read per tenant.
    expect(scheduled.map((r) => `${r.tenant}:${r.mode}`).sort()).toEqual([
      'GOLIVE:BILLS', 'GOLIVE:BILL_REFS', 'GOLIVE:INCREMENTAL',
      'MANUFACTURING:BILLS', 'MANUFACTURING:BILL_REFS', 'MANUFACTURING:INCREMENTAL',
    ])
  })

  it('still reads the second tenant when the first fails, and answers 500', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)

    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['FAILED', 'RAN'])
    // GOLIVE's voucher and PO reads are both skipped (its payment read did not run), so no
    // second client is built for it.
    expect(state.requested).toEqual(['GOLIVE', 'MANUFACTURING', 'MANUFACTURING', 'MANUFACTURING'])
  })

  it('answers 200 when a tenant merely had no watermark — the refusal is recorded, not a fault of the cron', async () => {
    await watermarked('GOLIVE')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'REFUSED_NO_WATERMARK'])
  })
})

describe('GET /api/cron/sync — the voucher read (BILLS)', () => {
  it('reports one BILLS outcome per tenant, in SYNC_TENANTS order', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bills.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
  })

  it('a BILLS FAILED turns the response 500 while the payment reads still RAN', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failBillsFor = 'MANUFACTURING'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.bills.map((b: { outcome: string }) => b.outcome)).toEqual(['RAN', 'FAILED'])
  })

  it('skips BILLS for a tenant whose payment read FAILED, with no BILLS SyncRun row; the other tenant still RAN', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['FAILED', 'RAN'])
    expect(body.bills.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'SKIPPED_PAYMENT_NOT_RUN'], ['MANUFACTURING', 'RAN']])
    expect(await testDb.syncRun.count({ where: { mode: 'BILLS', tenant: 'GOLIVE', trigger: 'SCHEDULED' } })).toBe(0)
    expect(await testDb.syncRun.count({ where: { mode: 'BILLS', tenant: 'MANUFACTURING', trigger: 'SCHEDULED' } })).toBe(1)
  })

  it('a skipped BILLS read is not a failure of the cron', async () => {
    await watermarked('GOLIVE')
    // MANUFACTURING has no payment watermark: its payment read is REFUSED_NO_WATERMARK.
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.bills.map((b: { outcome: string }) => b.outcome)).toEqual(['RAN', 'SKIPPED_PAYMENT_NOT_RUN'])
  })

  it('BILLS REFUSED_NO_WATERMARK is recorded and does not turn the response 500', async () => {
    await paymentWatermarked('GOLIVE')
    await paymentWatermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.bills.map((b: { outcome: string }) => b.outcome))
      .toEqual(['REFUSED_NO_WATERMARK', 'REFUSED_NO_WATERMARK'])
    expect(await testDb.syncRun.count({ where: { mode: 'BILLS', trigger: 'SCHEDULED', errors: 1 } })).toBe(2)
  })
})

describe('GET /api/cron/sync — auto-sign after the syncs (retired, user ruling 2026-10-27)', () => {
  // Tuesday 29 Sep 2026, 12:00 Manila. Only Date is faked so DB timers stay real.
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-29T04:00:00Z'), toFake: ['Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  async function duePending() {
    const { makeCheck } = await import('../helpers/factory')
    const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
    return testDb.check.update({
      where: { id: c.id },
      data: { acumaticaPaymentId: `PAY-${c.id}`, acumaticaStatus: 'Balanced', createdAt: new Date('2026-09-28T09:00:00Z') },
    })
  }

  it('records DISABLED and leaves the due checks pending', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    const c = await duePending()
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.autoSign).toMatchObject({ outcome: 'DISABLED', signed: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('still records the run when a tenant sync failed, and signs nothing', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const c = await duePending()
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    expect((await res.json()).autoSign.outcome).toBe('DISABLED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('answers 500 when auto-sign fails, even though both syncs ran', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    state.failAutoSign = true
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    expect((await res.json()).autoSign).toMatchObject({ outcome: 'FAILED', error: 'forced' })
  })

  it('reports the portal outbox after auto-sign, skipped when unconfigured', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(body.portal).toEqual({ skipped: 'PORTAL_BASE_URL is not set' })
  })
})

describe('GET /api/cron/sync — auto-sign on a Monday (retired)', () => {
  // Monday 12 Oct 2026, 12:00 Manila. Only Date is faked so DB timers stay real.
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-12T04:00:00Z'), toFake: ['Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('leaves last week’s check pending', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    const { makeCheck } = await import('../helpers/factory')
    const made = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const c = await testDb.check.update({
      where: { id: made.id },
      data: { acumaticaPaymentId: `PAY-${made.id}`, acumaticaStatus: 'Balanced', createdAt: new Date('2026-10-08T02:00:00Z') },
    })
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect((await res.json()).autoSign).toMatchObject({ outcome: 'DISABLED', signed: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })
})

describe('GET /api/cron/sync — the PO read (BILL_REFS)', () => {
  it('reports one BILL_REFS outcome per tenant, in SYNC_TENANTS order', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billRefs.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'RAN'], ['MANUFACTURING', 'RAN']])
  })

  it('a BILL_REFS FAILED turns the response 500 while the payment and voucher reads still RAN', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failBillRefsFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.outcomes.map((o: { outcome: string }) => o.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.bills.map((b: { outcome: string }) => b.outcome)).toEqual(['RAN', 'RAN'])
    expect(body.billRefs.map((b: { outcome: string }) => b.outcome)).toEqual(['FAILED', 'RAN'])
  })

  it('skips BILL_REFS for a tenant whose payment read did not run, with no BILL_REFS SyncRun row', async () => {
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    const res = await get(`Bearer ${SECRET}`)
    const body = await res.json()
    expect(body.billRefs.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
      .toEqual([['GOLIVE', 'SKIPPED_PAYMENT_NOT_RUN'], ['MANUFACTURING', 'RAN']])
    expect(await testDb.syncRun.count({ where: { mode: 'BILL_REFS', tenant: 'GOLIVE', trigger: 'SCHEDULED' } })).toBe(0)
  })

  it('BILL_REFS REFUSED_NO_WATERMARK is recorded and does not turn the response 500', async () => {
    await paymentWatermarked('GOLIVE')
    await paymentWatermarked('MANUFACTURING')
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.billRefs.map((b: { outcome: string }) => b.outcome))
      .toEqual(['REFUSED_NO_WATERMARK', 'REFUSED_NO_WATERMARK'])
    expect(await testDb.syncRun.count({ where: { mode: 'BILL_REFS', trigger: 'SCHEDULED', errors: 1 } })).toBe(2)
  })

  describe('against the time budget', () => {
    // Only Date is faked so DB timers stay real; the voucher feed moves it on.
    beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-09-29T04:00:00Z'), toFake: ['Date'] }) })
    afterEach(() => { vi.useRealTimers() })

    it('skips BILL_REFS once more than 20 s have passed, leaves its watermark, and still answers 200', async () => {
      await watermarked('GOLIVE')
      await watermarked('MANUFACTURING')
      state.advanceClockMs = 25_000
      const res = await get(`Bearer ${SECRET}`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.billRefs.map((b: { tenant: string; outcome: string }) => [b.tenant, b.outcome]))
        .toEqual([['GOLIVE', 'SKIPPED_TIME_BUDGET'], ['MANUFACTURING', 'SKIPPED_TIME_BUDGET']])
      // A trace on /admin/sync per tenant: a finished SCHEDULED BILL_REFS row,
      // no errors, no watermark (so the seeded MANUAL watermark still rules).
      const skips = await testDb.syncRun.findMany({
        where: { mode: 'BILL_REFS', trigger: 'SCHEDULED' }, orderBy: { tenant: 'asc' },
      })
      expect(skips.map((r) => r.tenant)).toEqual(['GOLIVE', 'MANUFACTURING'])
      for (const r of skips) {
        expect(r.finishedAt).not.toBeNull()
        expect(r.errors).toBe(0)
        expect(r.watermark).toBeNull()
        expect(r.message).toMatch(/^skipped: the run had used \d+ s of its budget before the PO read; the next run catches up$/)
      }
    })
  })
})

describe('GET /api/cron/sync — notifications', () => {
  it('a clean run notifies nobody', async () => {
    await makeUser('FINANCE_ADMIN')
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    expect((await get(`Bearer ${SECRET}`)).status).toBe(200)
    expect(await testDb.notification.count()).toBe(0)
  })

  it('a FAILED tenant notifies each admin, and only admins', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await makeUser('FINANCE_USER')
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failFor = 'GOLIVE'
    await get(`Bearer ${SECRET}`)
    const rows = await testDb.notification.findMany({ where: { kind: 'SYNC_FAILED' } })
    expect(rows.map((r) => r.userId)).toEqual([admin.id])
    expect(rows[0].message).toMatch(/^Scheduled Acumatica payment read failed for GOLIVE: /)
  })

  it('a never-read tenant is reported refused every run but stale only once', async () => {
    await makeUser('FINANCE_ADMIN')
    await watermarked('GOLIVE')
    await get(`Bearer ${SECRET}`)
    await get(`Bearer ${SECRET}`)
    expect(await testDb.notification.count({ where: { kind: 'SYNC_FAILED' } })).toBe(2)
    const stale = await testDb.notification.findMany({ where: { kind: 'SYNC_STALE' } })
    expect(stale.map((r) => r.dedupeKey)).toEqual(['stale:MANUFACTURING:never'])
  })

  it('an auto-sign FAILED notifies the admins', async () => {
    await makeUser('FINANCE_ADMIN')
    await watermarked('GOLIVE')
    await watermarked('MANUFACTURING')
    state.failAutoSign = true
    await get(`Bearer ${SECRET}`)
    const rows = await testDb.notification.findMany({ where: { kind: 'AUTO_SIGN_FAILED' } })
    expect(rows.map((r) => r.message)).toEqual(['Auto-sign failed: forced'])
  })
})
