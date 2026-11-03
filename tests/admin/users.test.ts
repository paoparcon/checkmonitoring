import { describe, it, expect, beforeEach } from 'vitest'
import type { Prisma, Role } from '@prisma/client'
import { testDb, resetDb } from '../helpers/db'
import { DomainError } from '@/lib/domain/errors'
import { hashPassword, verifyPassword } from '@/lib/password'
import { BACKOFF_MINUTES, EMAIL_FREE_FAILURES, loginLockout } from '@/lib/login-throttle'
import {
  SEEDED_TEST_ACCOUNT_EMAILS,
  approveUser, changeUserRole, createUser, isPending, listUsers, registerUser, rejectUser,
  setUserActive, setUserPassword,
} from '@/lib/admin/users'

// A password that satisfies `validatePasswordStrength`. Used as the literal the
// "no password material anywhere" assertions search for, so it must be a
// distinctive string that could not appear in a row by coincidence.
const STRONG = 'Zq7!vantablack-Ledger'
const STRONG_TWO = 'Xw4?permafrost-Ledger'
const STRONG_OLD = 'Rm3#granite-Daybook'

beforeEach(resetDb)

async function makeAdmin(overrides: { email?: string; name?: string; active?: boolean } = {}) {
  return testDb.user.create({
    data: {
      email: overrides.email ?? `admin${Math.random().toString(36).slice(2)}@rcl.test`,
      name: overrides.name ?? 'Finance Admin',
      passwordHash: 'x',
      role: 'FINANCE_ADMIN',
      active: overrides.active ?? true,
    },
  })
}

async function makeFinanceUser(overrides: { email?: string; active?: boolean } = {}) {
  return testDb.user.create({
    data: {
      email: overrides.email ?? `user${Math.random().toString(36).slice(2)}@rcl.test`,
      name: 'Finance User',
      passwordHash: 'x',
      role: 'FINANCE_USER',
      active: overrides.active ?? true,
    },
  })
}

/** A deactivated colleague whose genuine password is STRONG_OLD. */
async function deactivatedWithOldPassword(email = 'ayessa@rcl.com.ph') {
  return testDb.user.create({
    data: { email, name: 'Old Name', passwordHash: await hashPassword(STRONG_OLD), role: 'FINANCE_ADMIN', active: false },
  })
}

/** Every audit row, serialised, so a test can search the whole trail at once. */
async function auditText(): Promise<string> {
  return JSON.stringify(await testDb.auditLog.findMany())
}

describe('the user administration module', () => {
  // Rule 1, made structural rather than remembered. A `User` is referenced by
  // `AuditLog` and by five `Check` relations, all of which null out on delete —
  // so a hard delete silently erases who released real money. This assertion is
  // the same device `tests/actions/audit.test.ts` uses to keep `lib/audit.ts`
  // free of an update or delete helper.
  it('offers no delete of any kind', async () => {
    const mod = await import('@/lib/admin/users')
    const exported = Object.keys(mod).sort()
    expect(exported.some((k) => /delete|remove|destroy|purge/i.test(k))).toBe(false)
    expect(exported).toEqual([
      'SEEDED_TEST_ACCOUNT_EMAILS',
      'approveUser',
      'changeUserRole',
      'createUser',
      'isPending',
      'listUsers',
      'registerUser',
      'rejectUser',
      'setUserActive',
      'setUserPassword',
    ])
  })
})

describe('listUsers', () => {
  it('reports name, email, role, active and last login', async () => {
    const when = new Date('2026-09-03T02:15:00.000Z')
    await testDb.user.create({
      data: {
        email: 'r.santos@rcl.com.ph', name: 'Rosario Santos', passwordHash: 'x',
        role: 'FINANCE_ADMIN', active: true, lastLoginAt: when,
      },
    })

    const [row] = await listUsers(testDb)
    expect(row).toMatchObject({
      email: 'r.santos@rcl.com.ph',
      name: 'Rosario Santos',
      role: 'FINANCE_ADMIN',
      active: true,
      lastLoginAt: when,
    })
  })

  // This list is handed to a client component, and anything on it is serialised
  // into the page. An argon2 hash is not a secret a browser needs.
  it('never carries a password hash off the server', async () => {
    await createUser(testDb, {
      email: 'new@rcl.com.ph', name: 'New Person', password: STRONG,
      role: 'FINANCE_USER', actorId: (await makeAdmin()).id,
    })

    const rows = await listUsers(testDb)
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('passwordHash')
      expect(Object.keys(row)).not.toContain('pendingPasswordHash')
    }
    expect(JSON.stringify(rows)).not.toContain(STRONG)
  })

  it('reports a held registration as hasPendingCredentials and carries no hash for it', async () => {
    await deactivatedWithOldPassword('held@rcl.com.ph')
    await registerUser(testDb, { email: 'held@rcl.com.ph', name: 'Held Name', password: STRONG })
    await registerUser(testDb, { email: 'fresh@rcl.com.ph', name: 'Fresh', password: STRONG })
    await makeFinanceUser({ email: 'plain@rcl.com.ph' })

    const rows = await listUsers(testDb)
    const by = (e: string) => rows.find((r) => r.email === e)!
    expect(by('held@rcl.com.ph')).toMatchObject({ name: 'Old Name', pendingName: 'Held Name', hasPendingCredentials: true })
    expect(by('fresh@rcl.com.ph')).toMatchObject({ pendingName: null, hasPendingCredentials: false })
    expect(by('plain@rcl.com.ph')).toMatchObject({ pendingName: null, hasPendingCredentials: false })
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('passwordHash')
      expect(Object.keys(row)).not.toContain('pendingPasswordHash')
    }
    const text = JSON.stringify(rows)
    expect(text).not.toContain(STRONG)
    expect(text).not.toContain('argon2')
  })

  it('flags the seeded test accounts and nothing else', async () => {
    for (const email of SEEDED_TEST_ACCOUNT_EMAILS) {
      await testDb.user.create({
        data: { email, name: 'Seeded', passwordHash: 'x', role: 'FINANCE_ADMIN' },
      })
    }
    const real = await makeAdmin({ email: 'real.admin@rcl.com.ph' })

    const rows = await listUsers(testDb)
    const flagged = rows.filter((r) => r.isSeededTestAccount).map((r) => r.email).sort()
    expect(flagged).toEqual([...SEEDED_TEST_ACCOUNT_EMAILS].sort())
    expect(rows.find((r) => r.id === real.id)?.isSeededTestAccount).toBe(false)
  })

  it('lists active users before deactivated ones', async () => {
    await makeFinanceUser({ email: 'z.gone@rcl.com.ph', active: false })
    await makeFinanceUser({ email: 'a.here@rcl.com.ph', active: true })

    const rows = await listUsers(testDb)
    expect(rows.map((r) => r.email)).toEqual(['a.here@rcl.com.ph', 'z.gone@rcl.com.ph'])
  })

  // Failed sign-ins are otherwise invisible. An admin who cannot see a count
  // climbing has no way to know the login is being attacked, and no way to
  // explain to a colleague why they are being refused.
  it('reports recent failed sign-ins and the lockout for each account', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    const justNow = new Date(now.getTime() - 5_000)
    await makeFinanceUser({ email: 'under.attack@rcl.com.ph' })
    await makeFinanceUser({ email: 'z.quiet@rcl.com.ph' })

    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'under.attack@rcl.com.ph', ip: '203.0.113.9',
          success: false, createdAt: justNow,
        },
      })
    }

    const rows = await listUsers(testDb, now)
    const attacked = rows.find((r) => r.email === 'under.attack@rcl.com.ph')!
    const quiet = rows.find((r) => r.email === 'z.quiet@rcl.com.ph')!

    expect(attacked.recentFailedLogins).toBe(EMAIL_FREE_FAILURES + 1)
    expect(attacked.lockedUntil).toEqual(new Date(justNow.getTime() + BACKOFF_MINUTES[0] * 60_000))
    expect(quiet).toMatchObject({ recentFailedLogins: 0, lockedUntil: null })
  })

  // The screen must agree with the gate: telling an admin an account is fine
  // while sign-in refuses it is worse than showing nothing at all.
  it('agrees with the sign-in gate about who is locked', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    await makeFinanceUser({ email: 'under.attack@rcl.com.ph' })
    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'under.attack@rcl.com.ph', ip: '203.0.113.9',
          success: false, createdAt: new Date(now.getTime() - 5_000),
        },
      })
    }

    const [row] = await listUsers(testDb, now)
    const lockout = await loginLockout(
      testDb, { email: 'under.attack@rcl.com.ph', ip: '198.51.100.4', now },
    )
    expect(row.lockedUntil).toEqual(lockout.until)
  })

  it('shows no lockout once the back-off has lapsed', async () => {
    const now = new Date('2026-09-04T08:00:00.000Z')
    await makeFinanceUser({ email: 'recovered@rcl.com.ph' })
    for (let i = 0; i < EMAIL_FREE_FAILURES + 1; i++) {
      await testDb.loginAttempt.create({
        data: {
          email: 'recovered@rcl.com.ph', ip: '203.0.113.9', success: false,
          createdAt: new Date(now.getTime() - (BACKOFF_MINUTES[0] + 1) * 60_000),
        },
      })
    }

    const [row] = await listUsers(testDb, now)
    expect(row.recentFailedLogins).toBe(EMAIL_FREE_FAILURES + 1)
    expect(row.lockedUntil).toBeNull()
  })
})

describe('createUser', () => {
  it('stores an argon2 hash of the password the human typed, never the password', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_ADMIN', actorId: actor.id,
    })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: created.id } })
    expect(row.passwordHash).not.toBe(STRONG)
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })

  // `authorize` lowercases and trims what is typed at sign-in before looking the
  // account up. An account stored as "J.Cruz@RCL.com.ph " could therefore never
  // be signed into at all — it would look like a wrong password forever.
  it('stores the email the way sign-in will look it up', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: '  J.Cruz@RCL.com.ph ', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })
    expect(created.email).toBe('j.cruz@rcl.com.ph')
  })

  it('refuses a weak password and writes no user at all', async () => {
    const actor = await makeAdmin()
    const before = await testDb.user.count()

    await expect(createUser(testDb, {
      email: 'weak@rcl.com.ph', name: 'Weak', password: 'password',
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    expect(await testDb.user.count()).toBe(before)
  })

  it('refuses an email that already has an account', async () => {
    const actor = await makeAdmin()
    await makeFinanceUser({ email: 'taken@rcl.com.ph' })

    await expect(createUser(testDb, {
      email: 'TAKEN@rcl.com.ph', name: 'Second', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('refuses something that is not shaped like an email address', async () => {
    const actorId = (await makeAdmin()).id
    const before = await testDb.user.count()
    for (const bad of ['plain', 'a@b', 'a b@rcl.com.ph', '@rcl.com.ph']) {
      const err = await createUser(testDb, { email: bad, name: 'X', password: STRONG, role: 'FINANCE_USER', actorId }).catch((e) => e)
      expect(err, bad).toBeInstanceOf(DomainError)
      expect(err.code, bad).toBe('EMAIL_INVALID')
    }
    expect(await testDb.user.count()).toBe(before)
  })

  it('refuses a blank name rather than creating a nameless account', async () => {
    const actor = await makeAdmin()
    await expect(createUser(testDb, {
      email: 'nameless@rcl.com.ph', name: '   ', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('writes an audit row naming the actor and the account, with no password material in it', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_ADMIN', actorId: actor.id,
    })

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({
      checkId: null,          // a user-administration event is about no cheque
      actorType: 'USER',
      userId: actor.id,
      action: 'user_created',
    })
    expect(row.details).toMatchObject({ targetUserId: created.id, email: 'j.cruz@rcl.com.ph', role: 'FINANCE_ADMIN' })

    // The plaintext, and the hash it produced, are both absent from the trail.
    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    const stored = await testDb.user.findUniqueOrThrow({ where: { id: created.id } })
    expect(trail).not.toContain(stored.passwordHash)
  })

  it('returns no password material to its caller', async () => {
    const actor = await makeAdmin()
    const created = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })
    expect(Object.keys(created)).not.toContain('passwordHash')
    expect(JSON.stringify(created)).not.toContain(STRONG)
  })
})

describe('changeUserRole', () => {
  it('promotes a Finance user and records who did it', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await changeUserRole(testDb, { userId: target.id, role: 'FINANCE_ADMIN', actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).role).toBe('FINANCE_ADMIN')
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_role_changed' })
    expect(row.details).toMatchObject({ targetUserId: target.id, from: 'FINANCE_USER', to: 'FINANCE_ADMIN' })
  })

  it('lets an admin demote themselves while another active admin exists', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })
    await makeAdmin({ name: 'The Other Admin' })

    await changeUserRole(testDb, { userId: actor.id, role: 'FINANCE_USER', actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('FINANCE_USER')
  })

  it('refuses to let the last active admin demote themselves', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })

    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    // Refused means unchanged, not partially applied.
    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).role).toBe('FINANCE_ADMIN')
    expect(await testDb.auditLog.count()).toBe(0)
  })

  // A deactivated admin is refused at sign-in, so they cannot administer
  // anything. Counting them would leave the door apparently open and actually
  // locked.
  it('does not count a deactivated admin as keeping the door open', async () => {
    const actor = await makeAdmin()
    await makeAdmin({ active: false })

    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })

  it('says plainly why the last admin cannot be demoted', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })
    await expect(changeUserRole(testDb, {
      userId: actor.id, role: 'FINANCE_USER', actorId: actor.id,
    })).rejects.toThrow(/last active Finance Admin/i)
  })

  it('is a no-op when the role is already what was asked for', async () => {
    const actor = await makeAdmin()
    const only = await makeAdmin()

    // Would otherwise trip the guard: `only` is one of two active admins here,
    // but the same call against a sole admin must not be refused for "demoting"
    // them to the role they already hold.
    await changeUserRole(testDb, { userId: only.id, role: 'FINANCE_ADMIN', actorId: actor.id })
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('refuses an unknown user rather than reporting success', async () => {
    const actor = await makeAdmin()
    await expect(changeUserRole(testDb, {
      userId: 'nope', role: 'FINANCE_ADMIN', actorId: actor.id,
    })).rejects.toThrow(DomainError)
  })
})

describe('setUserActive', () => {
  it('deactivates a user and records it', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await setUserActive(testDb, { userId: target.id, active: false, actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false)
    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_deactivated' })
    expect(row.details).toMatchObject({ targetUserId: target.id })
  })

  it('reactivates a user and records that separately', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser({ active: false })

    await setUserActive(testDb, { userId: target.id, active: true, actorId: actor.id })

    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(true)
    expect((await testDb.auditLog.findFirstOrThrow()).action).toBe('user_reactivated')
  })

  it('refuses to deactivate the last active admin', async () => {
    const actor = await makeAdmin({ name: 'Rosario Santos' })

    await expect(setUserActive(testDb, {
      userId: actor.id, active: false, actorId: actor.id,
    })).rejects.toThrow(/last active Finance Admin/i)

    expect((await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })).active).toBe(true)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('allows deactivating an admin once another active admin exists', async () => {
    const actor = await makeAdmin()
    const other = await makeAdmin()

    await setUserActive(testDb, { userId: other.id, active: false, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: other.id } })).active).toBe(false)
  })

  it('never blocks deactivating a Finance user', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()
    await setUserActive(testDb, { userId: target.id, active: false, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: target.id } })).active).toBe(false)
  })

  // The one the client actually has to perform. `admin@rcl.test` ships with a
  // password committed to `prisma/seed.ts`; retiring it is a deactivation,
  // never a delete, and the guard must permit it as soon as a real admin exists.
  it('permits deactivating a seeded admin account once a real admin exists', async () => {
    const seeded = await testDb.user.create({
      data: {
        email: SEEDED_TEST_ACCOUNT_EMAILS[0], name: 'Finance Admin',
        passwordHash: 'x', role: 'FINANCE_ADMIN',
      },
    })
    const real = await makeAdmin({ email: 'real.admin@rcl.com.ph' })

    await setUserActive(testDb, { userId: seeded.id, active: false, actorId: real.id })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: seeded.id } })
    expect(row.active).toBe(false)
    // Deactivated, still present: the audit trail keeps pointing at a real row.
    expect(row.email).toBe(SEEDED_TEST_ACCOUNT_EMAILS[0])
  })

  it('is a no-op when the user is already in the state asked for', async () => {
    const actor = await makeAdmin()
    const only = await makeAdmin()
    await setUserActive(testDb, { userId: only.id, active: true, actorId: actor.id })
    expect(await testDb.auditLog.count()).toBe(0)
  })
})

describe('setUserPassword', () => {
  it('replaces the hash so the old password stops working and the new one starts', async () => {
    const actor = await makeAdmin()
    const target = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })

    await setUserPassword(testDb, { userId: target.id, password: STRONG_TWO, actorId: actor.id })

    const row = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(await verifyPassword(row.passwordHash, STRONG_TWO)).toBe(true)
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(false)
  })

  it('on a re-registered account, discards the held password: a later APPROVE keeps the admin password, and still applies the held name', async () => {
    const actor = await makeAdmin()
    await deactivatedWithOldPassword()
    await registerUser(testDb, { email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'ayessa@rcl.com.ph' } })

    await setUserPassword(testDb, { userId: pending.id, password: STRONG_TWO, actorId: actor.id })

    const held = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(held.pendingPasswordHash).toBeNull()
    expect(held.pendingName).toBe('Ayessa Morinne')
    expect(held.pendingSince).not.toBeNull()
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_password_set' } })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, heldPasswordDiscarded: true })

    await approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: actor.id })
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(await verifyPassword(u.passwordHash, STRONG_TWO)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(false)
    expect(u.name).toBe('Ayessa Morinne')
  })

  it('does not mark heldPasswordDiscarded when no password was held', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()
    await setUserPassword(testDb, { userId: target.id, password: STRONG, actorId: actor.id })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_password_set' } })
    expect(audit.details).not.toHaveProperty('heldPasswordDiscarded')
  })

  it('records that a password was set without recording the password', async () => {
    const actor = await makeAdmin()
    const target = await makeFinanceUser()

    await setUserPassword(testDb, { userId: target.id, password: STRONG, actorId: actor.id })

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'USER', userId: actor.id, action: 'user_password_set' })
    expect(row.details).toMatchObject({ targetUserId: target.id })

    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    const stored = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(trail).not.toContain(stored.passwordHash)
  })

  it('refuses a weak password and leaves the existing one standing', async () => {
    const actor = await makeAdmin()
    const target = await createUser(testDb, {
      email: 'j.cruz@rcl.com.ph', name: 'Josefina Cruz', password: STRONG,
      role: 'FINANCE_USER', actorId: actor.id,
    })

    await expect(setUserPassword(testDb, {
      userId: target.id, password: 'short', actorId: actor.id,
    })).rejects.toThrow(DomainError)

    const row = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })

  // Setting a password neither deactivates nor demotes, so the last-admin guard
  // has nothing to say about it — a sole admin must always be able to change
  // their own password.
  it('lets the last active admin set their own password', async () => {
    const actor = await makeAdmin()
    await setUserPassword(testDb, { userId: actor.id, password: STRONG, actorId: actor.id })
    const row = await testDb.user.findUniqueOrThrow({ where: { id: actor.id } })
    expect(await verifyPassword(row.passwordHash, STRONG)).toBe(true)
  })
})

describe('the role argument', () => {
  // Typed as the Prisma enum rather than a widened string, so a typo is a
  // compile error rather than a Prisma runtime failure in front of a user.
  it('accepts each declared role', async () => {
    const actor = await makeAdmin()
    const roles: Role[] = ['FINANCE_USER', 'FINANCE_ADMIN']
    for (const role of roles) {
      const created = await createUser(testDb, {
        email: `${role.toLowerCase()}@rcl.com.ph`, name: 'Person', password: STRONG,
        role, actorId: actor.id,
      })
      expect(created.role).toBe(role)
    }
  })
})

describe('isPending', () => {
  it('is inactive with pendingSince set, and nothing else', () => {
    const t = new Date()
    expect(isPending({ active: false, pendingSince: t })).toBe(true)
    expect(isPending({ active: false, pendingSince: null })).toBe(false)
    expect(isPending({ active: true, pendingSince: t })).toBe(false)
    expect(isPending({ active: true, pendingSince: null })).toBe(false)
  })
})

describe('registerUser', () => {
  it('creates an inactive pending account, hashed, with a SYSTEM audit row and no return value', async () => {
    const result = await registerUser(testDb, { email: ' New.Person@RCL.com.ph ', name: ' New Person ', password: STRONG })
    expect(result).toBeUndefined()

    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new.person@rcl.com.ph' } })
    expect(u).toMatchObject({ name: 'New Person', active: false, role: 'FINANCE_USER' })
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ checkId: null, actorType: 'SYSTEM', userId: null, action: 'user_registered', remarks: 'new.person@rcl.com.ph' })
    expect(row.details).toMatchObject({ targetUserId: u.id, email: 'new.person@rcl.com.ph', name: 'New Person' })
    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    expect(trail).not.toContain(u.passwordHash)
  })

  it('enforces the password policy and requires a name', async () => {
    await expect(registerUser(testDb, { email: 'x@rcl.com.ph', name: 'X', password: 'short' }))
      .rejects.toMatchObject({ code: 'WEAK_PASSWORD' })
    await expect(registerUser(testDb, { email: 'x@rcl.com.ph', name: '  ', password: STRONG }))
      .rejects.toMatchObject({ code: 'NAME_REQUIRED' })
    expect(await testDb.user.count()).toBe(0)
  })

  it('refuses an ACTIVE account\'s address with a sentence that gives nothing away', async () => {
    await makeFinanceUser({ email: 'taken@rcl.com.ph' })
    const err = await registerUser(testDb, { email: 'taken@rcl.com.ph', name: 'Someone', password: STRONG }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('EMAIL_TAKEN')
    expect(err.message).toBe('An account for that address already exists.')
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('re-opens a DEACTIVATED account: same id, pending, still inactive - and name and password UNCHANGED', async () => {
    // The row's name and password are read live (SIGNED BY, RELEASED BY, the portal's
    // releasedBy, sign-in after a reactivation), so an anonymous submission naming its
    // address changes NEITHER: what was typed is held aside until approval.
    const old = await deactivatedWithOldPassword()
    await registerUser(testDb, { email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne', password: STRONG })

    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'ayessa@rcl.com.ph' } })
    expect(u.id).toBe(old.id)
    expect(u).toMatchObject({ name: 'Old Name', active: false, role: 'FINANCE_ADMIN', pendingName: 'Ayessa Morinne' })
    expect(u.pendingSince).not.toBeNull()
    expect(u.passwordHash).toBe(old.passwordHash)
    expect(await verifyPassword(u.passwordHash, STRONG_OLD)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(false)
    expect(await verifyPassword(u.pendingPasswordHash!, STRONG)).toBe(true)
    expect(await testDb.user.count()).toBe(1)

    const row = await testDb.auditLog.findFirstOrThrow()
    expect(row).toMatchObject({ actorType: 'SYSTEM', userId: null, action: 'user_reregistered' })
    expect(row.details).toMatchObject({
      targetUserId: old.id, email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne',
      currentName: 'Old Name', wasPending: false,
    })
    const trail = await auditText()
    expect(trail).not.toContain(STRONG)
    expect(trail).not.toContain(u.pendingPasswordHash!)
  })

  it('re-opens an account that is already pending: the typed name and password replace only the held ones', async () => {
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'First Try', password: STRONG })
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Second Try', password: STRONG_TWO })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    // The first registration created the row, so it still carries that name and password.
    expect(u.name).toBe('First Try')
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(u.pendingName).toBe('Second Try')
    expect(await verifyPassword(u.pendingPasswordHash!, STRONG_TWO)).toBe(true)
    expect(isPending(u)).toBe(true)
    const actions = (await testDb.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map((r) => r.action)
    expect(actions).toEqual(['user_registered', 'user_reregistered'])
  })

  it('requires an email', async () => {
    await expect(registerUser(testDb, { email: '   ', name: 'X', password: STRONG }))
      .rejects.toMatchObject({ code: 'EMAIL_REQUIRED' })
    expect(await testDb.user.count()).toBe(0)
  })

  it('refuses something that is not shaped like an email address, and writes nothing', async () => {
    for (const bad of ['plain', 'no-at.rcl.com.ph', '@rcl.com.ph', 'a@b', 'a b@rcl.com.ph', 'a@@rcl.com.ph', 'a@rcl .com']) {
      const err = await registerUser(testDb, { email: bad, name: 'X', password: STRONG }).catch((e) => e)
      expect(err, bad).toBeInstanceOf(DomainError)
      expect(err.code, bad).toBe('EMAIL_INVALID')
      expect(err.message).toBe('Enter a valid email address.')
    }
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('leaves an ACTIVE account untouched: hash, name, flag, active, and no audit row', async () => {
    const before = await makeFinanceUser({ email: 'live@rcl.com.ph' })
    await expect(registerUser(testDb, { email: 'live@rcl.com.ph', name: 'Intruder', password: STRONG }))
      .rejects.toMatchObject({ code: 'EMAIL_TAKEN' })
    const after = await testDb.user.findUniqueOrThrow({ where: { id: before.id } })
    expect(after.passwordHash).toBe(before.passwordHash)
    expect(after.name).toBe(before.name)
    expect(after.pendingSince).toBeNull()
    expect(after.active).toBe(true)
    expect(await testDb.auditLog.count()).toBe(0)
  })

  it('never sets a password on an account an admin activates at the same moment', async () => {
    // A property test, not a deterministic one: the interleaving is not
    // controllable. Either activation wins (active, ORIGINAL hash) or the
    // registration does (inactive and pending, NEW hash). Never active with
    // the new hash - the UPDATE is conditional on `active = false`.
    const admin = await makeAdmin()
    const target = await testDb.user.create({
      data: { email: 'race@rcl.com.ph', name: 'Old', passwordHash: 'original-hash', role: 'FINANCE_USER', active: false },
    })
    await Promise.allSettled([
      registerUser(testDb, { email: 'race@rcl.com.ph', name: 'New', password: STRONG }),
      setUserActive(testDb, { userId: target.id, active: true, actorId: admin.id }),
    ])
    const u = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    // Whoever wins, the row's own name and password are never the stranger's, and
    // an ACTIVE row carries no held credentials.
    expect(u.name).toBe('Old')
    expect(u.passwordHash).toBe('original-hash')
    if (u.active) {
      expect(u.pendingName).toBeNull()
      expect(u.pendingPasswordHash).toBeNull()
    } else {
      expect(isPending(u)).toBe(true)
      expect(await verifyPassword(u.pendingPasswordHash!, STRONG)).toBe(true)
    }
  })

  it('records whether the row it re-opened was already pending', async () => {
    await testDb.user.create({
      data: { email: 'd@rcl.com.ph', name: 'D', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'd@rcl.com.ph', name: 'D', password: STRONG })
    await registerUser(testDb, { email: 'd@rcl.com.ph', name: 'D', password: STRONG_TWO })
    const rows = await testDb.auditLog.findMany({ where: { action: 'user_reregistered' }, orderBy: { createdAt: 'asc' } })
    expect(rows.map((r) => (r.details as { wasPending?: boolean }).wasPending)).toEqual([false, true])
  })
})

describe('approveUser', () => {
  it('activates a pending account with the chosen role and records who approved it', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const row = await approveUser(testDb, { userId: pending.id, role: 'FINANCE_ADMIN', actorId: actor.id })
    expect(row).toMatchObject({ id: pending.id, role: 'FINANCE_ADMIN', active: true, pendingSince: null })
    expect(Object.keys(row)).not.toContain('passwordHash')

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_approved' } })
    expect(audit).toMatchObject({ actorType: 'USER', userId: actor.id, remarks: 'p@rcl.com.ph' })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, email: 'p@rcl.com.ph', role: 'FINANCE_ADMIN' })
  })

  it('approving a re-registered account applies the typed name and password, and clears the held ones', async () => {
    const actor = await makeAdmin()
    await deactivatedWithOldPassword()
    await registerUser(testDb, { email: 'ayessa@rcl.com.ph', name: 'Ayessa Morinne', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'ayessa@rcl.com.ph' } })

    const row = await approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: actor.id })
    expect(row).toMatchObject({ name: 'Ayessa Morinne', active: true, pendingSince: null, pendingName: null, hasPendingCredentials: false })

    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(u).toMatchObject({ name: 'Ayessa Morinne', active: true, pendingName: null, pendingPasswordHash: null })
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG_OLD)).toBe(false)

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_approved' } })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, nameChangedFrom: 'Old Name' })
    expect(await auditText()).not.toContain(u.passwordHash)
  })

  it('approving a NEW pending account (nothing held) still works and keeps its password', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'new@rcl.com.ph', name: 'New Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    await approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: actor.id })
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(u).toMatchObject({ name: 'New Person', active: true })
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_approved' } })
    expect(audit.details).not.toHaveProperty('nameChangedFrom')
  })

  it('approving a NEW account registered again while pending applies the second registration', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'First Try', password: STRONG })
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Second Try', password: STRONG_TWO })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    await approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: actor.id })
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(u.name).toBe('Second Try')
    expect(await verifyPassword(u.passwordHash, STRONG_TWO)).toBe(true)
  })

  it('refuses an account that is not pending', async () => {
    const actor = await makeAdmin()
    const deactivated = await makeFinanceUser({ active: false })
    const active = await makeFinanceUser()
    for (const t of [deactivated, active]) {
      await expect(approveUser(testDb, { userId: t.id, role: 'FINANCE_USER', actorId: actor.id }))
        .rejects.toMatchObject({ code: 'NOT_PENDING' })
    }
  })

  it('refuses when the registration was re-done after the page the admin is looking at loaded', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'First', password: STRONG })
    const seen = (await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })).pendingSince!
    await new Promise((r) => setTimeout(r, 15))
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Second', password: STRONG_TWO })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const err = await approveUser(testDb, {
      userId: pending.id, role: 'FINANCE_USER', actorId: actor.id, seenPendingSince: seen,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('REREGISTERED')
    expect(err.message).toBe('First was re-registered after this page loaded. Reload and check the new registration before approving.')
    expect(isPending(await testDb.user.findUniqueOrThrow({ where: { id: pending.id } }))).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_approved' } })).toBe(0)

    // The value the page actually displayed now is accepted.
    const ok = await approveUser(testDb, {
      userId: pending.id, role: 'FINANCE_USER', actorId: actor.id, seenPendingSince: pending.pendingSince!,
    })
    expect(ok.active).toBe(true)
  })
})

describe('rejectUser', () => {
  it('clears the flag and leaves the account deactivated', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })

    const row = await rejectUser(testDb, { userId: pending.id, actorId: actor.id })
    expect(row).toMatchObject({ id: pending.id, active: false, pendingSince: null })

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'user_rejected' } })
    expect(audit).toMatchObject({ actorType: 'USER', userId: actor.id })
    expect(audit.details).toMatchObject({ targetUserId: pending.id, email: 'p@rcl.com.ph' })

    // A rejected account is an ordinary deactivated one: REACTIVATE works on it.
    await setUserActive(testDb, { userId: pending.id, active: true, actorId: actor.id })
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(true)
  })

  it('discards what was typed at a re-registration: name and password intact, then REACTIVATE restores the genuine account', async () => {
    const actor = await makeAdmin()
    await deactivatedWithOldPassword()
    await registerUser(testDb, { email: 'ayessa@rcl.com.ph', name: 'Stranger', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'ayessa@rcl.com.ph' } })

    const row = await rejectUser(testDb, { userId: pending.id, actorId: actor.id })
    expect(row).toMatchObject({ name: 'Old Name', pendingSince: null, pendingName: null, hasPendingCredentials: false })
    const rejected = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(rejected).toMatchObject({ name: 'Old Name', active: false, pendingName: null, pendingPasswordHash: null })
    expect(await verifyPassword(rejected.passwordHash, STRONG_OLD)).toBe(true)
    expect(await verifyPassword(rejected.passwordHash, STRONG)).toBe(false)

    await setUserActive(testDb, { userId: pending.id, active: true, actorId: actor.id })
    const back = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(back).toMatchObject({ active: true, name: 'Old Name', role: 'FINANCE_ADMIN' })
    expect(await verifyPassword(back.passwordHash, STRONG_OLD)).toBe(true)
    expect(await verifyPassword(back.passwordHash, STRONG)).toBe(false)
  })

  it('refuses an account that is not pending', async () => {
    const actor = await makeAdmin()
    const t = await makeFinanceUser({ active: false })
    await expect(rejectUser(testDb, { userId: t.id, actorId: actor.id })).rejects.toMatchObject({ code: 'NOT_PENDING' })
  })
})

describe('a pending account on the existing controls', () => {
  it('cannot be REACTIVATED past the approval step', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await setUserActive(testDb, { userId: pending.id, active: true, actorId: actor.id }).catch((e) => e)
    expect(err).toBeInstanceOf(DomainError)
    expect(err.code).toBe('PENDING')
    expect(err.message).toMatch(/PENDING APPROVAL/)
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(false)
  })

  it('is listed with pendingSince and whether it was previously deactivated', async () => {
    await registerUser(testDb, { email: 'fresh@rcl.com.ph', name: 'Fresh', password: STRONG })
    await testDb.user.create({
      data: { email: 'back@rcl.com.ph', name: 'Was Here', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'back@rcl.com.ph', name: 'Back Again', password: STRONG })
    await makeFinanceUser({ email: 'z.active@rcl.com.ph' })

    const rows = await listUsers(testDb)
    const fresh = rows.find((r) => r.email === 'fresh@rcl.com.ph')!
    const back = rows.find((r) => r.email === 'back@rcl.com.ph')!
    const active = rows.find((r) => r.email === 'z.active@rcl.com.ph')!
    expect(fresh.pendingSince).not.toBeNull()
    expect(fresh.previouslyDeactivated).toBe(false)
    expect(back.pendingSince).not.toBeNull()
    expect(back.previouslyDeactivated).toBe(true)
    expect(active.pendingSince).toBeNull()
    expect(active.previouslyDeactivated).toBe(false)
  })

  it('does not call a pending account "previously deactivated" because it re-registered while pending', async () => {
    await registerUser(testDb, { email: 'twice@rcl.com.ph', name: 'Twice', password: STRONG })
    await registerUser(testDb, { email: 'twice@rcl.com.ph', name: 'Twice', password: STRONG_TWO })
    const row = (await listUsers(testDb)).find((r) => r.email === 'twice@rcl.com.ph')!
    expect(row.previouslyDeactivated).toBe(false)
  })

  it('keeps previouslyDeactivated through a later re-registration while still pending', async () => {
    await testDb.user.create({
      data: { email: 'again@rcl.com.ph', name: 'Was Here', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    await registerUser(testDb, { email: 'again@rcl.com.ph', name: 'Again', password: STRONG })
    await registerUser(testDb, { email: 'again@rcl.com.ph', name: 'Again', password: STRONG_TWO })
    const row = (await listUsers(testDb)).find((r) => r.email === 'again@rcl.com.ph')!
    expect(row.previouslyDeactivated).toBe(true)
  })

  it('deactivating a pending account is a no-op: still pending, no audit row', async () => {
    const actor = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending Person', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const row = await setUserActive(testDb, { userId: pending.id, active: false, actorId: actor.id })
    expect(row.pendingSince).not.toBeNull()
    expect(isPending(await testDb.user.findUniqueOrThrow({ where: { id: pending.id } }))).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_deactivated' } })).toBe(0)
  })
})

describe('writes conditional on the row they read', () => {
  /**
   * Deterministic interleaving: `holder` writes the row inside a transaction
   * that keeps it locked. `call` reads the row (plain SELECT, not blocked by
   * the lock) and then blocks on its conditional write; once Postgres reports
   * a session blocked BY THE HOLDER'S backend, the holder commits, and the
   * write re-evaluates its WHERE against what the holder left.
   */
  async function callWhileHolding<T>(
    holder: (tx: Prisma.TransactionClient) => Promise<unknown>,
    call: () => Promise<T>,
  ): Promise<T | unknown> {
    let outcome: Promise<T | unknown> = Promise.resolve()
    await testDb.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      await holder(tx)
      outcome = call().catch((e) => e)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE pg_blocking_pids(pid) @> ARRAY[${pid}]::int[]`
        if (n > 0n) return
        await new Promise((r) => setTimeout(r, 100))
      }
      throw new Error('the call never blocked on the holder row lock within 10 s')
    }, { timeout: 30000, maxWait: 30000 })
    return outcome
  }

  const reRegistering = (userId: string) => (tx: Prisma.TransactionClient) =>
    tx.user.update({
      where: { id: userId },
      data: { pendingName: 'Re-registered', pendingPasswordHash: 'new-hash', pendingSince: new Date(Date.now() + 1000) },
    })

  it('REACTIVATE refuses a deactivated account that was re-registered between its read and its write', async () => {
    const admin = await makeAdmin()
    const target = await makeFinanceUser({ active: false })
    const err = await callWhileHolding(reRegistering(target.id), () =>
      setUserActive(testDb, { userId: target.id, active: true, actorId: admin.id }))
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('PENDING')
    const u = await testDb.user.findUniqueOrThrow({ where: { id: target.id } })
    expect(u).toMatchObject({ active: false, pendingPasswordHash: 'new-hash' })
    expect(await testDb.auditLog.count({ where: { action: 'user_reactivated' } })).toBe(0)
  })

  it('REACTIVATE of a row an admin already activated meanwhile is a no-op and writes no audit row', async () => {
    const admin = await makeAdmin()
    const target = await makeFinanceUser({ active: false })
    const row = (await callWhileHolding(
      (tx) => tx.user.update({ where: { id: target.id }, data: { active: true } }),
      () => setUserActive(testDb, { userId: target.id, active: true, actorId: admin.id }),
    )) as { active: boolean }
    expect(row.active).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_reactivated' } })).toBe(0)
  })

  it('a registration over a pending account refuses when that account was re-registered between its read and its write', async () => {
    // The audit row's wasPending must be the state the write saw, so the
    // write is conditional on pendingSince as well as active.
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await callWhileHolding(reRegistering(pending.id), () =>
      registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Third', password: STRONG_TWO }))
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('EMAIL_TAKEN')
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(u).toMatchObject({ pendingName: 'Re-registered', pendingPasswordHash: 'new-hash' })
    expect(await testDb.auditLog.count({ where: { action: 'user_reregistered' } })).toBe(0)
  })

  it('APPROVE without seenPendingSince refuses a registration redone between its read and its write', async () => {
    // (With seenPendingSince it is the earlier, deterministic check; the
    // unseen-path interleaving can only be forced with the lock above.)
    const admin = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await callWhileHolding(reRegistering(pending.id), () =>
      approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: admin.id }))
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('REREGISTERED')
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    expect(u.active).toBe(false)
    expect(u.pendingSince).not.toBeNull()
    expect(await testDb.auditLog.count({ where: { action: 'user_approved' } })).toBe(0)
  })

  it('APPROVE of an account another admin rejected meanwhile says it is not waiting, not that it was re-registered', async () => {
    const admin = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await callWhileHolding(
      (tx) => tx.user.update({ where: { id: pending.id }, data: { pendingSince: null } }),
      () => approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: admin.id }),
    )
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('NOT_PENDING')
    expect((err as DomainError).message).toBe('Pending is not waiting for approval.')
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(false)
    expect(await testDb.auditLog.count({ where: { action: 'user_approved' } })).toBe(0)
  })

  it('REJECT refuses a registration redone between its read and its write', async () => {
    const admin = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await callWhileHolding(reRegistering(pending.id), () =>
      rejectUser(testDb, { userId: pending.id, actorId: admin.id }))
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('REREGISTERED')
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).pendingSince).not.toBeNull()
    expect(await testDb.auditLog.count({ where: { action: 'user_rejected' } })).toBe(0)
  })

  it('REJECT of an account another admin approved meanwhile says it is not waiting, and does not touch it', async () => {
    const admin = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const err = await callWhileHolding(
      (tx) => tx.user.update({ where: { id: pending.id }, data: { active: true, pendingSince: null } }),
      () => rejectUser(testDb, { userId: pending.id, actorId: admin.id }),
    )
    expect(err).toBeInstanceOf(DomainError)
    expect((err as DomainError).code).toBe('NOT_PENDING')
    expect((await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })).active).toBe(true)
    expect(await testDb.auditLog.count({ where: { action: 'user_rejected' } })).toBe(0)
  })

  it('a registration racing an approval never leaves an active account with the new password and no approval', async () => {
    // Property test over a real race, as for registerUser above.
    const admin = await makeAdmin()
    await registerUser(testDb, { email: 'p@rcl.com.ph', name: 'Pending', password: STRONG })
    const pending = await testDb.user.findUniqueOrThrow({ where: { email: 'p@rcl.com.ph' } })
    const seen = pending.pendingSince!
    await new Promise((r) => setTimeout(r, 15))
    await Promise.allSettled([
      registerUser(testDb, { email: 'p@rcl.com.ph', name: 'New', password: STRONG_TWO }),
      approveUser(testDb, { userId: pending.id, role: 'FINANCE_USER', actorId: admin.id, seenPendingSince: seen }),
    ])
    const u = await testDb.user.findUniqueOrThrow({ where: { id: pending.id } })
    if (u.active) {
      // Approved the registration the admin saw; the later one never got in.
      expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
      expect(u.pendingSince).toBeNull()
      expect(u.pendingPasswordHash).toBeNull()
    } else {
      expect(isPending(u)).toBe(true)
      expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
      expect(await verifyPassword(u.pendingPasswordHash!, STRONG_TWO)).toBe(true)
    }
  })
})
