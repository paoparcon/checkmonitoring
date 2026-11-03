# Auto-sign on Monday and Tuesday Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-sign signs, on a Manila Monday, every due check first read before that Monday, and on a Manila Tuesday, every due check first read before that Tuesday — so Monday's checks sign on Tuesday and the rest on the next Monday.

**Architecture:** The pure rule in `lib/domain/auto-sign.ts` swaps its Tuesday-only, Monday-window test for a run day (Monday or Tuesday) and a cutoff (00:00 Manila on the run's day) with no lower bound. The cron step `lib/sync/auto-sign.ts` lists and signs by that cutoff and words its time-out message per run. `autoSign` in `lib/domain/actions.ts` records the new rule on each `auto_signed` row. The rest is text: the setting, `/admin/sync`, comments and `CLAUDE.md`.

**Tech Stack:** Next.js 15, Prisma 6, PostgreSQL (Neon), Vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-16-auto-sign-monday-and-tuesday-design.md`

## Global Constraints

- Work in the worktree `C:\Users\User\Desktop\RCL PROJECTS\cm-auto-sign-weekly`, branch `feature/auto-sign-weekly`. Never in the main checkout `Check Monitoring` — other sessions use it.
- Commands run from the Bash tool (Git Bash), from the worktree:
  - regenerate the shared Prisma client first: `node node_modules/prisma/build/index.js generate`
  - tests: `node node_modules/vitest/vitest.mjs run <files>`
  - types: `node node_modules/typescript/bin/tsc --noEmit` — required before claiming done; Vitest erases types.
- The test database is shared by every session. Run only the files named in each task, never the whole suite, and never two runs at once.
- The Manila day is UTC+8 with no daylight saving. Fixed dates used throughout: Monday 12 Oct 2026 00:00 Manila = `2026-10-11T16:00:00Z`; Monday 12:00 = `2026-10-12T04:00:00Z`; Monday 18:00 = `2026-10-12T10:00:00Z`; Tuesday 13 Oct 00:00 = `2026-10-12T16:00:00Z`; Tuesday 12:00 = `2026-10-13T04:00:00Z`; Tuesday 18:00 = `2026-10-13T10:00:00Z`; Wednesday 14 Oct 12:00 = `2026-10-14T04:00:00Z`.
- The setting key stays `autoSign.mondayEnabled`. No migration.
- An `auto_signed` row written by this code has `details.rule = 'WEEKLY'` and `details.runDay = 'MONDAY' | 'TUESDAY'`. Old rows keep `'MONDAY'`; nothing rewrites them.
- Leftover message endings, verbatim: `the 18:00 run continues`, `Tuesday's run continues`, `next Monday's run continues`.
- Spell "check", not "cheque", in every new string and comment.
- End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: The pure rule — run day and cutoff

**Files:**
- Modify: `lib/domain/auto-sign.ts` (whole file)
- Test: `tests/domain/auto-sign.test.ts` (whole file)

**Interfaces:**
- Produces: `export type AutoSignRunDay = 'MONDAY' | 'TUESDAY'`; `export function autoSignRunDay(now: Date): AutoSignRunDay | null`; `export function signingCutoff(now: Date): Date` (00:00 Manila on `now`'s Manila day); `isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean` (same signature). Removes `isManilaTuesday` and `mondayWindow` — Task 2 replaces their only other user, `lib/sync/auto-sign.ts`.

- [ ] **Step 1: Write the failing test** — replace `tests/domain/auto-sign.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { autoSignRunDay, isDueForAutoSign, signingCutoff, type AutoSignFacts } from '@/lib/domain/auto-sign'

// Monday 12 Oct 2026 and Tuesday 13 Oct 2026, Manila (UTC+8).
const mondayStart = new Date('2026-10-11T16:00:00Z')   // Mon 00:00 Manila
const mondayNoon = new Date('2026-10-12T04:00:00Z')    // Mon 12:00 Manila
const tuesdayStart = new Date('2026-10-12T16:00:00Z')  // Tue 00:00 Manila
const tuesdayNoon = new Date('2026-10-13T04:00:00Z')   // Tue 12:00 Manila
const wednesdayStart = new Date('2026-10-13T16:00:00Z') // Wed 00:00 Manila

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date('2026-10-08T02:00:00Z'), reverted: false, ...o,
})

describe('autoSignRunDay', () => {
  it('is the Manila calendar day, not UTC', () => {
    expect(autoSignRunDay(new Date(mondayStart.getTime() - 1))).toBeNull()   // Sun 23:59:59.999 Manila
    expect(autoSignRunDay(mondayStart)).toBe('MONDAY')                       // Mon 00:00 Manila = Sun 16:00 UTC
    expect(autoSignRunDay(mondayNoon)).toBe('MONDAY')
    expect(autoSignRunDay(new Date(tuesdayStart.getTime() - 1))).toBe('MONDAY')
    expect(autoSignRunDay(tuesdayStart)).toBe('TUESDAY')
    expect(autoSignRunDay(new Date(wednesdayStart.getTime() - 1))).toBe('TUESDAY')
    expect(autoSignRunDay(wednesdayStart)).toBeNull()
  })

  it('is null Wednesday to Sunday', () => {
    for (const iso of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z', '2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z']) {
      expect(autoSignRunDay(new Date(iso)), iso).toBeNull()
    }
  })
})

describe('signingCutoff', () => {
  it('is 00:00 Manila on now’s day', () => {
    expect(signingCutoff(mondayNoon)).toEqual(mondayStart)
    expect(signingCutoff(mondayStart)).toEqual(mondayStart)
    expect(signingCutoff(tuesdayNoon)).toEqual(tuesdayStart)
    expect(signingCutoff(new Date(wednesdayStart.getTime() - 1))).toEqual(tuesdayStart)
  })
})

describe('isDueForAutoSign', () => {
  it('Monday’s run signs a check first read up to Sunday 23:59:59.999 Manila, not Monday’s own', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date(mondayStart.getTime() - 1) }), mondayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), mondayNoon, true)).toBe(false)
  })

  it('Tuesday’s run signs a check first read up to Monday 23:59:59.999 Manila, not Tuesday’s own', () => {
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: new Date(tuesdayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: tuesdayStart }), tuesdayNoon, true)).toBe(false)
  })

  it('signs the old backlog on both days', () => {
    const backlog = pending({ createdAt: new Date('2026-09-29T02:00:00Z') })
    expect(isDueForAutoSign(backlog, mondayNoon, true)).toBe(true)
    expect(isDueForAutoSign(backlog, tuesdayNoon, true)).toBe(true)
  })

  it('signs nothing Wednesday to Sunday', () => {
    for (const iso of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z', '2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z']) {
      expect(isDueForAutoSign(pending(), new Date(iso), true), iso).toBe(false)
    }
  })

  it('signs nothing when switched off', () => {
    expect(isDueForAutoSign(pending(), mondayNoon, false)).toBe(false)
  })

  it('never re-signs a check someone reverted', () => {
    expect(isDueForAutoSign(pending({ reverted: true }), mondayNoon, true)).toBe(false)
  })

  it('accepts a null Acumatica status', () => {
    expect(isDueForAutoSign(pending({ acumaticaStatus: null }), mondayNoon, true)).toBe(true)
  })

  it('refuses other statuses, register-only, non-checks and Voided', () => {
    for (const status of ['GENERATED', 'SIGNED', 'READY_FOR_RELEASE', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(isDueForAutoSign(pending({ status }), mondayNoon, true), status).toBe(false)
    }
    expect(isDueForAutoSign(pending({ acumaticaPaymentId: null }), mondayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ isCheque: false }), mondayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ acumaticaStatus: 'Voided' }), mondayNoon, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/prisma/build/index.js generate && node node_modules/vitest/vitest.mjs run tests/domain/auto-sign.test.ts`
Expected: FAIL — `autoSignRunDay` / `signingCutoff` are not exported (`is not a function`).

- [ ] **Step 3: Write minimal implementation** — replace `lib/domain/auto-sign.ts` with:

```ts
/**
 * AUTO-SIGN, THE RULE. User request 2026-10-16, replacing the 2026-10-01
 * "Monday's checks on Tuesday, the rest by SIGN ALL": "Monday - it will be
 * signed on tuesday. The rest of the day, will be signed on Monday." Spec
 * `2026-10-16-auto-sign-monday-and-tuesday-design.md`.
 *
 * Runs on a Manila MONDAY and a Manila TUESDAY. Each run signs every due check
 * first read before 00:00 Manila on the run's own day, with no lower bound: on
 * Monday that is last Tuesday to Sunday and any older backlog (user ruling
 * 2026-10-16); on Tuesday it is Monday's checks and anything Monday's runs did
 * not reach. Wednesday to Sunday sign nothing.
 *
 * "First read" is `createdAt` — when the sync first brought the check in —
 * because Acumatica publishes no creation timestamp and its one date,
 * PaymentDate, is post-dated on some checks.
 *
 * A check a person reverted (`signature_reverted`) is never signed by the
 * clock again: the next run would otherwise quietly undo the revert.
 *
 * The Philippines is UTC+8 with no daylight saving, so a fixed offset is
 * exact. Pure. No database, no clock: the caller passes `now`.
 */

export const AUTO_SIGNED_ACTION = 'auto_signed'
export const AUTO_SIGN_RUN_ACTION = 'auto_sign_run'
/** A person undid a signature. A check carrying one is never auto-signed again. */
export const SIGNATURE_REVERTED_ACTION = 'signature_reverted'

export type AutoSignRunDay = 'MONDAY' | 'TUESDAY'

const DAY_MS = 86_400_000
const MANILA_OFFSET_MS = 8 * 3_600_000
/** 1970-01-01 was a Thursday; with Sunday = 0 that is weekday 4. */
const EPOCH_WEEKDAY = 4
const MONDAY = 1
const TUESDAY = 2

export type AutoSignFacts = {
  status: string
  acumaticaPaymentId: string | null
  isCheque: boolean
  acumaticaStatus: string | null
  createdAt: Date
  /** Carries a `signature_reverted` audit row. */
  reverted: boolean
}

/** The Manila calendar day index (days since the epoch, in UTC+8) an instant falls on. */
function dayIndex(t: number): number {
  return Math.floor((t + MANILA_OFFSET_MS) / DAY_MS)
}

/** The UTC instant at which Manila day `index` begins. */
function dayStart(index: number): Date {
  return new Date(index * DAY_MS - MANILA_OFFSET_MS)
}

/** Which auto-sign run `now` falls on, by the Manila day; null Wednesday to Sunday. */
export function autoSignRunDay(now: Date): AutoSignRunDay | null {
  const weekday = (dayIndex(now.getTime()) + EPOCH_WEEKDAY) % 7
  if (weekday === MONDAY) return 'MONDAY'
  if (weekday === TUESDAY) return 'TUESDAY'
  return null
}

/** 00:00 Manila on `now`'s Manila day. A run signs checks first read before it. */
export function signingCutoff(now: Date): Date {
  return dayStart(dayIndex(now.getTime()))
}

export function isDueForAutoSign(c: AutoSignFacts, now: Date, enabled: boolean): boolean {
  if (!enabled) return false
  if (autoSignRunDay(now) === null) return false
  if (c.status !== 'SIGNATURE_PENDING') return false
  // Only what Acumatica generated. A register-only check waits for a person.
  if (c.acumaticaPaymentId === null) return false
  // DEBIT ADV and CASH are never signed by anyone.
  if (!c.isCheque) return false
  // A voided payment is the sync's or a person's to settle, not the clock's.
  if (c.acumaticaStatus === 'Voided') return false
  if (c.reverted) return false
  return c.createdAt.getTime() < signingCutoff(now).getTime()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/auto-sign.test.ts`
Expected: PASS, 11 tests. (`tsc` fails until Task 2: `lib/sync/auto-sign.ts` still imports the removed names.)

- [ ] **Step 5: Do not commit yet** — Task 2 Step 6 commits Tasks 1 and 2 together, because the build is broken between them.

---

### Task 2: The run, its leftovers and its audit row

**Files:**
- Modify: `lib/sync/auto-sign.ts:1-100` (imports, header comment, `LAST_RUN_UTC_HOUR` comment, `leftoverFate`, `listAutoSignCandidates`, `runAutoSign`'s day test)
- Modify: `lib/domain/actions.ts:1-23` (import) and `:202-226` (`autoSign`)
- Modify: `app/api/cron/sync/route.ts:62-66` (header comment)
- Test: `tests/sync/auto-sign.test.ts` (whole file), `tests/actions/auto-sign.test.ts` (two cases), `tests/sync/cron-route.test.ts` (one new describe)

**Interfaces:**
- Consumes: `autoSignRunDay`, `signingCutoff`, `AutoSignRunDay`, `isDueForAutoSign`, `AUTO_SIGN_RUN_ACTION`, `AUTO_SIGNED_ACTION`, `SIGNATURE_REVERTED_ACTION` from Task 1.
- Produces: unchanged signatures — `listAutoSignCandidates(db, now): Promise<AutoSignCandidate[]>`, `runAutoSign(db, { now, deadline? }): Promise<AutoSignRun>`, `getLastAutoSign(db)`, `LAST_RUN_UTC_HOUR = 10`, `autoSign(db, { checkId, now }): Promise<Check | null>`. New `auto_signed` details: `{ from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'WEEKLY', runDay: AutoSignRunDay, inAppSince: string }`.

- [ ] **Step 1: Write the failing tests**

(a) Replace `tests/sync/auto-sign.test.ts` with:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck, makeUser } from '../helpers/factory'
import { runAutoSign, listAutoSignCandidates, getLastAutoSign } from '@/lib/sync/auto-sign'
import { AUTO_SIGN_RUN_ACTION } from '@/lib/domain/auto-sign'
import { markSigned, revertSignature } from '@/lib/domain/actions'

// Monday 12 Oct 2026 and Tuesday 13 Oct 2026, Manila (UTC+8).
const mondayNoon = new Date('2026-10-12T04:00:00Z')
const mondayEvening = new Date('2026-10-12T10:00:00Z')   // 18:00 Manila, the day's last run
const tuesdayNoon = new Date('2026-10-13T04:00:00Z')
const tuesdayEvening = new Date('2026-10-13T10:00:00Z')
const wednesdayNoon = new Date('2026-10-14T04:00:00Z')

const backlog = new Date('2026-09-29T02:00:00Z')         // Tue 29 Sep, the old backlog
const lastThursday = new Date('2026-10-08T02:00:00Z')    // Thu 8 Oct
const sundayLast = new Date('2026-10-11T15:59:59Z')      // Sun 23:59:59 Manila
const mondayFirst = new Date('2026-10-11T16:00:00Z')     // Mon 00:00 Manila
const mondayLate = new Date('2026-10-12T15:59:59Z')      // Mon 23:59:59 Manila
const tuesdayFirst = new Date('2026-10-12T16:00:00Z')    // Tue 00:00 Manila

async function pendingAt(createdAt: Date, o: { acumatica?: boolean; acumaticaStatus?: string | null } = {}) {
  const c = await makeCheck({ status: 'SIGNATURE_PENDING' })
  return testDb.check.update({
    where: { id: c.id },
    data: {
      acumaticaPaymentId: o.acumatica === false ? null : `PAY-${c.id}`,
      acumaticaStatus: o.acumaticaStatus === undefined ? 'Balanced' : o.acumaticaStatus,
      createdAt,
    },
  })
}

beforeEach(resetDb)

describe('listAutoSignCandidates', () => {
  it('on a Monday lists every Acumatica check first read before that Monday, oldest first', async () => {
    const old = await pendingAt(backlog)
    const thu = await pendingAt(lastThursday)
    const sun = await pendingAt(sundayLast, { acumaticaStatus: null })
    await pendingAt(mondayFirst)                                   // Monday's own: waits for Tuesday
    await pendingAt(lastThursday, { acumaticaStatus: 'Voided' })
    await pendingAt(lastThursday, { acumatica: false })
    const ids = (await listAutoSignCandidates(testDb, mondayNoon)).map((c) => c.id)
    expect(ids).toEqual([old.id, thu.id, sun.id])
  })

  it('on a Tuesday lists Monday’s checks and any leftover, not Tuesday’s', async () => {
    const leftover = await pendingAt(lastThursday)
    const mon = await pendingAt(mondayFirst)
    const monLate = await pendingAt(mondayLate)
    await pendingAt(tuesdayFirst)
    const ids = (await listAutoSignCandidates(testDb, tuesdayNoon)).map((c) => c.id)
    expect(ids).toEqual([leftover.id, mon.id, monLate.id])
  })

  it('leaves out a reverted check', async () => {
    const u = await makeUser()
    const c = await pendingAt(lastThursday)
    await markSigned(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T03:00:00Z') })
    await revertSignature(testDb, { checkId: c.id, userId: u.id, now: new Date('2026-10-08T04:00:00Z') })
    expect(await listAutoSignCandidates(testDb, mondayNoon)).toEqual([])
  })

  it('lists nothing Wednesday to Sunday', async () => {
    await pendingAt(lastThursday)
    expect(await listAutoSignCandidates(testDb, wednesdayNoon)).toEqual([])
  })
})

describe('runAutoSign', () => {
  it('signs last week’s and older checks on Monday, leaves Monday’s, and records one run row', async () => {
    const old = await pendingAt(backlog)
    const thu = await pendingAt(lastThursday)
    const mon = await pendingAt(mondayFirst)

    const run = await runAutoSign(testDb, { now: mondayNoon })
    expect(run).toEqual({ outcome: 'OK', signed: 2, skipped: 0, enabled: true })
    const after = await testDb.check.findMany({ where: { id: { in: [old.id, thu.id, mon.id] } }, select: { id: true, status: true } })
    expect(Object.fromEntries(after.map((r) => [r.id, r.status]))).toEqual({
      [old.id]: 'SIGNED', [thu.id]: 'SIGNED', [mon.id]: 'SIGNATURE_PENDING',
    })
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ checkId: null, actorType: 'SYSTEM' })
    expect(rows[0].details).toMatchObject({ outcome: 'OK', signed: 2, enabled: true })
  })

  it('signs Monday’s checks on Tuesday and leaves Tuesday’s', async () => {
    const mon = await pendingAt(mondayFirst)
    const tue = await pendingAt(tuesdayFirst)
    expect(await runAutoSign(testDb, { now: tuesdayNoon })).toEqual({ outcome: 'OK', signed: 1, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: mon.id } })).status).toBe('SIGNED')
    expect((await testDb.check.findUniqueOrThrow({ where: { id: tue.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is IDLE on a Wednesday and signs nothing', async () => {
    const c = await pendingAt(lastThursday)
    expect(await runAutoSign(testDb, { now: wednesdayNoon })).toEqual({ outcome: 'IDLE', signed: 0, skipped: 0, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
  })

  it('is DISABLED when the setting is 0', async () => {
    await testDb.setting.create({ data: { key: 'autoSign.mondayEnabled', value: '0' } })
    const c = await pendingAt(lastThursday)
    expect(await runAutoSign(testDb, { now: mondayNoon })).toEqual({ outcome: 'DISABLED', signed: 0, skipped: 0, enabled: false })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    expect((await getLastAutoSign(testDb))?.outcome).toBe('DISABLED')
  })

  it.each([
    ['Monday 12:00', mondayNoon, 'the 18:00 run continues'],
    ['Monday 18:00', mondayEvening, "Tuesday's run continues"],
    ['Tuesday 12:00', tuesdayNoon, 'the 18:00 run continues'],
    ['Tuesday 18:00', tuesdayEvening, "next Monday's run continues"],
  ] as const)('stops at the deadline on %s as FAILED, naming the run that continues', async (_label, now, fate) => {
    const c = await pendingAt(lastThursday)
    const run = await runAutoSign(testDb, { now, deadline: new Date(0) })
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0 })
    expect(run.error).toBe(`time budget reached with 1 check(s) still due; ${fate}`)
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNATURE_PENDING')
    const rows = await testDb.auditLog.findMany({ where: { action: AUTO_SIGN_RUN_ACTION } })
    expect(rows).toHaveLength(1)
    expect(rows[0].details).toMatchObject({ outcome: 'FAILED' })
  })

  it('records FAILED and returns rather than throwing', async () => {
    await pendingAt(lastThursday)
    const spy = vi.spyOn(testDb.check, 'findMany').mockRejectedValueOnce(new Error('neon went away'))
    const run = await runAutoSign(testDb, { now: mondayNoon })
    spy.mockRestore()
    expect(run).toMatchObject({ outcome: 'FAILED', signed: 0, error: 'neon went away' })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'FAILED', error: 'neon went away' })
  })

  it('getLastAutoSign is null before any run', async () => {
    expect(await getLastAutoSign(testDb)).toBeNull()
  })

  it('skips a check deleted between listing and signing instead of failing the whole run', async () => {
    // `a` is older, so it is visited first; deleting it inside the first
    // $transaction makes autoSign's own load() throw the real NOT_FOUND.
    const a = await pendingAt(backlog)
    const b = await pendingAt(lastThursday)
    const real = testDb.$transaction.bind(testDb)
    const spy = vi.spyOn(testDb, '$transaction').mockImplementationOnce((async (fn: any, opts: any) => {
      await testDb.check.delete({ where: { id: a.id } })
      return real(fn, opts)
    }) as any)
    const run = await runAutoSign(testDb, { now: mondayNoon })
    spy.mockRestore()
    expect(run).toEqual({ outcome: 'OK', signed: 1, skipped: 1, enabled: true })
    expect((await testDb.check.findUnique({ where: { id: b.id } }))?.status).toBe('SIGNED')
    expect(await testDb.check.findUnique({ where: { id: a.id } })).toBeNull()
  })
})

describe('getLastAutoSign', () => {
  it('reads back the newest run, with enabled', async () => {
    await runAutoSign(testDb, { now: wednesdayNoon })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'IDLE', enabled: true, legacyDays: null })
  })

  it('reads a run recorded under the old days rule as legacy', async () => {
    await testDb.auditLog.create({
      data: { actorType: 'SYSTEM', action: AUTO_SIGN_RUN_ACTION, details: { outcome: 'OK', signed: 2, skipped: 0, days: 3 } },
    })
    expect(await getLastAutoSign(testDb)).toMatchObject({ outcome: 'OK', signed: 2, enabled: null, legacyDays: 3 })
  })
})
```

(b) In `tests/actions/auto-sign.test.ts`, replace the first case (`'signs a Monday check at Tuesday’s run, no signing user, one SYSTEM row'`) with these two cases:

```ts
  it('signs a Monday check at Tuesday’s run, no signing user, one SYSTEM row', async () => {
    const c = await acumaticaPending(mondayMorning)
    const signed = await autoSign(testDb, { checkId: c.id, now: tuesdayNoon })
    expect(signed).toMatchObject({ status: 'SIGNED', signedById: null })
    expect(signed!.signedAt!.toISOString()).toBe(tuesdayNoon.toISOString())
    const audit = await testDb.auditLog.findMany({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actorType: 'SYSTEM', userId: null })
    expect(audit[0].details).toMatchObject({
      from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'WEEKLY', runDay: 'TUESDAY', inAppSince: c.createdAt.toISOString(),
    })
    expect(audit[0].remarks).toBe(
      `Signed automatically at Tuesday's run: this Acumatica check first reached the app on ` +
      `${c.createdAt.toISOString()}, before that Tuesday. No one signed it here, so no signing user is recorded.`,
    )
  })

  it('signs last Thursday’s check at the next Monday’s run', async () => {
    const c = await acumaticaPending(new Date('2026-09-24T02:00:00Z'))   // Thu 24 Sep
    const mondayNoon = new Date('2026-09-28T04:00:00Z')                 // Mon 28 Sep 12:00 Manila
    expect(await autoSign(testDb, { checkId: c.id, now: mondayNoon })).toMatchObject({ status: 'SIGNED' })
    const audit = await testDb.auditLog.findFirstOrThrow({ where: { checkId: c.id, action: AUTO_SIGNED_ACTION } })
    expect(audit.details).toMatchObject({ rule: 'WEEKLY', runDay: 'MONDAY' })
    expect(audit.remarks).toContain("Signed automatically at Monday's run")
    expect(audit.remarks).toContain('before that Monday.')
  })
```

The file's other cases stay as they are: Tuesday 29 Sep 2026 is still a run day, `mondayMorning` (Mon 28 Sep) is still before its cutoff, and the Tuesday and Wednesday cases still sign nothing.

(c) In `tests/sync/cron-route.test.ts`, add this describe immediately after the existing `describe('GET /api/cron/sync — auto-sign after the syncs', …)` block (it reuses that file's `watermarked`, `get`, `SECRET` and `testDb`):

```ts
describe('GET /api/cron/sync — auto-sign on a Monday', () => {
  // Monday 12 Oct 2026, 12:00 Manila. Only Date is faked so DB timers stay real.
  beforeEach(() => { vi.useFakeTimers({ now: new Date('2026-10-12T04:00:00Z'), toFake: ['Date'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('signs last week’s check', async () => {
    await watermarked('GOLIVE'); await watermarked('MANUFACTURING')
    const { makeCheck } = await import('../helpers/factory')
    const made = await makeCheck({ status: 'SIGNATURE_PENDING' })
    const c = await testDb.check.update({
      where: { id: made.id },
      data: { acumaticaPaymentId: `PAY-${made.id}`, acumaticaStatus: 'Balanced', createdAt: new Date('2026-10-08T02:00:00Z') },
    })
    const res = await get(`Bearer ${SECRET}`)
    expect(res.status).toBe(200)
    expect((await res.json()).autoSign).toMatchObject({ outcome: 'OK', signed: 1, enabled: true })
    expect((await testDb.check.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SIGNED')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node node_modules/vitest/vitest.mjs run tests/sync/auto-sign.test.ts tests/actions/auto-sign.test.ts tests/sync/cron-route.test.ts`
Expected: FAIL — `lib/sync/auto-sign.ts` imports `isManilaTuesday` / `mondayWindow`, which Task 1 removed (the files fail to load), or, once that import is fixed, the Monday cases sign nothing and `rule` is `'MONDAY'`.

- [ ] **Step 3: Implement the run** — in `lib/sync/auto-sign.ts`:

Replace the import line

```ts
import { AUTO_SIGN_RUN_ACTION, SIGNATURE_REVERTED_ACTION, isManilaTuesday, mondayWindow } from '@/lib/domain/auto-sign'
```

with

```ts
import { AUTO_SIGN_RUN_ACTION, SIGNATURE_REVERTED_ACTION, autoSignRunDay, signingCutoff } from '@/lib/domain/auto-sign'
```

Replace the header comment's first paragraph

```ts
 * THE AUTO-SIGN RUN. Called by /api/cron/sync after both tenants' syncs, at 12:00
 * and 18:00 Manila. It signs only on a Manila Tuesday — Monday's Acumatica
 * cheques (lib/domain/auto-sign.ts); on every other day it records IDLE.
```

with

```ts
 * THE AUTO-SIGN RUN. Called by /api/cron/sync after both tenants' syncs, at 12:00
 * and 18:00 Manila. It signs on a Manila Monday and Tuesday — every due
 * Acumatica check first read before that day (lib/domain/auto-sign.ts); on
 * every other day it records IDLE.
```

Replace the `LAST_RUN_UTC_HOUR` comment, `HOUR_MS` and `leftoverFate` — everything from `/**\n * The UTC hour of the LAST scheduled run of the day` down to the closing `}` of `leftoverFate` — with:

```ts
/**
 * The UTC hour of the LAST scheduled run of the day — vercel.json's
 * `"0 10 * * *"` entry on /api/cron/sync, 18:00 Manila. The other entry,
 * `"0 4 * * *"`, is 12:00 Manila. A run cut off before this hour is continued
 * by the 18:00 run; one cut off at or after it by the next run day's (Monday's
 * leftovers by Tuesday, Tuesday's by the next Monday), because neither run has
 * a lower bound. Change it with vercel.json.
 */
export const LAST_RUN_UTC_HOUR = 10
const HOUR_MS = 3_600_000

/** Which run picks up the checks a run left unsigned at its deadline. */
function leftoverFate(now: Date): string {
  // `signingCutoff(now)` is 00:00 Manila on the run's day = 16:00 UTC the day
  // before, so 18:00 Manila (10:00 UTC) is 18 hours after it.
  const lastRun = signingCutoff(now).getTime() + (LAST_RUN_UTC_HOUR + 8) * HOUR_MS
  if (now.getTime() < lastRun) return 'the 18:00 run continues'
  return autoSignRunDay(now) === 'MONDAY' ? "Tuesday's run continues" : "next Monday's run continues"
}
```

Replace `listAutoSignCandidates` with:

```ts
/** The database form of `isDueForAutoSign`; `autoSign` re-judges each row with the pure rule. */
export async function listAutoSignCandidates(db: PrismaClient, now: Date): Promise<AutoSignCandidate[]> {
  if (autoSignRunDay(now) === null) return []
  const rows = await db.check.findMany({
    where: {
      status: 'SIGNATURE_PENDING',
      acumaticaPaymentId: { not: null },
      isCheque: true,
      // `{ not: 'Voided' }` alone would drop the nulls: SQL's <> never matches NULL.
      OR: [{ acumaticaStatus: null }, { acumaticaStatus: { not: 'Voided' } }],
      createdAt: { lt: signingCutoff(now) },
      auditLogs: { none: { action: SIGNATURE_REVERTED_ACTION } },
    },
    select: { id: true, checkNumber: true, createdAt: true, company: { select: { code: true } } },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => ({ id: r.id, checkNumber: r.checkNumber, createdAt: r.createdAt, companyCode: r.company.code }))
}
```

In `runAutoSign`, replace

```ts
    } else if (!isManilaTuesday(args.now)) {
```

with

```ts
    } else if (autoSignRunDay(args.now) === null) {
```

and, in the deadline comment just below it, replace `whether the 18:00 run will pick it up or SIGN ALL must.` with `which run picks it up.`

- [ ] **Step 4: Implement the audit row** — in `lib/domain/actions.ts`:

Replace the import

```ts
import { isDueForAutoSign, AUTO_SIGNED_ACTION, SIGNATURE_REVERTED_ACTION } from './auto-sign'
```

with

```ts
import { autoSignRunDay, isDueForAutoSign, AUTO_SIGNED_ACTION, SIGNATURE_REVERTED_ACTION } from './auto-sign'
```

In `autoSign`, replace

```ts
    if (!isDueForAutoSign({ ...check, reverted }, args.now, true)) return null
```

with

```ts
    const runDay = autoSignRunDay(args.now)
    if (runDay === null || !isDueForAutoSign({ ...check, reverted }, args.now, true)) return null
    const day = runDay === 'MONDAY' ? 'Monday' : 'Tuesday'
```

and replace the `writeAudit` call's `details` and `remarks`

```ts
      details: { from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'MONDAY', inAppSince: check.createdAt.toISOString() },
      remarks:
        `Signed automatically at Tuesday's run: this Acumatica check first reached the app on ` +
        `Monday (${check.createdAt.toISOString()}). No one signed it here, so no signing user is recorded.`,
```

with

```ts
      details: { from: 'SIGNATURE_PENDING', to: 'SIGNED', rule: 'WEEKLY', runDay, inAppSince: check.createdAt.toISOString() },
      remarks:
        `Signed automatically at ${day}'s run: this Acumatica check first reached the app on ` +
        `${check.createdAt.toISOString()}, before that ${day}. No one signed it here, so no signing user is recorded.`,
```

- [ ] **Step 5: Update the cron route's comment** — in `app/api/cron/sync/route.ts`, replace

```ts
 * Then AUTO-SIGN (lib/sync/auto-sign.ts): on a Manila Tuesday, the Acumatica
 * cheques first read on the Monday become SIGNED; on any other day the run
 * records IDLE. It runs even when a tenant failed, and its own failure also
 * turns the response 500.
```

with

```ts
 * Then AUTO-SIGN (lib/sync/auto-sign.ts): on a Manila Monday or Tuesday, every
 * due Acumatica check first read before that day becomes SIGNED; on any other
 * day the run records IDLE. It runs even when a tenant failed, and its own
 * failure also turns the response 500.
```

and, a few lines above it, replace

```ts
 * records FAILED, the response is 500, and the 18:00 run retries what 12:00
 * left. That is the same exposure BILLS already had.
```

with

```ts
 * records FAILED, the response is 500, and the next run continues what it
 * left. That is the same exposure BILLS already had.
```

- [ ] **Step 6: Run tests and types, then commit Tasks 1 and 2**

Run: `node node_modules/vitest/vitest.mjs run tests/domain/auto-sign.test.ts tests/sync/auto-sign.test.ts tests/actions/auto-sign.test.ts tests/actions/revert-signature.test.ts tests/sync/cron-route.test.ts`
Expected: PASS, all files.

Run: `node node_modules/typescript/bin/tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK`.

```bash
git add lib/domain/auto-sign.ts lib/sync/auto-sign.ts lib/domain/actions.ts app/api/cron/sync/route.ts tests/domain/auto-sign.test.ts tests/sync/auto-sign.test.ts tests/actions/auto-sign.test.ts tests/sync/cron-route.test.ts
git commit -m "feat(auto-sign): sign on Monday and Tuesday - every check first read before that day

Monday's checks sign on Tuesday, the rest on the next Monday, and a run
cut off by its time budget is continued by the next run instead of
leaving the rest for SIGN ALL. auto_signed rows record rule WEEKLY and
the run day. Spec 2026-10-16-auto-sign-monday-and-tuesday-design.md.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The setting, `/admin/sync` and `CLAUDE.md`

**Files:**
- Modify: `lib/settings/registry.ts:85-87` (the `autoSign.mondayEnabled` entry)
- Modify: `lib/settings/defaults.ts:25` (comment)
- Modify: `app/admin/sync/page.tsx:244`, `:264`, `:265`
- Modify: `CLAUDE.md:807` (the **Auto-sign** paragraph)
- Test: `tests/settings/registry.test.ts:48-55`

**Interfaces:**
- Consumes: nothing new. The key `autoSign.mondayEnabled` and `getLastAutoSign`'s shape are unchanged.
- Produces: text only.

- [ ] **Step 1: Write the failing test** — in `tests/settings/registry.test.ts`, replace

```ts
  it('declares Monday auto-sign as a WORKFLOW ON/OFF switch, on by default', () => {
    const def = settingDef('autoSign.mondayEnabled')
    expect(def).toMatchObject({ kind: 'int', group: 'WORKFLOW', default: 1, min: 0, max: 1 })
```

with

```ts
  it('declares Monday-and-Tuesday auto-sign as a WORKFLOW ON/OFF switch, on by default', () => {
    const def = settingDef('autoSign.mondayEnabled')
    expect(def).toMatchObject({
      kind: 'int', group: 'WORKFLOW', default: 1, min: 0, max: 1,
      label: 'AUTO-SIGN ACUMATICA CHECKS ON MONDAY AND TUESDAY',
    })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/settings/registry.test.ts`
Expected: FAIL — the label is still `AUTO-SIGN MONDAY'S ACUMATICA CHECKS ON TUESDAY`.

- [ ] **Step 3: Change the text**

`lib/settings/registry.ts` — replace

```ts
  { kind: 'int', key: 'autoSign.mondayEnabled', group: 'WORKFLOW', label: "AUTO-SIGN MONDAY'S ACUMATICA CHECKS ON TUESDAY", unit: '1 = on, 0 = off',
    help: 'At 12:00 every Tuesday, an Acumatica check first read on the Monday and still at SIGNATURE PENDING is signed. Every other pending check waits for SIGN ALL.',
```

with

```ts
  { kind: 'int', key: 'autoSign.mondayEnabled', group: 'WORKFLOW', label: 'AUTO-SIGN ACUMATICA CHECKS ON MONDAY AND TUESDAY', unit: '1 = on, 0 = off',
    help: "At 12:00 and 18:00 every Monday, a pending Acumatica check first read before that Monday is signed; on Tuesday, one first read before that Tuesday. Monday's checks are therefore signed on Tuesday, and the rest on the next Monday.",
```

`lib/settings/defaults.ts` — replace

```ts
/** 1 = Monday's Acumatica cheques auto-sign at Tuesday's 12:00 run; 0 = off. */
```

with

```ts
/** 1 = Acumatica checks auto-sign on Monday and Tuesday (lib/domain/auto-sign.ts); 0 = off. */
```

`app/admin/sync/page.tsx` — replace

```tsx
            Auto-sign has not run yet. It runs at 12:00 and 18:00 Manila, after the sync, and signs on Tuesdays.
```

with

```tsx
            Auto-sign has not run yet. It runs at 12:00 and 18:00 Manila, after the sync, and signs on Mondays and Tuesdays.
```

replace

```tsx
              : <>: {n(lastAutoSign.signed)} Monday check(s) signed</>)}
            {lastAutoSign.outcome === 'IDLE' && <>: not a Tuesday — nothing due</>}
```

with

```tsx
              : <>: {n(lastAutoSign.signed)} check(s) signed</>)}
            {lastAutoSign.outcome === 'IDLE' && <>: not a Monday or Tuesday — nothing due</>}
```
`CLAUDE.md` — replace the whole paragraph that begins `   **Auto-sign** (rewritten 2026-10-01, spec` and ends `Rule 4 is untouched: the sync never writes status.` with:

```markdown
   **Auto-sign** (rewritten 2026-10-16, spec `2026-10-16-auto-sign-monday-and-tuesday-design.md`, replacing the 2026-10-01 Monday-only rule): the cron runs at 12:00 and 18:00 Manila (`0 4 * * *`, `0 10 * * *`); on a Manila Monday it signs every SIGNATURE_PENDING Acumatica check first read before that Monday (last Tuesday to Sunday and any older backlog — user ruling 2026-10-16), and on a Manila Tuesday every one first read before that Tuesday (Monday's checks and any Monday leftover), so Monday's checks sign on Tuesday and the rest on the next Monday (`signedById` null, one `auto_signed` row with `rule: 'WEEKLY'` and `runDay`, no portal event; rows written before 2026-10-16 say `rule: 'MONDAY'`). Measured 2026-10-16 before the change: 727 pending, not one `marked_signed` row ever — SIGN ALL had never been pressed. SIGN ALL on the SIGNATURE PENDING list still signs sooner (server-confirmed like RELEASE ALL, every Finance user). `SIGNED -> SIGNATURE_PENDING` is `revertSignature`, every Finance user, reason optional, one `signature_reverted` row; a reverted check is never auto-signed again. Setting `autoSign.mondayEnabled` (1/0, key kept, label "AUTO-SIGN ACUMATICA CHECKS ON MONDAY AND TUESDAY"). Every run writes one `auto_sign_run` row (read by LAST AUTO-SIGN on `/admin/sync`: "N check(s) signed", "not a Monday or Tuesday - nothing due", "switched off in settings") - `IDLE` Wednesday to Sunday; a FAILED run turns the cron response 500, and the route's 50-second time budget still applies. A run cut off by the budget is continued by the next run — the 18:00 run, else Tuesday's for Monday, else next Monday's for Tuesday — and the FAILED message says which (`LAST_RUN_UTC_HOUR` in `lib/sync/auto-sign.ts`, tied to `vercel.json`). Rule 4 is untouched: the sync never writes status.
```

- [ ] **Step 4: Run tests and types**

Run: `node node_modules/vitest/vitest.mjs run tests/settings/registry.test.ts`
Expected: PASS.

Run: `node node_modules/typescript/bin/tsc --noEmit && echo TSC_OK`
Expected: `TSC_OK`.

Run: `grep -rn "Monday check(s)\|not a Tuesday\|signs on Tuesdays\|isManilaTuesday\|mondayWindow" app components lib tests`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add lib/settings/registry.ts lib/settings/defaults.ts app/admin/sync/page.tsx CLAUDE.md tests/settings/registry.test.ts
git commit -m "docs(auto-sign): setting, /admin/sync and CLAUDE.md describe the Monday-and-Tuesday rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (not part of the plan's code)

- Merge `feature/auto-sign-weekly` into master and deploy from a clean master worktree, before Monday 19 October 12:00 Manila. No migration.
- Expected on 19 October: about 660 checks due; the first runs may record FAILED on the time budget, and the cron answer 500, until the backlog clears (spec, "Time budget and leftovers").
