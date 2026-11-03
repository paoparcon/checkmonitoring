import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'
import { MAX_BULK_SELECTION } from '@/lib/bulk'

const currentUser = {
  id: '',
  email: 'f@rcl.test',
  name: 'Finance User',
  role: 'FINANCE_USER' as 'FINANCE_USER' | 'FINANCE_ADMIN',
}

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser, requireAdmin: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(async () => {
  await resetDb()
  const u = await makeUser()
  currentUser.id = u.id
  currentUser.role = 'FINANCE_USER'
})

function fd(checkIds: string[], extra: Record<string, string> = {}) {
  const f = new FormData()
  for (const id of checkIds) f.append('checkId', id)
  for (const [k, v] of Object.entries(extra)) f.append(k, v)
  return f
}

const rk = (id: string, orNumber: string, receiptType: string) =>
  ({ [`orNumber:${id}`]: orNumber, [`receiptType:${id}`]: receiptType })

// A per-cheque outcome, found by id. Every assertion below goes through this so
// a reordering of the outcomes array can never make a test pass by accident.
function outcomeFor(result: unknown, checkId: string) {
  const r = result as { ok: true; outcomes: { checkId: string }[] }
  const found = r.outcomes.find((o) => o.checkId === checkId)
  if (!found) throw new Error(`No outcome reported for ${checkId}`)
  return found as { checkId: string; checkNumber: string | null; ok: boolean; message?: string }
}

describe('bulkSignAction', () => {
  it('signs every selected check', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })

    const result = await bulkSignAction(fd([a.id, b.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    for (const id of [a.id, b.id]) {
      const after = await testDb.check.findUniqueOrThrow({ where: { id } })
      expect(after.status).toBe('SIGNED')
      expect(after.signedById).toBe(currentUser.id)
    }
  })

  it('processes each check independently: one refusal does not abort the rest', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    // The refused one FIRST, so an implementation that aborts on the first
    // failure leaves the other two untouched and fails this test.
    const released = await makeCheck({ status: 'RELEASED' })
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })

    const result = await bulkSignAction(fd([released.id, a.id, b.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: released.id } })).status).toBe('RELEASED')
  })

  it('reports the domain’s own sentence for a refusal, not a generic one', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const released = await makeCheck({ status: 'RELEASED' })

    const result = await bulkSignAction(fd([released.id]))

    expect(result.ok).toBe(true)
    const outcome = outcomeFor(result, released.id)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('Cannot move a check from RELEASED to SIGNED.')
    expect(outcome.checkNumber).toBe(released.checkNumber)
  })

  it('refuses a non-check payment with the spec wording', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const transfer = await makeCheck({ status: 'SIGNATURE_PENDING', isCheque: false })

    const result = await bulkSignAction(fd([transfer.id]))

    expect(result.ok).toBe(true)
    expect(outcomeFor(result, transfer.id).message).toBe(
      'This payment is not a check, so it cannot be signed or released. It is tracked here for visibility only.',
    )
  })

  it('refuses an empty selection without touching anything', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const result = await bulkSignAction(fd([]))
    expect(result).toEqual({ ok: false, message: 'Select at least one check first.' })
  })

  it('refuses a selection larger than the cap and writes nothing', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const real = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const padding = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `missing-${i}`)

    const result = await bulkSignAction(fd([real.id, ...padding]))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(String(MAX_BULK_SELECTION))
    // The cap is a real refusal, not a truncation: the cheque that WOULD have
    // fitted is untouched too.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: real.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('writes one audit row per check actually changed', async () => {
    const { bulkSignAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const released = await makeCheck({ status: 'RELEASED' })

    await bulkSignAction(fd([a.id, released.id]))

    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: 'marked_signed' } })).toBe(1)
    expect(await testDb.auditLog.count({ where: { checkId: released.id } })).toBe(0)
  })
})

describe('bulkReadyForReleaseAction', () => {
  it('marks signed checks ready and records the pickup date', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })
    const b = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id, b.id], { availablePickupDate: '2026-09-10' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: a.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.availablePickupDate?.toISOString().slice(0, 10)).toBe('2026-09-10')
  })

  it('refuses the whole batch when no pickup date was given', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id], { availablePickupDate: '' }))

    expect(result).toEqual({
      ok: false,
      message: 'Enter the available pickup date before marking checks ready for release.',
    })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
  })

  it('refuses an unparseable pickup date rather than storing an Invalid Date', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(fd([a.id], { availablePickupDate: 'not-a-date' }))

    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNED')
  })

  it('an INTERNAL check still changes status and produces NO portal event', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const internal = await makeCheck({ status: 'SIGNED', eligibility: 'INTERNAL' })
    const supplier = await makeCheck({ status: 'SIGNED', eligibility: 'SUPPLIER' })

    const result = await bulkReadyForReleaseAction(
      fd([internal.id, supplier.id], { availablePickupDate: '2026-09-10' }),
    )

    expect(result.ok).toBe(true)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: internal.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    // The property the whole system exists to protect: no instruction about an
    // internal payment may ever reach the supplier portal, however it was
    // marked ready.
    expect(await testDb.portalEvent.count({ where: { checkId: internal.id } })).toBe(0)
    // And the batch did not simply skip portal events altogether.
    expect(await testDb.portalEvent.count({ where: { checkId: supplier.id } })).toBe(1)
  })

  it('reports the missing-fields refusal per check', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const noAmount = await makeCheck({ status: 'SIGNED', amount: null })
    const fine = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReadyForReleaseAction(
      fd([noAmount.id, fine.id], { availablePickupDate: '2026-09-10' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect(outcomeFor(result, noAmount.id).message).toBe(
      'This check cannot be released because required information is missing: AMOUNT.',
    )
  })
})

describe('bulkReleaseAction', () => {
  it('releases for a FINANCE_USER too (client, 2026-10-16)', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const s = await makeCheck({ status: 'SIGNED' })

    const result = await bulkReleaseAction(fd([a.id, s.id]))

    expect(result.ok && result.succeeded).toBe(2)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
    const after = await testDb.check.findUniqueOrThrow({ where: { id: s.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.releasedById).toBe(currentUser.id)
  })

  it('releases the selected checks for a FINANCE_ADMIN', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'SCHEDULED' })
    const notReady = await makeCheck({ status: 'CANCELLED' })

    const result = await bulkReleaseAction(fd([a.id, b.id, notReady.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('RELEASED')
    expect(outcomeFor(result, notReady.id).message).toBe('Cannot move a check from CANCELLED to RELEASED.')
  })

  /**
   * A SIGNED check handed over directly (client, 2026-10-09). It is readied and
   * then released, each through its own domain action — so the READY guards
   * still apply, the audit shows both steps, and the receipt rides the release.
   */
  it('releases a SIGNED check directly, readying it first, with an AR receipt recorded here and no portal RECEIPT', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const signed = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-ST000001'] })

    const result = await bulkReleaseAction(fd([signed.id], rk(signed.id, 'AR-0042', 'AR')))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.orNumber).toBe('AR-0042')
    expect(after.receiptType).toBe('AR')
    expect(after.readyAt).not.toBeNull()
    expect(after.remarks).toBe('Released directly from SIGNED')
    const actions = (await testDb.auditLog.findMany({ where: { checkId: signed.id }, orderBy: { createdAt: 'asc' } })).map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['ready_for_release', 'released', 'receipt_recorded']))
    // The portal accepts OR and CR only: an AR is kept here and never queued.
    expect(await testDb.portalEvent.count({ where: { checkId: signed.id, kind: 'RECEIPT' } })).toBe(0)
  })

  it('still queues a RECEIPT for a SIGNED check released directly with an OR', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const signed = await makeCheck({ status: 'SIGNED', apvNumbers: ['AP-ST000002'] })

    await bulkReleaseAction(fd([signed.id], rk(signed.id, 'OR-77', 'OR')))

    expect((await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })).status).toBe('RELEASED')
    expect(await testDb.portalEvent.count({ where: { checkId: signed.id, kind: 'RECEIPT' } })).toBe(1)
  })

  it('refuses a SIGNED check the READY guards refuse, leaving it SIGNED', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const noPayee = await makeCheck({ status: 'SIGNED', payeeName: null })

    const result = await bulkReleaseAction(fd([noPayee.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: noPayee.id } })).status).toBe('SIGNED')
  })

  /**
   * GENERATED and SIGNATURE PENDING too (client, 2026-10-16): signed, readied and
   * released in one transaction, so a refusal at any step moves nothing.
   */
  it.each(['SIGNATURE_PENDING', 'GENERATED'] as const)('releases a %s check directly, signing and readying it first', async (status) => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const c = await makeCheck({ status, apvNumbers: ['AP-ST000003'] })

    const result = await bulkReleaseAction(fd([c.id]))

    expect(result.ok && result.succeeded).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.signedById).toBe(currentUser.id)
    expect(after.readyAt).not.toBeNull()
    expect(after.remarks).toBe(`Released directly from ${status}`)
    const actions = (await testDb.auditLog.findMany({ where: { checkId: c.id } })).map((r) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['marked_signed', 'ready_for_release', 'released']))
  })

  it('refuses a SIGNATURE_PENDING check the READY guards refuse, leaving it unsigned', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const noPayee = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: null })

    const result = await bulkReleaseAction(fd([noPayee.id]))

    expect(result.ok && result.failed).toBe(1)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: noPayee.id } })
    expect(after.status).toBe('SIGNATURE_PENDING')
    expect(after.signedById).toBeNull()
    expect(await testDb.auditLog.count({ where: { checkId: noPayee.id, action: 'marked_signed' } })).toBe(0)
  })

  /**
   * THE RECEIPT, ON THE TICK PATH.
   *
   * The client's requirement is about ticking: "Check released can be ticked
   * and once ticked it should have a box for OR or CR reference and marked as
   * RELEASED." One ticked cheque means one supplier at the counter handing over
   * one receipt, and that is the only shape in which a receipt reference has an
   * owner.
   */
  it('releases each ticked check with its OWN receipt, a blank box with none, and never touches crNumber', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const c = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id, b.id, c.id], {
      ...rk(a.id, 'OR-000123', 'OR'), ...rk(b.id, 'CR 88', 'CR'), ...rk(c.id, '', ''),
    }))

    expect(result.ok && result.succeeded).toBe(3)
    const [ra, rb, rc] = await Promise.all([a, b, c].map((x) => testDb.check.findUniqueOrThrow({ where: { id: x.id } })))
    expect(ra).toMatchObject({ status: 'RELEASED', orNumber: 'OR-000123', receiptType: 'OR', crNumber: null, clearingStatus: 'NONE' })
    expect(rb).toMatchObject({ status: 'RELEASED', orNumber: 'CR 88', receiptType: 'CR', crNumber: null })
    expect(rc).toMatchObject({ status: 'RELEASED', orNumber: null, receiptType: null, crNumber: null })
  })

  it('refuses a reference with no OR/CR before releasing anything', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id, b.id], { [`orNumber:${a.id}`]: '4471' }))

    expect(result).toEqual({ ok: false, message: 'Choose the receipt type (OR, CR, AR, PR, SI or OTHERS) for every reference you typed. Nothing was saved.' })
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_RELEASE')
    }
  })

  it('rejects a receipt type that is neither OR nor CR', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkReleaseAction(fd([a.id], rk(a.id, 'X', 'CRN')))
    expect(result).toEqual({ ok: false, message: 'Invalid receipt type.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('refuses a receipt keyed to a check that is not ticked', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const other = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkReleaseAction(fd([a.id], rk(other.id, 'OR-1', 'OR')))
    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  // Rule 5: RELEASE ALL and the multi-select release keep working, unprompted.
  it('releases a batch with no receipt at all', async () => {
    const { bulkReleaseAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkReleaseAction(fd([a.id, b.id]))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    for (const id of [a.id, b.id]) {
      const after = await testDb.check.findUniqueOrThrow({ where: { id } })
      expect(after.orNumber).toBeNull()
      expect(after.receiptType).toBeNull()
    }
  })

})

describe('bulkRecordReceiptsAction', () => {
  it('records each typed receipt on its own released check, skips blanks, and any Finance user may', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'RELEASED' })
    const b = await makeCheck({ status: 'RELEASED' })
    const blank = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRecordReceiptsAction(fd([a.id, b.id, blank.id], {
      ...rk(a.id, 'OR-000123', 'OR'), ...rk(b.id, 'CR 88', 'CR'), ...rk(blank.id, '', ''),
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.outcomes.map((o) => o.checkId).sort()).toEqual([a.id, b.id].sort())
    expect(await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ orNumber: 'OR-000123', receiptType: 'OR', crNumber: null })
    expect(await testDb.check.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ orNumber: 'CR 88', receiptType: 'CR', crNumber: null })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: blank.id } })).orNumber).toBeNull()
  })

  it('refuses by name a check that already has a receipt, and saves the rest', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const done = await makeCheck({ status: 'RELEASED' })
    await testDb.check.update({ where: { id: done.id }, data: { orNumber: 'OR-OLD', receiptType: 'OR' } })
    const fresh = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRecordReceiptsAction(fd([done.id, fresh.id], {
      ...rk(done.id, 'OR-NEW', 'OR'), ...rk(fresh.id, 'OR-2', 'OR'),
    }))

    expect(result.ok && result.succeeded).toBe(1)
    expect(outcomeFor(result, done.id).ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: done.id } })).orNumber).toBe('OR-OLD')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: fresh.id } })).orNumber).toBe('OR-2')
  })

  it('refuses a check that is not released', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkRecordReceiptsAction(fd([ready.id], rk(ready.id, 'OR-1', 'OR')))
    expect(result.ok && result.succeeded).toBe(0)
    expect(outcomeFor(result, ready.id).ok).toBe(false)
  })

  it('refuses when nothing was typed', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'RELEASED' })
    expect(await bulkRecordReceiptsAction(fd([a.id])))
      .toEqual({ ok: false, message: 'Type a receipt reference on at least one ticked check before saving.' })
  })

  it('holds the bulk cap', async () => {
    const { bulkRecordReceiptsAction } = await import('@/app/checks/bulk-actions')
    const tooMany = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `id-${i}`)
    expect((await bulkRecordReceiptsAction(fd(tooMany))).ok).toBe(false)
  })
})

/**
 * TODAY'S RELEASE — RELEASE ALL.
 *
 * The highest-risk action in the system (design decision D11): it is what hands
 * a day's worth of paper over, and RELEASED leads only to VOIDED. The set is not
 * ticked by hand; it is whatever `getTodaysRelease` counts, so these tests pin
 * the three things standing between a misclick and that outcome — the role, the
 * confirmation, and the count the user actually read.
 */
describe('releaseAllReadyAction', () => {
  /**
   * The panel's confirmation step, as the form submits it. `expectedCount` is
   * the figure that was on screen when the user pressed CONFIRM.
   */
  const confirmed = (expectedCount: number) =>
    fd([], { confirm: 'release', expectedCount: String(expectedCount) })

  it('refuses a FINANCE_USER by returning a result, never by throwing a redirect', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(null, confirmed(1))

    expect(result).toEqual({ ok: false, message: 'Only a Finance Admin can mark a check RELEASED.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  // A server action is an HTTP endpoint. The confirmation is a step in the page,
  // but it is also a field on the request, so a submit that never went through
  // the step writes nothing.
  it('refuses a submission that was not confirmed', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(null, fd([], { expectedCount: '1' }))

    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('releases every READY_FOR_RELEASE and SCHEDULED check, and nothing else', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const scheduled = await makeCheck({ status: 'SCHEDULED' })
    const signed = await makeCheck({ status: 'SIGNED' })

    const result = await releaseAllReadyAction(null, confirmed(2))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(0)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: ready.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: scheduled.id } })).status).toBe('RELEASED')
    // Not in the set, not touched, and not reported either.
    expect((await testDb.check.findUniqueOrThrow({ where: { id: signed.id } })).status).toBe('SIGNED')
    expect(result.outcomes.some((o) => o.checkId === signed.id)).toBe(false)
  })

  it('writes one audit row per check released', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    await releaseAllReadyAction(null, confirmed(1))

    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: 'released' } })).toBe(1)
  })

  /**
   * The property the whole system exists to protect. Payroll, tax, fund
   * transfers and inter-company payments are INTERNAL; they release normally and
   * no instruction about them may ever reach the supplier portal, however the
   * release was triggered.
   */
  it('an INTERNAL check releases normally and produces NO portal event', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const internal = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'INTERNAL' })
    const supplier = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })

    const result = await releaseAllReadyAction(null, confirmed(2))

    expect(result.ok).toBe(true)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: internal.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.portalSyncStatus).toBe('NOT_APPLICABLE')
    expect(await testDb.portalEvent.count({ where: { checkId: internal.id } })).toBe(0)
    // And RELEASE ALL did not simply stop emitting portal events altogether.
    expect(await testDb.portalEvent.count({ where: { checkId: supplier.id } })).toBe(1)
  })

  // "73 of 81 released" with no list is unusable to somebody holding a stack of
  // paper. The refusal is the domain's own sentence, per cheque, by number.
  it('reports each check that could not be released, by number and reason', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const fine = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const notACheque = await makeCheck({ status: 'READY_FOR_RELEASE', isCheque: false })

    const result = await releaseAllReadyAction(null, confirmed(2))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: fine.id } })).status).toBe('RELEASED')
    const refused = outcomeFor(result, notACheque.id)
    expect(refused.ok).toBe(false)
    expect(refused.checkNumber).toBe(notACheque.checkNumber)
    expect(refused.message).toBe(
      'This payment is not a check, so it cannot be signed or released. It is tracked here for visibility only.',
    )
  })

  it('says so plainly when there is nothing to release, rather than reporting a batch of none', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    await makeCheck({ status: 'SIGNED' })

    const result = await releaseAllReadyAction(null, confirmed(0))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toBe('No checks are ready to release right now.')
  })

  /**
   * The confirmation names a count and a total. If the set has GROWN since the
   * user read them — a colleague marked twenty more ready in the meantime — then
   * confirming 81 would release 101, and the figures the user agreed to were
   * never the figures that moved.
   *
   * A set that has SHRUNK is fine: somebody else released some, and releasing
   * the remainder is exactly what was agreed to.
   */
  it('refuses when more checks are ready than the count that was confirmed', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const b = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(null, confirmed(1))

    expect(result.ok).toBe(false)
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_RELEASE')
    }
  })

  // `Number('')` is 0, so an absent field must be rejected on its own terms
  // rather than sliding through as a confirmed count of nothing.
  it('refuses a confirmation carrying no count, and writes nothing', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    for (const expectedCount of ['', 'lots', '1e9', '-1', '2.5']) {
      const result = await releaseAllReadyAction(null, fd([], { confirm: 'release', expectedCount }))
      expect(result.ok).toBe(false)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
  })

  it('proceeds when fewer are ready than were confirmed', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(null, confirmed(5))

    expect(result.ok).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('RELEASED')
  })

  /**
   * 81 are ready in production and `MAX_BULK_SELECTION` is 50. The cap is not
   * raised — it exists because concurrent interactive transactions against Neon
   * deadlock, and the tick-box path needs it. The set is released in sequential
   * batches instead, each cheque still in its own transaction with its own
   * guards and its own audit row.
   */
  it('releases a set larger than MAX_BULK_SELECTION in sequential batches', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const total = MAX_BULK_SELECTION + 3

    // One company and cash account shared by the lot: this test is about the
    // batching, and 53 separate factory calls is 212 round trips to Neon.
    const seed = await makeCheck({ status: 'READY_FOR_RELEASE' })
    await testDb.check.createMany({
      data: Array.from({ length: total - 1 }, (_, i) => ({
        companyId: seed.companyId,
        cashAccountId: seed.cashAccountId,
        checkNumber: `BULK-${i}`,
        checkDate: new Date('2026-09-01'),
        amount: '1000.00',
        currency: 'PHP',
        payeeName: 'HENKEL PHILIPPINES INC.',
        eligibility: 'SUPPLIER' as const,
        status: 'READY_FOR_RELEASE' as const,
        isCheque: true,
      })),
    })

    const result = await releaseAllReadyAction(null, confirmed(total))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(total)
    expect(result.failed).toBe(0)
    expect(result.outcomes).toHaveLength(total)
    expect(await testDb.check.count({ where: { status: 'READY_FOR_RELEASE' } })).toBe(0)
    expect(await testDb.check.count({ where: { status: 'RELEASED' } })).toBe(total)
    // Each cheque got its own transaction, so each got its own audit row.
    expect(await testDb.auditLog.count({ where: { action: 'released' } })).toBe(total)
  }, 180_000)

  /**
   * The TOTALS screen can be narrowed to one company or bank (2026-09-29), and
   * the panel then counts that company's ready cheques. The button beneath it
   * must release exactly those: a RELEASE ALL 12 that released 81 is the
   * mismatch this dashboard exists to prevent, and it is money. The server
   * re-derives the set from the same filter the panel counted.
   */
  it('releases only the ready checks of the company on screen', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const mine = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const other = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', company: mine.companyId }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(1)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('READY_FOR_RELEASE')
    expect(result.outcomes.some((o) => o.checkId === other.id)).toBe(false)
  })

  it('narrows by cash account and by eligibility the same way', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const broker = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'BROKER' })
    const supplier = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'SUPPLIER' })

    const byAccount = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', cashAccount: broker.cashAccountId! }),
    )
    expect(byAccount.ok).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: broker.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: supplier.id } })).status).toBe('READY_FOR_RELEASE')

    const internal = await makeCheck({ status: 'READY_FOR_RELEASE', eligibility: 'INTERNAL' })
    const byEligibility = await releaseAllReadyAction(
      null, fd([], { confirm: 'release', expectedCount: '1', eligibility: 'SUPPLIER' }),
    )
    expect(byEligibility.ok).toBe(true)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: supplier.id } })).status).toBe('RELEASED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: internal.id } })).status).toBe('READY_FOR_RELEASE')
  })

  /**
   * A filter that is present but names nothing is refused, not dropped.
   * Dropping it would silently widen the set from one company to every
   * company — the one failure this step must never have.
   */
  it('refuses, and releases nothing, when the filter on the form is not recognised', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const badFilters: Record<string, string>[] = [
      { company: 'co-gone' }, { cashAccount: 'ca-gone' }, { eligibility: 'MAYBE' },
      // A recognised company beside a bank that names nothing: the good half
      // must not carry the bad half through as "the company's cheques".
      { company: a.companyId, cashAccount: 'ca-gone' },
    ]
    for (const bad of badFilters) {
      const result = await releaseAllReadyAction(
        null, fd([], { confirm: 'release', expectedCount: '1', ...bad }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/filter/i)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.auditLog.count({ where: { action: 'released' } })).toBe(0)
  })

  /**
   * A field the form SENT that parses to nothing is a filter, not an absent
   * one. The form renders a hidden field only when it is non-empty, so any
   * field on the request is meant as a narrowing — and treating whitespace as
   * "nothing sent" would widen the set from one company to every company.
   */
  it('refuses, and releases nothing, when a filter arrives as whitespace or empty', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const blanks: Record<string, string>[] = [{ company: '   ' }, { cashAccount: '' }, { eligibility: ' ' }]
    for (const bad of blanks) {
      const result = await releaseAllReadyAction(
        null, fd([], { confirm: 'release', expectedCount: '1', ...bad }),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.message).toMatch(/filter/i)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.auditLog.count({ where: { action: 'released' } })).toBe(0)
  })

  it('refuses a column filter, which its panel never sends', async () => {
    const { releaseAllReadyAction } = await import('@/app/checks/bulk-actions')
    currentUser.role = 'FINANCE_ADMIN'
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const r = await releaseAllReadyAction(null, fd([], { confirm: 'release', expectedCount: '1', 'f.payee': 'henkel' }))
    expect(r).toMatchObject({
      ok: false,
      message: 'The filter on screen was not recognised. Open TODAY’S RELEASE again and re-read the figures.',
    })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.auditLog.count({ where: { action: 'released' } })).toBe(0)
  })
})

describe('bulkRevertToSignedAction', () => {
  it('lets a Finance user revert ready and scheduled checks, with the reason on each audit row', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE', availablePickupDate: new Date('2026-09-26') })
    const b = await makeCheck({ status: 'SCHEDULED' })

    const result = await bulkRevertToSignedAction(fd([a.id, b.id], { reason: 'Pulled from the list' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.succeeded).toBe(2)
    for (const id of [a.id, b.id]) {
      const after = await testDb.check.findUniqueOrThrow({ where: { id } })
      expect(after.status).toBe('SIGNED')
      expect(after.availablePickupDate).toBeNull()
      const audit = await testDb.auditLog.findMany({ where: { checkId: id, action: 'reverted_availability' } })
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({ userId: currentUser.id, remarks: 'Pulled from the list' })
    }
  })

  it('refuses a blank reason and writes nothing', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'READY_FOR_RELEASE' })

    const result = await bulkRevertToSignedAction(fd([a.id], { reason: '   ' }))

    expect(result.ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('READY_FOR_RELEASE')
    expect(await testDb.auditLog.count({ where: { checkId: a.id, action: 'reverted_availability' } })).toBe(0)
  })

  it('reports a check that has moved on and still reverts the rest', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const released = await makeCheck({ status: 'RELEASED' })

    const result = await bulkRevertToSignedAction(fd([ready.id, released.id], { reason: 'x' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(outcomeFor(result, ready.id).ok).toBe(true)
    expect(outcomeFor(result, released.id).ok).toBe(false)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: released.id } })).status).toBe('RELEASED')
  })

  it('holds the bulk cap', async () => {
    const { bulkRevertToSignedAction } = await import('@/app/checks/bulk-actions')
    const tooMany = Array.from({ length: MAX_BULK_SELECTION + 1 }, (_, i) => `id-${i}`)
    const result = await bulkRevertToSignedAction(fd(tooMany, { reason: 'x' }))
    expect(result.ok).toBe(false)
  })
})

describe('signAllPendingAction', () => {
  const confirmFd = (count: number, extra: Record<string, string> = {}) =>
    fd([], { confirm: 'sign', expectedCount: String(count), ...extra })
  const signedRows = () => testDb.auditLog.count({ where: { action: 'marked_signed' } })

  // beforeEach signs in a FINANCE_USER: SIGN ALL is open to every Finance user.
  it('signs the whole pending set the server computes, one audit row each', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const b = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const other = await makeCheck({ status: 'SIGNED' })
    const r = await signAllPendingAction(null, confirmFd(2))
    expect(r).toMatchObject({ ok: true, succeeded: 2, failed: 0 })
    for (const id of [a.id, b.id]) {
      expect((await testDb.check.findUniqueOrThrow({ where: { id } })).status).toBe('SIGNED')
      expect(await testDb.auditLog.count({ where: { checkId: id, action: 'marked_signed' } })).toBe(1)
    }
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SIGNED')
  })

  it('ignores ids sent by the browser', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const p = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const ready = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const f = confirmFd(1); f.append('checkId', ready.id)
    expect(await signAllPendingAction(null, f)).toMatchObject({ ok: true, succeeded: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SIGNED')
  })

  it('signs only the pending checks of the company on screen', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const mine = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const other = await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(other.companyId).not.toBe(mine.companyId)

    const r = await signAllPendingAction(null, confirmFd(1, { company: mine.companyId }))
    expect(r).toMatchObject({ ok: true, succeeded: 1, failed: 0 })
    if (!r.ok) return
    expect(r.outcomes.map((o) => o.checkId)).toEqual([mine.id])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SIGNATURE_PENDING')
    expect(await signedRows()).toBe(1)
  })

  it('refuses without the confirmation field, and signs nothing', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const p = await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(await signAllPendingAction(null, fd([], { expectedCount: '1' }))).toMatchObject({ ok: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SIGNATURE_PENDING')
    expect(await signedRows()).toBe(0)
  })

  it('refuses when more are pending than were confirmed', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    const r = await signAllPendingAction(null, confirmFd(1))
    expect(r).toMatchObject({ ok: false })
    expect(await testDb.check.count({ where: { status: 'SIGNED' } })).toBe(0)
    expect(await signedRows()).toBe(0)
  })

  it('refuses an unrecognised filter rather than widening', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    await makeCheck({ status: 'SIGNATURE_PENDING' })
    expect(await signAllPendingAction(null, confirmFd(1, { company: 'not-a-company' }))).toMatchObject({ ok: false })
    expect(await signAllPendingAction(null, confirmFd(1, { company: ' ' }))).toMatchObject({ ok: false })
    expect(await testDb.check.count({ where: { status: 'SIGNED' } })).toBe(0)
    expect(await signedRows()).toBe(0)
  })

  it('signs only the pending checks the column filters on screen admit', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const acme = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'ACME TRADING' })
    const other = await makeCheck({ status: 'SIGNATURE_PENDING', payeeName: 'HENKEL PHILIPPINES INC.' })
    const r = await signAllPendingAction(null, confirmFd(1, { 'f.payee': 'acme' }))
    expect(r).toMatchObject({ ok: true, succeeded: 1, failed: 0 })
    if (!r.ok) return
    expect(r.outcomes.map((o) => o.checkId)).toEqual([acme.id])
    expect((await testDb.check.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('refuses a column filter it cannot read rather than signing everything', async () => {
    const { signAllPendingAction } = await import('@/app/checks/bulk-actions')
    const a = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const r = await signAllPendingAction(null, confirmFd(1, { 'f.amountMin': '12x' }))
    expect(r).toMatchObject({ ok: false, message: 'The filter on screen was not recognised. Press SIGN ALL again and re-read the figures.' })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SIGNATURE_PENDING')
    expect(await signedRows()).toBe(0)
  })
})

describe('bulkRevertToPendingAction', () => {
  it('reverts the ticked SIGNED checks, refuses the rest per check, reason optional', async () => {
    const { bulkRevertToPendingAction } = await import('@/app/checks/bulk-actions')
    const s = await makeCheck({ status: 'SIGNED' })
    const r = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await bulkRevertToPendingAction(fd([s.id, r.id]))
    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 1 })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: s.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('READY_FOR_RELEASE')
    expect(outcomeFor(result, r.id).ok).toBe(false)
  })

  it('passes the shared reason to each audit row', async () => {
    const { bulkRevertToPendingAction } = await import('@/app/checks/bulk-actions')
    const s = await makeCheck({ status: 'SIGNED' })
    await bulkRevertToPendingAction(fd([s.id], { reason: 'Signed too early' }))
    const row = await testDb.auditLog.findFirstOrThrow({ where: { checkId: s.id, action: 'signature_reverted' } })
    expect(row.remarks).toBe('Signed too early')
  })

  it('refuses a selection larger than the cap and writes nothing', async () => {
    const { bulkRevertToPendingAction } = await import('@/app/checks/bulk-actions')
    const real = await makeCheck({ status: 'SIGNED' })
    const padding = Array.from({ length: MAX_BULK_SELECTION }, (_, i) => `missing-${i}`)

    const result = await bulkRevertToPendingAction(fd([real.id, ...padding]))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain(String(MAX_BULK_SELECTION))
    expect((await testDb.check.findUniqueOrThrow({ where: { id: real.id } })).status).toBe('SIGNED')
    expect(await testDb.auditLog.count({ where: { action: 'signature_reverted' } })).toBe(0)
  })
})

describe('bulkReadyForReleaseAction: notifications', () => {
  it('notifies every other active user once for the batch, counting only checks that moved', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    const other = await makeUser('FINANCE_ADMIN')
    const a = await makeCheck({ status: 'SIGNED' })
    const b = await makeCheck({ status: 'SIGNED' })
    const refused = await makeCheck({ status: 'SIGNATURE_PENDING' })

    const result = await bulkReadyForReleaseAction(fd([a.id, b.id, refused.id], { availablePickupDate: '2026-09-10' }))
    expect(result.ok && result.succeeded).toBe(2)

    const rows = await testDb.notification.findMany()
    expect(rows.map((r) => r.userId)).toEqual([other.id]) // the actor is not told of their own action
    expect(rows[0]).toMatchObject({ kind: 'READY_FOR_RELEASE', link: '/?status=READY_FOR_RELEASE' })
    expect(rows[0].message).toBe('Finance User marked 2 checks READY FOR RELEASE: ₱395,430.84')
  })

  it('sends nothing when no check moved', async () => {
    const { bulkReadyForReleaseAction } = await import('@/app/checks/bulk-actions')
    await makeUser('FINANCE_ADMIN')
    const refused = await makeCheck({ status: 'SIGNATURE_PENDING' })
    await bulkReadyForReleaseAction(fd([refused.id], { availablePickupDate: '2026-09-10' }))
    expect(await testDb.notification.count()).toBe(0)
  })
})
