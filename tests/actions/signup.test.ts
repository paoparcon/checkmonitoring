import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { verifyPassword } from '@/lib/password'

// The request headers the action reads the client address from. Mutable so
// one file can play two addresses.
const requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.9' })

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }))

const STRONG = 'Zq7!vantablack-Ledger'

const fd = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
const good = (over: Record<string, string> = {}) =>
  fd({ name: 'New Person', email: 'new@rcl.com.ph', password: STRONG, confirm: STRONG, ...over })

beforeEach(async () => {
  await resetDb()
  requestHeaders.set('x-forwarded-for', '203.0.113.9')
})

describe('registerAction', () => {
  it('creates a pending account and reports the address only', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good())
    expect(result).toEqual({ ok: true, email: 'new@rcl.com.ph' })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(u.active).toBe(false)
    expect(u.pendingSince).not.toBeNull()
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(STRONG)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses mismatched passwords before touching the database', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ confirm: 'Different-1!Password' }))
    expect(result).toEqual({ ok: false, message: 'The two passwords do not match.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(0)
  })

  it('does not trim the password', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const spaced = ` ${STRONG} `
    expect((await registerAction(good({ password: spaced, confirm: spaced }))).ok).toBe(true)
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(await verifyPassword(u.passwordHash, spaced)).toBe(true)
    expect(await verifyPassword(u.passwordHash, STRONG)).toBe(false)
  })

  it('passes a domain refusal through in its own words, and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ password: 'short', confirm: 'short' }))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toMatch(/at least 12 characters/)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })

  it('refuses an address past its hourly allowance and still records the attempt', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const now = new Date()
    for (let i = 0; i < 5; i++) {
      await testDb.registrationAttempt.create({ data: { ip: '203.0.113.9', email: `bot${i}@x.com`, createdAt: now } })
    }
    const result = await registerAction(good())
    expect(result).toEqual({ ok: false, message: 'Too many accounts have been created from this connection. Try again later.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(6)

    // Another address is unaffected.
    requestHeaders.set('x-forwarded-for', '198.51.100.7')
    expect((await registerAction(good())).ok).toBe(true)
  })

  it('honours the allowance setting', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    await testDb.setting.create({ data: { key: 'signup.ipPerHour', value: '1' } })
    expect((await registerAction(good())).ok).toBe(true)
    expect(await registerAction(good({ email: 'second@rcl.com.ph' }))).toEqual({
      ok: false,
      message: 'Too many accounts have been created from this connection. Try again later.',
    })
  })

  // Insert-then-count in one transaction, serialised per address by an advisory lock: each
  // submission counts its own row and the count is exact, so exactly one of two parallel
  // submissions is within an allowance of 1.
  it('lets exactly one of two parallel submissions through when the allowance is 1', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    await testDb.setting.create({ data: { key: 'signup.ipPerHour', value: '1' } })
    const results = await Promise.all([
      registerAction(good({ email: 'one@rcl.com.ph' })),
      registerAction(good({ email: 'two@rcl.com.ph' })),
    ])
    expect(results.filter((r) => r.ok).length).toBe(1)
    expect(await testDb.registrationAttempt.count()).toBe(2)
  })

  it('stores the name trimmed and the address trimmed and lowercased, and records the normalised address', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good({ name: '  New Person  ', email: '  New@RCL.com.ph ' }))
    expect(result).toEqual({ ok: true, email: 'new@rcl.com.ph' })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'new@rcl.com.ph' } })
    expect(u.name).toBe('New Person')
    const attempt = await testDb.registrationAttempt.findFirstOrThrow()
    expect(attempt.email).toBe('new@rcl.com.ph')
  })

  it('lets a deactivated account register again: still inactive, pending, the typed name held aside', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    await testDb.user.create({
      data: { email: 'gone@rcl.com.ph', name: 'Old Name', passwordHash: 'x', role: 'FINANCE_USER', active: false },
    })
    const result = await registerAction(good({ email: 'gone@rcl.com.ph', name: 'Fresh Name' }))
    expect(result).toEqual({ ok: true, email: 'gone@rcl.com.ph' })
    const u = await testDb.user.findUniqueOrThrow({ where: { email: 'gone@rcl.com.ph' } })
    expect(u.active).toBe(false)
    expect(u.pendingSince).not.toBeNull()
    // Nothing on the existing row changes until an admin approves.
    expect(u.name).toBe('Old Name')
    expect(u.passwordHash).toBe('x')
    expect(u.pendingName).toBe('Fresh Name')
    expect(await verifyPassword(u.pendingPasswordHash!, STRONG)).toBe(true)
  })

  it.each([
    ['email', { email: 'a'.repeat(244) + '@rcl.com.ph' }],
    ['name', { name: 'n'.repeat(201) }],
    ['password', { password: 'p'.repeat(1025), confirm: 'p'.repeat(1025) }],
  ])('refuses an over-long %s before any database work and records nothing', async (_field, over) => {
    const { registerAction } = await import('@/app/signup/actions')
    const result = await registerAction(good(over))
    expect(result).toEqual({ ok: false, message: 'That entry is too long.' })
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count()).toBe(0)
  })

  it('accepts entries exactly at the caps', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const email = 'a'.repeat(254 - '@rcl.com.ph'.length) + '@rcl.com.ph'
    expect(email.length).toBe(254)
    const result = await registerAction(good({ email, name: 'n'.repeat(200) }))
    expect(result).toEqual({ ok: true, email })
  })

  it('refuses, and creates nothing, when the attempt cannot be recorded (the throttle fails closed)', async () => {
    const { registerAction } = await import('@/app/signup/actions')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => { locked = r })
    // Hold the address's advisory lock past the 3 s lock timeout.
    const holder = testDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'203.0.113.9'}))`
      locked()
      await held
    }, { timeout: 20_000 })
    await lockTaken
    try {
      const result = await registerAction(good())
      expect(result).toEqual({ ok: false, message: 'Could not register right now. Try again in a minute.' })
    } finally {
      release()
      await holder
      err.mockRestore()
    }
    expect(await testDb.user.count()).toBe(0)
    expect(await testDb.registrationAttempt.count({ where: { ip: '203.0.113.9' } })).toBe(0)
  }, 15_000)
})
