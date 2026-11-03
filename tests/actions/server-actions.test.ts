import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser, makeCheck } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

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
  // Belt-and-braces against the `finally` blocks below: those restore the role
  // when a test throws, but not when a test times out and never reaches them.
  ;(currentUser as { role: string }).role = 'FINANCE_USER'
})

function fd(entries: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('readyForReleaseAction', () => {
  it('marks a signed check ready and reports success', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('READY_FOR_RELEASE')
  })

  it('returns the exact spec warning for an unsigned check', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result).toEqual({
      ok: false,
      message: 'This check cannot be released because it has not yet been marked as SIGNED.',
    })
  })

  it('rejects a missing availability date without throwing', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('revertAction', () => {
  it('requires a reason', async () => {
    const { readyForReleaseAction, revertAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await revertAction(fd({ checkId: check.id, reason: '' }))
    expect(result.ok).toBe(false)
  })

  it('lets a Finance user revert a ready check', async () => {
    const { readyForReleaseAction, revertAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await revertAction(fd({ checkId: check.id, reason: 'Pulled from the list' }))
    expect(result).toEqual({ ok: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status).toBe('SIGNED')
  })
})

describe('releaseAction', () => {
  it('releases an available check', async () => {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    const result = await releaseAction(fd({ checkId: check.id, remarks: 'Picked up by supplier' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
  })
})

describe('releaseAction with a receipt', () => {
  async function ready() {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-10' }))
    return check
  }

  it('records the reference, the date and the kind of receipt', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({
      checkId: check.id, orNumber: 'OR-000123', orDate: '2026-09-10', receiptType: 'OR',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBe('OR-000123')
    expect(after.receiptType).toBe('OR')
    expect(after.crNumber).toBeNull()
  })

  it('releases with an empty box', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: '', receiptType: '' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
    expect(after.receiptType).toBeNull()
  })

  it('returns the domain’s sentence for a reference with no type', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: 'OR-000123', receiptType: '' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('Collection Receipt')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: check.id } })).status)
      .toBe('READY_FOR_RELEASE')
  })

  it('rejects a receipt type that is neither OR nor CR without throwing', async () => {
    const { releaseAction } = await import('@/app/checks/actions')
    const check = await ready()
    const result = await releaseAction(fd({ checkId: check.id, orNumber: 'X', receiptType: 'crn' }))
    expect(result).toEqual({ ok: false, message: 'Invalid receipt type.' })
  })
})

describe('recordReceiptAction', () => {
  async function released() {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-10' }))
    await releaseAction(fd({ checkId: check.id }))
    return check
  }

  it('adds the receipt to a check released without one', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await released()
    const result = await recordReceiptAction(fd({
      checkId: check.id, orNumber: '4471', orDate: '2026-09-11', receiptType: 'CR',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.orNumber).toBe('4471')
    expect(after.receiptType).toBe('CR')
    // The Collection Receipt is not a bank clearing reference.
    expect(after.crNumber).toBeNull()
    expect(after.clearingStatus).toBe('NONE')
  })

  it('refuses a check that has not been released', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'READY_FOR_RELEASE' })
    const result = await recordReceiptAction(fd({
      checkId: check.id, orNumber: 'OR-1', receiptType: 'OR',
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('RELEASED')
  })

  it('refuses an empty box rather than reporting success at doing nothing', async () => {
    const { recordReceiptAction } = await import('@/app/checks/actions')
    const check = await released()
    const result = await recordReceiptAction(fd({ checkId: check.id, orNumber: '', receiptType: '' }))
    expect(result.ok).toBe(false)
  })
})

describe('clearingAction', () => {
  it('rejects a bogus clearingStatus without throwing', async () => {
    const { clearingAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await clearingAction(fd({ checkId: check.id, clearingStatus: 'NOT_A_REAL_STATUS' }))
    expect(result).toEqual({ ok: false, message: 'Invalid clearing status.' })
  })
})

describe('reverseReleaseAction', () => {
  async function releasedCheck() {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    await releaseAction(fd({ checkId: check.id }))
    return check
  }

  it('refuses a FINANCE_USER and leaves the release standing', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    const result = await reverseReleaseAction(fd({ checkId: check.id, reason: 'Wrong row' }))
    expect(result.ok).toBe(false)
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.status).toBe('RELEASED')
  })

  it('lets a FINANCE_ADMIN reverse with a reason', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    // The mock's user object is mutable; the role is what the action checks.
    ;(currentUser as { role: string }).role = 'FINANCE_ADMIN'
    try {
      const result = await reverseReleaseAction(fd({ checkId: check.id, reason: 'Wrong row' }))
      expect(result.ok).toBe(true)
      const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
      expect(after.status).toBe('READY_FOR_RELEASE')
    } finally {
      ;(currentUser as { role: string }).role = 'FINANCE_USER'
    }
  })

  it('refuses a blank reason even for an admin', async () => {
    const { reverseReleaseAction } = await import('@/app/checks/actions')
    const check = await releasedCheck()
    ;(currentUser as { role: string }).role = 'FINANCE_ADMIN'
    try {
      const result = await reverseReleaseAction(fd({ checkId: check.id, reason: '' }))
      expect(result.ok).toBe(false)
    } finally {
      ;(currentUser as { role: string }).role = 'FINANCE_USER'
    }
  })
})

describe('updateDetailsAction', () => {
  it('writes the four fields for any Finance user', async () => {
    const { updateDetailsAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await updateDetailsAction(fd({
      checkId: check.id, remarks: 'hold', pointPerson: 'ANA', checksPossession: 'TREASURY', category: 'payroll',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.remarks).toBe('hold')
    expect(after.pointPerson).toBe('ANA')
    expect(after.checksPossession).toBe('TREASURY')
    expect(after.category).toBe('PAYROLL')
  })

  it('reports success, and writes nothing, when nothing changed', async () => {
    const { updateDetailsAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await updateDetailsAction(fd({ checkId: check.id, remarks: '', pointPerson: '', checksPossession: '', category: '' }))
    expect(result).toEqual({ ok: true })
    expect(await testDb.auditLog.count({ where: { checkId: check.id, action: 'details_updated' } })).toBe(0)
  })

  it('reads the expected outflow date from the form', async () => {
    const { updateDetailsAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await updateDetailsAction(fd({ checkId: check.id, expectedOutflowDate: '2026-09-20' }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.expectedOutflowDate).toEqual(new Date('2026-09-20T00:00:00.000Z'))
  })
})

describe('clearingAction', () => {
  async function released() {
    const { readyForReleaseAction, releaseAction } = await import('@/app/checks/actions')
    const check = await makeCheck({ status: 'SIGNED' })
    await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    await releaseAction(fd({ checkId: check.id }))
    return check
  }

  it('records CLEARED straight from NONE, with the bank reference and the date', async () => {
    const { clearingAction } = await import('@/app/checks/actions')
    const check = await released()
    const result = await clearingAction(fd({
      checkId: check.id, clearingStatus: 'CLEARED', crNumber: 'BPI 88123', clearedDate: '2026-09-10',
    }))
    expect(result).toEqual({ ok: true })
    const after = await testDb.check.findUniqueOrThrow({ where: { id: check.id } })
    expect(after.clearingStatus).toBe('CLEARED')
    expect(after.crNumber).toBe('BPI 88123')
    expect(after.clearedDate).toEqual(new Date('2026-09-10'))
    // Rule 11 in the other direction: the bank's reference never becomes a receipt.
    expect(after.orNumber).toBeNull()
    expect(after.receiptType).toBeNull()
  })

  it('refuses a move off CLEARED', async () => {
    const { clearingAction } = await import('@/app/checks/actions')
    const check = await released()
    await clearingAction(fd({ checkId: check.id, clearingStatus: 'CLEARED' }))
    const result = await clearingAction(fd({ checkId: check.id, clearingStatus: 'DEPOSITED' }))
    expect(result.ok).toBe(false)
  })
})

describe('revertSignatureAction', () => {
  it('lets a FINANCE_USER revert a SIGNED check', async () => {
    const { revertSignatureAction } = await import('@/app/checks/actions')
    const c = await makeCheck({ status: 'SIGNED' })
    const result = await revertSignatureAction(fd({ checkId: c.id }))
    expect(result).toEqual({ ok: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })
})

describe('readyForReleaseAction: notifications', () => {
  it('notifies the other users, naming the check', async () => {
    const { readyForReleaseAction } = await import('@/app/checks/actions')
    const other = await makeUser('FINANCE_USER')
    const check = await makeCheck({ status: 'SIGNED' })
    const result = await readyForReleaseAction(fd({ checkId: check.id, availablePickupDate: '2026-09-03' }))
    expect(result.ok).toBe(true)
    const rows = await testDb.notification.findMany()
    expect(rows.map((r) => r.userId)).toEqual([other.id])
    expect(rows[0].message).toBe(`Finance User marked check ${check.checkNumber} READY FOR RELEASE: ₱197,715.42`)
  })
})
