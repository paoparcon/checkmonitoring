import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { verifyPassword } from '@/lib/password'

// A mutable session, so one file can exercise both roles. Every action here
// must refuse a FINANCE_USER by RETURNING a result, never by redirecting:
// `requireAdmin` redirects, Next implements a redirect by throwing, and the
// action's own catch would swallow it — reporting "something went wrong" on a
// page the user is not entitled to.
const currentUser: { id: string; email: string; name: string; role: 'FINANCE_USER' | 'FINANCE_ADMIN' } = {
  id: '', email: 'admin@rcl.test', name: 'Finance Admin', role: 'FINANCE_ADMIN',
}

vi.mock('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
}))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const STRONG = 'Zq7!vantablack-Ledger'

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

beforeEach(async () => {
  await resetDb()
  currentUser.role = 'FINANCE_ADMIN'
  const actor = await testDb.user.create({
    data: {
      email: `a${Math.random().toString(36).slice(2)}@rcl.test`,
      name: 'Finance Admin', passwordHash: 'x', role: 'FINANCE_ADMIN',
    },
  })
  currentUser.id = actor.id
})

async function otherAdmin() {
  return testDb.user.create({
    data: {
      email: `b${Math.random().toString(36).slice(2)}@rcl.test`,
      name: 'The Other Admin', passwordHash: 'x', role: 'FINANCE_ADMIN',
    },
  })
}

describe('createUserAction', () => {
  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    currentUser.role = 'FINANCE_USER'
    const result = await createUserAction(
      fd({ email: 'x@rcl.com.ph', name: 'X', password: STRONG, role: 'FINANCE_USER' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    expect(await testDb.user.count()).toBe(1)
  })

  it('creates the account and reports success', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    const result = await createUserAction(
      fd({ email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG, role: 'FINANCE_ADMIN' }),
    )
    expect(result.ok).toBe(true)
    const row = await testDb.user.findUniqueOrThrow({ where: { email: 'j.cruz@rcl.com.ph' } })
    expect(row.role).toBe('FINANCE_ADMIN')
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })

  // Rule 3, at the boundary that actually leaves the server: whatever this
  // returns is serialised back to the browser.
  it('returns nothing that contains the password, and logs none of it', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    const result = await createUserAction(
      fd({ email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG, role: 'FINANCE_USER' }),
    )
    expect(JSON.stringify(result)).not.toContain(STRONG)

    const row = await testDb.user.findUniqueOrThrow({ where: { email: 'j.cruz@rcl.com.ph' } })
    const trail = JSON.stringify(await testDb.auditLog.findMany())
    expect(trail).not.toContain(STRONG)
    expect(trail).not.toContain(row.passwordHash)
  })

  it('puts the password policy in front of the user rather than a generic failure', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    const result = await createUserAction(
      fd({ email: 'weak@rcl.com.ph', name: 'Weak', password: 'password', role: 'FINANCE_USER' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/12 characters/)
    expect(await testDb.user.count()).toBe(1)
  })

  it('refuses a role it does not recognise instead of writing one', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    const result = await createUserAction(
      fd({ email: 'x@rcl.com.ph', name: 'X', password: STRONG, role: 'SUPERUSER' }),
    )
    expect(result.ok).toBe(false)
    expect(await testDb.user.count()).toBe(1)
  })

  it('reports a duplicate email as a message, not a crash', async () => {
    const { createUserAction } = await import('@/app/admin/users/actions')
    await createUserAction(fd({ email: 'dup@rcl.com.ph', name: 'A', password: STRONG, role: 'FINANCE_USER' }))
    const result = await createUserAction(
      fd({ email: 'dup@rcl.com.ph', name: 'B', password: STRONG, role: 'FINANCE_USER' }),
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/already/i)
  })
})

describe('changeUserRoleAction', () => {
  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { changeUserRoleAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()
    currentUser.role = 'FINANCE_USER'
    const result = await changeUserRoleAction(fd({ userId: target.id, role: 'FINANCE_USER' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('FINANCE_ADMIN')
  })

  it('lets an admin demote themselves while another active admin exists', async () => {
    const { changeUserRoleAction } = await import('@/app/admin/users/actions')
    await otherAdmin()
    const result = await changeUserRoleAction(fd({ userId: currentUser.id, role: 'FINANCE_USER' }))
    expect(result.ok).toBe(true)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: currentUser.id } })).role).toBe('FINANCE_USER')
  })

  it('refuses the same self-demotion when they are the last active admin', async () => {
    const { changeUserRoleAction } = await import('@/app/admin/users/actions')
    const result = await changeUserRoleAction(fd({ userId: currentUser.id, role: 'FINANCE_USER' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/last active Finance Admin/i)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: currentUser.id } })).role).toBe('FINANCE_ADMIN')
  })
})

describe('setUserActiveAction', () => {
  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { setUserActiveAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()
    currentUser.role = 'FINANCE_USER'
    const result = await setUserActiveAction(fd({ userId: target.id, active: 'false' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(true)
  })

  it('deactivates and reactivates without ever deleting the row', async () => {
    const { setUserActiveAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()

    expect((await setUserActiveAction(fd({ userId: target.id, active: 'false' }))).ok).toBe(true)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false)

    expect((await setUserActiveAction(fd({ userId: target.id, active: 'true' }))).ok).toBe(true)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(true)
  })

  it('refuses to deactivate the last active admin', async () => {
    const { setUserActiveAction } = await import('@/app/admin/users/actions')
    const result = await setUserActiveAction(fd({ userId: currentUser.id, active: 'false' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/last active Finance Admin/i)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: currentUser.id } })).active).toBe(true)
  })
})

describe('setUserPasswordAction', () => {
  it('refuses a Finance user with a result rather than a redirect', async () => {
    const { setUserPasswordAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()
    currentUser.role = 'FINANCE_USER'
    const result = await setUserPasswordAction(fd({ userId: target.id, password: STRONG }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBe('x')
  })

  it('sets the password the admin typed and returns none of it', async () => {
    const { setUserPasswordAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()

    const result = await setUserPasswordAction(fd({ userId: target.id, password: STRONG }))
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain(STRONG)

    const row = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
    expect(JSON.stringify(await testDb.auditLog.findMany())).not.toContain(STRONG)
  })

  it('surfaces the password policy rather than a generic failure', async () => {
    const { setUserPasswordAction } = await import('@/app/admin/users/actions')
    const target = await otherAdmin()
    const result = await setUserPasswordAction(fd({ userId: target.id, password: 'short' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/12 characters/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).passwordHash).toBe('x')
  })
})

describe('the module as a whole', () => {
  // Rule 1 again, at the layer a browser can actually reach. A server action is
  // an HTTP endpoint; one named `deleteUserAction` would be callable by anyone
  // holding an admin session, and there must not be one to call.
  it('exports no action that deletes a user', async () => {
    const mod = await import('@/app/admin/users/actions')
    expect(Object.keys(mod).sort()).toEqual([
      'approveUserAction',
      'changeUserRoleAction',
      'createUserAction',
      'rejectUserAction',
      'setUserActiveAction',
      'setUserPasswordAction',
    ])
  })
})

describe('approveUserAction and rejectUserAction', () => {
  async function pendingAccount(email = 'p@rcl.com.ph') {
    const { registerUser } = await import('@/lib/admin/users')
    await registerUser(testDb, { email, name: 'Pending Person', password: STRONG })
    return testDb.user.findUniqueOrThrow({ where: { email } })
  }

  it('both refuse a Finance user with a result rather than a redirect', async () => {
    const { approveUserAction, rejectUserAction } = await import('@/app/admin/users/actions')
    const p = await pendingAccount()
    currentUser.role = 'FINANCE_USER'
    for (const result of [
      await approveUserAction(fd({ userId: p.id, role: 'FINANCE_USER' })),
      await rejectUserAction(fd({ userId: p.id })),
    ]) {
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.message).toMatch(/Finance Admin/)
    }
    const after = await testDb.user.findUniqueOrThrow({ where: { id: p.id } })
    expect(after.active).toBe(false)
    expect(after.pendingSince).not.toBeNull()
  })

  it('approve needs a role', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const p = await pendingAccount()
    const result = await approveUserAction(fd({ userId: p.id, role: 'OWNER' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/Choose a role/)
  })

  it('approve activates with the chosen role; reject leaves it deactivated', async () => {
    const { approveUserAction, rejectUserAction } = await import('@/app/admin/users/actions')
    const a = await pendingAccount('a@rcl.com.ph')
    const b = await pendingAccount('b@rcl.com.ph')

    expect(await approveUserAction(fd({
      userId: a.id, role: 'FINANCE_ADMIN', pendingSince: a.pendingSince!.toISOString(),
    }))).toEqual({ ok: true })
    expect(await rejectUserAction(fd({ userId: b.id }))).toEqual({ ok: true })

    expect(await testDb.user.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ active: true, role: 'FINANCE_ADMIN', pendingSince: null })
    expect(await testDb.user.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ active: false, pendingSince: null })
  })

  it('refuses to approve a registration that changed after the page loaded', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const { registerUser } = await import('@/lib/admin/users')
    const p = await pendingAccount()
    const seen = p.pendingSince!.toISOString()
    // Make sure the second pendingSince cannot collide with the first.
    await new Promise((r) => setTimeout(r, 20))
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Someone Else Entirely', password: STRONG })

    const result = await approveUserAction(fd({ userId: p.id, role: 'FINANCE_USER', pendingSince: seen }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/re-registered/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: p.id } })).active).toBe(false)
  })

  it('treats an unreadable pendingSince as absent: the approval still goes through', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const p = await pendingAccount()
    expect(await approveUserAction(fd({ userId: p.id, role: 'FINANCE_USER', pendingSince: 'garbage' }))).toEqual({ ok: true })
    expect(await testDb.user.findUniqueOrThrow({ where: { id: p.id } })).toMatchObject({ active: true, pendingSince: null })
  })

  it('reports a domain refusal in its own words', async () => {
    const { approveUserAction } = await import('@/app/admin/users/actions')
    const notPending = await testDb.user.create({
      data: { email: 'n@rcl.com.ph', name: 'Not Pending', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    const result = await approveUserAction(fd({ userId: notPending.id, role: 'FINANCE_USER' }))
    expect(result).toEqual({ ok: false, message: 'Not Pending is not waiting for approval.' })
  })
})
