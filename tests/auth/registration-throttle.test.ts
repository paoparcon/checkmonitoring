import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { RETENTION_DAYS, UNKNOWN_IP } from '@/lib/login-throttle'
import {
  REGISTRATION_WINDOW_MINUTES,
  pruneRegistrationAttempts, recordRegistrationAttempt,
} from '@/lib/registration-throttle'

beforeEach(resetDb)

const NOW = new Date('2026-10-09T08:00:00.000Z')
const minutesBefore = (n: number) => new Date(NOW.getTime() - n * 60_000)
const IP = '203.0.113.9'
const LIMIT = 5

async function attempt(o: { ip?: string; email?: string; at?: Date } = {}) {
  return testDb.registrationAttempt.create({
    data: { ip: o.ip ?? IP, email: o.email ?? 'someone@example.com', createdAt: o.at ?? minutesBefore(1) },
  })
}

describe('recordRegistrationAttempt', () => {
  it('writes the row and prunes rows past retention in the same call', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })
    const rows = await testDb.registrationAttempt.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ip: IP, email: 'new@example.com', createdAt: NOW })
  })

  it('counts its own row when there is nothing else', async () => {
    expect(await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).toEqual({ recent: 1 })
  })

  it('counts the row it just wrote: N prior rows in the window give N + 1', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt()
    expect(await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).toEqual({ recent: LIMIT + 1 })
  })

  it('does not count submissions older than the hour', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ at: minutesBefore(REGISTRATION_WINDOW_MINUTES + 1) })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(1)
  })

  it('counts only the asking address', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: '198.51.100.7' })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(1)
  })

  it('counts a row exactly 60 minutes old and not one 1 ms older', async () => {
    await attempt({ at: minutesBefore(REGISTRATION_WINDOW_MINUTES) })
    await attempt({ at: new Date(NOW.getTime() - REGISTRATION_WINDOW_MINUTES * 60_000 - 1) })
    expect((await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })).recent).toBe(2)
  })

  // The shared bucket over-throttles rather than under-throttles. Deliberate.
  it('counts the unknown-address bucket like any other', async () => {
    for (let i = 0; i < LIMIT; i++) await attempt({ ip: UNKNOWN_IP })
    expect((await recordRegistrationAttempt(testDb, { ip: UNKNOWN_IP, email: 'new@example.com', now: NOW })).recent).toBe(LIMIT + 1)
  })

  // Prisma's interactive transactions run READ COMMITTED: without serialising, N parallel
  // inserts each count only the rows already committed and all of them can pass the limit.
  // The advisory lock on the address makes the count exact: 1..N, each value once.
  it('serialises parallel submissions from one address: the counts are exactly 1..N', async () => {
    const N = 6
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        recordRegistrationAttempt(testDb, { ip: IP, email: `p${i}@example.com`, now: NOW })),
    )
    expect(results.map((r) => r.recent).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6])
    expect(await testDb.registrationAttempt.count()).toBe(N)
  })

  it('counts each address separately', async () => {
    const results = await Promise.all(
      ['198.51.100.1', '198.51.100.2', '198.51.100.3'].map((ip) =>
        recordRegistrationAttempt(testDb, { ip, email: 'x@example.com', now: NOW })),
    )
    expect(results.map((r) => r.recent)).toEqual([1, 1, 1])
  })

  it('keeps a recent row through the prune and deletes one past retention', async () => {
    await attempt({ at: minutesBefore(5) })
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await recordRegistrationAttempt(testDb, { ip: IP, email: 'new@example.com', now: NOW })
    expect(await testDb.registrationAttempt.count()).toBe(2)
  })
})

describe('recordRegistrationAttempt under a held lock', () => {
  it('gives up on the lock within the lock timeout instead of queueing to the transaction deadline', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let locked!: () => void
    const lockTaken = new Promise<void>((r) => { locked = r })
    const holder = testDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${IP}))`
      locked()
      await held
    }, { timeout: 20_000 })
    await lockTaken
    const started = Date.now()
    try {
      await expect(
        recordRegistrationAttempt(testDb, { ip: IP, email: 'queued@example.com', now: NOW }),
      ).rejects.toThrow(/lock timeout|55P03/i)
      expect(Date.now() - started).toBeLessThan(8_000)
    } finally {
      release()
      await holder
    }
    expect(await testDb.registrationAttempt.count()).toBe(0)
  }, 15_000)
})

describe('pruneRegistrationAttempts', () => {
  it('drops only rows past retention and says how many', async () => {
    await attempt({ at: new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 24 * 60 * 60_000) })
    await attempt({ at: minutesBefore(5) })
    expect(await pruneRegistrationAttempts(testDb, { now: NOW })).toBe(1)
    expect(await testDb.registrationAttempt.count()).toBe(1)
  })
})
