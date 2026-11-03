# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-app notifications for four events (scheduled sync / auto-sign failed, sync stale, portal event parked, checks marked READY FOR RELEASE), with a bell in the header and a `/notifications` page.

**Architecture:** One row per recipient in the existing, never-written `Notification` table. Pure message builders in `lib/notifications/messages.ts`; one writer `notify` (audience → active users, `createMany skipDuplicates`) in `lib/notifications/notify.ts`; read-side queries in `lib/notifications/queries.ts`. Producers: the cron route (after its reads, before the portal kick), `settle` in the portal outbox (inside its transaction), and the two ready server actions (after commit).

**Tech Stack:** Next.js 15 App Router (server components, server actions), Prisma 6, Postgres (Neon), Vitest, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-16-notifications-design.md`

## Global Constraints

- In-app only. No email, no new dependency, no new environment variable.
- Audience `ADMINS` = active `FINANCE_ADMIN`; `FINANCE` = every active user. `active = false` (deactivated or PENDING) never receives anything.
- READY FOR RELEASE: one notification per action, every active user except the actor.
- Amounts are decimal strings / `Prisma.Decimal` end to end; never a JS number (rule 8). Display through `formatMoney` (`lib/money.ts`).
- A notification write never fails the work that triggered it, EXCEPT the PARKED notice, which is written in `settle`'s transaction on purpose.
- Rule 12: nothing reads from the portal. No pickup notification.
- Rule 6: no delete path for `User`; the new `Notification.userId` FK is `ON DELETE RESTRICT`.
- Spell "check", never "cheque", in new code and copy.
- Run tests from Git Bash as `node node_modules/vitest/vitest.mjs run <files>`; never the full suite. The TEST database is shared: before the first test run, check other sessions with ListAgents and tell them a migration is going onto TEST.
- The repo `.env` is PRODUCTION. Never run the dev server or a script against it. `node scripts/migrate.mjs test` is the only migration command in this plan.
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit`. Build: `node node_modules/next/dist/bin/next build`.
- Work in `C:\Users\User\Desktop\RCL PROJECTS\cm-notifications` on branch `feature/notifications`.

---

## File map

| File | Responsibility |
| --- | --- |
| `prisma/schema.prisma` | `Notification` gains `userId`, `kind` (was `type`), `link`, `dedupeKey`, unique + index; `User.notifications` |
| `prisma/migrations/20261016000100_notification_recipients/migration.sql` | the change, clearing the never-written table first |
| `lib/notifications/messages.ts` | pure: `Notice` type, `syncFailureNotices`, `staleNotices`, `parkedNotice`, `readyNotice`, `safeLink` |
| `lib/notifications/notify.ts` | `notify`, `safeNotify` |
| `lib/notifications/queries.ts` | `countUnread`, `listNotifications`, `markRead`, `markAllRead` |
| `lib/notifications/ready.ts` | `notifyReady` (loads the moved checks, builds and writes the notice, never throws) |
| `lib/notifications/cron.ts` | `notifyCronResults` (failures + stale, never throws) |
| `lib/sync/portal-outbox.ts` | `settle` writes `PORTAL_PARKED` in its transaction |
| `app/api/cron/sync/route.ts` | calls `notifyCronResults` before the portal kick |
| `app/checks/actions.ts`, `app/checks/bulk-actions.ts` | call `notifyReady` after a successful ready |
| `app/notifications/page.tsx`, `app/notifications/actions.ts` | the page, OPEN and MARK ALL READ |
| `components/AppHeader.tsx` | async; the bell with the unread count |
| `tests/notifications/*.test.ts` | new tests; `tests/sync/portal-outbox.test.ts`, `tests/sync/cron-route.test.ts`, `tests/actions/bulk-actions.test.ts`, `tests/actions/server-actions.test.ts` extended |

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (model `Notification`, model `User`)
- Create: `prisma/migrations/20261016000100_notification_recipients/migration.sql`

**Interfaces:**
- Produces: `prisma.notification` with fields `id, userId, kind, message, link, dedupeKey, checkId, readAt, createdAt`; compound unique `userId_dedupeKey`.

- [ ] **Step 1: Edit the model.** Replace `model Notification { ... }` with:

```prisma
/// One row per RECIPIENT (spec 2026-10-16-notifications-design.md). Not an
/// audit row: it can be marked read, and nothing deletes it. `kind` is a
/// NotificationKind (lib/notifications/messages.ts), a string like SyncRun.mode.
/// `dedupeKey` makes a repeated notice a no-op for the same user; Postgres
/// allows many NULLs in the unique index, so it binds only when set.
model Notification {
  id        String    @id @default(cuid())
  userId    String
  kind      String
  message   String
  link      String?
  dedupeKey String?
  checkId   String?
  readAt    DateTime?
  createdAt DateTime  @default(now())

  user      User      @relation(fields: [userId], references: [id])
  check     Check?    @relation(fields: [checkId], references: [id])

  @@unique([userId, dedupeKey])
  @@index([userId, readAt, createdAt])
}
```

and add to `model User`, after `receiptFilesUploaded`:

```prisma
  notifications            Notification[]
```

- [ ] **Step 2: Generate the SQL from the two schemas (no database needed).**

```bash
git show origin/master:prisma/schema.prisma > "$TMP/schema-before.prisma"
node node_modules/prisma/build/index.js migrate diff --from-schema-datamodel "$TMP/schema-before.prisma" --to-schema-datamodel prisma/schema.prisma --script
```

Expected: SQL that drops `type`, adds `kind`, `userId`, `link`, `dedupeKey`, creates the two indexes and the `userId` FK with `ON DELETE RESTRICT`. Write it to `prisma/migrations/20261016000100_notification_recipients/migration.sql` with this header prepended:

```sql
-- Notifications become one row per recipient (spec 2026-10-16-notifications-design.md).
-- The table has never been written by any code path (git log -S and grep,
-- 2026-10-16), so it is cleared first: adding the required "userId" to a table
-- with rows in it would fail.
DELETE FROM "Notification";
```

- [ ] **Step 3: Apply to TEST and regenerate the client.** Announce to sibling sessions first (ListAgents, then SendMessage to any running Check Monitoring session: "applying migration 20261016000100_notification_recipients to the TEST database; it only changes the unused Notification table").

```bash
node scripts/migrate.mjs test
node node_modules/prisma/build/index.js generate
```

Expected: the migration applies; client generated.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261016000100_notification_recipients
git commit -m "feat(notifications): one Notification row per recipient"
```

---

### Task 2: Pure message builders

**Files:**
- Create: `lib/notifications/messages.ts`
- Test: `tests/notifications/messages.test.ts`

**Interfaces:**
- Consumes: types `ScheduledSyncOutcome` (`lib/sync/scheduled.ts`), `ScheduledBillsOutcome` (`lib/sync/bills.ts`), `ScheduledBillRefsOutcome` (`lib/sync/bill-refs.ts`), `AutoSignRun` (`lib/sync/auto-sign.ts`), `Staleness` (`lib/sync/staleness.ts`); `formatMoney` (`lib/money.ts`).
- Produces:
  - `type NotificationKind = 'SYNC_FAILED' | 'AUTO_SIGN_FAILED' | 'SYNC_STALE' | 'PORTAL_PARKED' | 'READY_FOR_RELEASE'`
  - `type Audience = 'ADMINS' | 'FINANCE'`
  - `type Notice = { kind: NotificationKind; audience: Audience; message: string; link: string | null; dedupeKey?: string; checkId?: string }`
  - `syncFailureNotices(r: { outcomes: ScheduledSyncOutcome[]; bills: ScheduledBillsOutcome[]; billRefs: ScheduledBillRefsOutcome[]; autoSign: AutoSignRun }): Notice[]`
  - `staleNotices(s: Staleness): Notice[]`
  - `parkedNotice(a: { eventId: string; kind: string; checkId: string | null; checkNumber: string | null; error: string | null }): Notice`
  - `readyNotice(a: { actorName: string; checks: { checkNumber: string | null; amount: string | null; currency: string }[] }): Notice | null`
  - `safeLink(link: string | null): string | null`

- [ ] **Step 1: Write the failing test** `tests/notifications/messages.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { syncFailureNotices, staleNotices, parkedNotice, readyNotice, safeLink } from '@/lib/notifications/messages'
import type { AutoSignRun } from '@/lib/sync/auto-sign'

const okSign: AutoSignRun = { outcome: 'OK', signed: 0, skipped: 0, enabled: true }

describe('syncFailureNotices', () => {
  it('sends nothing when every read ran or was skipped for a reason that is not a failure', () => {
    expect(syncFailureNotices({
      outcomes: [
        { tenant: 'GOLIVE', outcome: 'RAN' } as never,
        { tenant: 'MANUFACTURING', outcome: 'IN_PROGRESS', message: 'busy' },
      ],
      bills: [{ tenant: 'MANUFACTURING', outcome: 'SKIPPED_PAYMENT_NOT_RUN' }],
      billRefs: [{ tenant: 'GOLIVE', outcome: 'SKIPPED_TIME_BUDGET', syncRunId: null }],
      autoSign: { ...okSign, outcome: 'IDLE' },
    })).toEqual([])
  })

  it('names the tenant and the read for each failure or refusal, to admins, linking /admin/sync', () => {
    const notices = syncFailureNotices({
      outcomes: [
        { tenant: 'GOLIVE', outcome: 'FAILED', message: 'socket hang up' },
        { tenant: 'MANUFACTURING', outcome: 'REFUSED_NO_WATERMARK', syncRunId: 'r1' },
      ],
      bills: [{ tenant: 'GOLIVE', outcome: 'FAILED', message: 'bills down' }],
      billRefs: [{ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: 'r2' }],
      autoSign: { ...okSign, outcome: 'FAILED', error: 'time budget reached' },
    })
    expect(notices.map((n) => [n.kind, n.audience, n.link])).toEqual([
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['AUTO_SIGN_FAILED', 'ADMINS', '/admin/sync'],
    ])
    expect(notices.map((n) => n.message)).toEqual([
      'Scheduled Acumatica payment read failed for GOLIVE: socket hang up',
      'Scheduled Acumatica payment read refused for MANUFACTURING: no watermark. A first read must be run from a terminal.',
      'Scheduled Acumatica voucher read (BILLS) failed for GOLIVE: bills down',
      'Scheduled Acumatica PO number read (BILL_REFS) refused for GOLIVE: no watermark. A first read must be run from a terminal.',
      'Auto-sign failed: time budget reached',
    ])
    expect(notices.every((n) => n.dedupeKey === undefined)).toBe(true)
  })
})

describe('staleNotices', () => {
  it('one notice per stale tenant, deduplicated on its last read', () => {
    const last = new Date('2026-10-14T04:00:00Z')
    const notices = staleNotices({
      tenants: [
        { tenant: 'GOLIVE', lastReadAt: last, hoursAgo: 40, stale: true },
        { tenant: 'MANUFACTURING', lastReadAt: null, hoursAgo: null, stale: true },
        { tenant: 'OTHER', lastReadAt: new Date(), hoursAgo: 1, stale: false },
      ],
      warn: true,
      oldestHours: 40,
    })
    expect(notices).toEqual([
      { kind: 'SYNC_STALE', audience: 'ADMINS', link: '/admin/sync', dedupeKey: `stale:GOLIVE:${last.toISOString()}`,
        message: 'No successful Acumatica read for GOLIVE in 40 hours.' },
      { kind: 'SYNC_STALE', audience: 'ADMINS', link: '/admin/sync', dedupeKey: 'stale:MANUFACTURING:never',
        message: 'Acumatica has never been read successfully for MANUFACTURING.' },
    ])
  })
})

describe('parkedNotice', () => {
  it('names the event kind, the check and the error, deduplicated on the event', () => {
    expect(parkedNotice({ eventId: 'e1', kind: 'MARK_AVAILABLE', checkId: 'c1', checkNumber: '6000354012', error: 'portal rejected the payload (400)' }))
      .toEqual({
        kind: 'PORTAL_PARKED', audience: 'ADMINS', link: '/admin/portal', dedupeKey: 'parked:e1', checkId: 'c1',
        message: 'Portal event MARK_AVAILABLE for check 6000354012 parked: portal rejected the payload (400)',
      })
  })

  it('says so when the check is gone, and carries no checkId', () => {
    const n = parkedNotice({ eventId: 'e2', kind: 'RELEASED', checkId: null, checkNumber: null, error: 'check no longer exists' })
    expect(n.message).toBe('Portal event RELEASED for a check no longer held parked: check no longer exists')
    expect(n.checkId).toBeUndefined()
  })
})

describe('readyNotice', () => {
  it('is null when nothing moved', () => {
    expect(readyNotice({ actorName: 'Ana', checks: [] })).toBeNull()
  })

  it('names the one check and its amount', () => {
    expect(readyNotice({ actorName: 'Ana', checks: [{ checkNumber: '6000354012', amount: '12500.00', currency: 'PHP' }] }))
      .toEqual({
        kind: 'READY_FOR_RELEASE', audience: 'FINANCE', link: '/?status=READY_FOR_RELEASE',
        message: 'Ana marked check 6000354012 READY FOR RELEASE: ₱12,500.00',
      })
  })

  it('counts a batch and totals it per currency without a float', () => {
    const n = readyNotice({ actorName: 'Ana', checks: [
      { checkNumber: '1', amount: '0.10', currency: 'PHP' },
      { checkNumber: '2', amount: '0.20', currency: 'PHP' },
      { checkNumber: '3', amount: '5.00', currency: 'USD' },
    ] })
    expect(n?.message).toBe('Ana marked 3 checks READY FOR RELEASE: ₱0.30, $5.00')
  })
})

describe('safeLink', () => {
  it('keeps an in-app path and refuses anything that could leave the site', () => {
    expect(safeLink('/admin/sync')).toBe('/admin/sync')
    expect(safeLink('/?status=READY_FOR_RELEASE')).toBe('/?status=READY_FOR_RELEASE')
    for (const bad of [null, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'admin/sync']) {
      expect(safeLink(bad)).toBeNull()
    }
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (module not found):

```bash
node node_modules/vitest/vitest.mjs run tests/notifications/messages.test.ts
```

- [ ] **Step 3: Implement** `lib/notifications/messages.ts`:

```ts
import { Prisma } from '@prisma/client'
import { formatMoney } from '@/lib/money'
import type { ScheduledSyncOutcome } from '@/lib/sync/scheduled'
import type { ScheduledBillsOutcome } from '@/lib/sync/bills'
import type { ScheduledBillRefsOutcome } from '@/lib/sync/bill-refs'
import type { AutoSignRun } from '@/lib/sync/auto-sign'
import type { Staleness } from '@/lib/sync/staleness'

/**
 * What each notification says, and to whom (spec 2026-10-16-notifications-design.md).
 * Pure: outcomes in, notices out. `notify` (./notify.ts) resolves the audience
 * to people and writes the rows.
 */
export type NotificationKind = 'SYNC_FAILED' | 'AUTO_SIGN_FAILED' | 'SYNC_STALE' | 'PORTAL_PARKED' | 'READY_FOR_RELEASE'
export type Audience = 'ADMINS' | 'FINANCE'
export type Notice = {
  kind: NotificationKind
  audience: Audience
  message: string
  link: string | null
  dedupeKey?: string
  checkId?: string
}

const SYNC_LINK = '/admin/sync'
const NO_WATERMARK = 'no watermark. A first read must be run from a terminal.'

type ReadOutcome = { tenant: string; outcome: string; message?: string }

function readNotices(read: string, list: readonly ReadOutcome[]): Notice[] {
  return list.flatMap((o): Notice[] => {
    if (o.outcome === 'FAILED') {
      return [{ kind: 'SYNC_FAILED', audience: 'ADMINS', link: SYNC_LINK,
        message: `Scheduled Acumatica ${read} failed for ${o.tenant}: ${o.message ?? 'no detail recorded'}` }]
    }
    if (o.outcome === 'REFUSED_NO_WATERMARK') {
      return [{ kind: 'SYNC_FAILED', audience: 'ADMINS', link: SYNC_LINK,
        message: `Scheduled Acumatica ${read} refused for ${o.tenant}: ${NO_WATERMARK}` }]
    }
    // RAN, IN_PROGRESS, SKIPPED_PAYMENT_NOT_RUN, SKIPPED_TIME_BUDGET: not failures.
    return []
  })
}

/** The cron's results, as notices. Only FAILED and REFUSED notify. */
export function syncFailureNotices(r: {
  outcomes: readonly ScheduledSyncOutcome[]
  bills: readonly ScheduledBillsOutcome[]
  billRefs: readonly ScheduledBillRefsOutcome[]
  autoSign: AutoSignRun
}): Notice[] {
  const notices = [
    ...readNotices('payment read', r.outcomes as readonly ReadOutcome[]),
    ...readNotices('voucher read (BILLS)', r.bills as readonly ReadOutcome[]),
    ...readNotices('PO number read (BILL_REFS)', r.billRefs as readonly ReadOutcome[]),
  ]
  if (r.autoSign.outcome === 'FAILED') {
    notices.push({ kind: 'AUTO_SIGN_FAILED', audience: 'ADMINS', link: SYNC_LINK,
      message: `Auto-sign failed: ${r.autoSign.error ?? 'no detail recorded'}` })
  }
  return notices
}

/** One notice per stale tenant, once per stale stretch (keyed on its last good read). */
export function staleNotices(s: Staleness): Notice[] {
  return s.tenants.filter((t) => t.stale).map((t): Notice => ({
    kind: 'SYNC_STALE', audience: 'ADMINS', link: SYNC_LINK,
    dedupeKey: `stale:${t.tenant}:${t.lastReadAt?.toISOString() ?? 'never'}`,
    message: t.lastReadAt === null
      ? `Acumatica has never been read successfully for ${t.tenant}.`
      : `No successful Acumatica read for ${t.tenant} in ${t.hoursAgo} hours.`,
  }))
}

/** A portal outbox event that needs a person. Once per event. */
export function parkedNotice(a: {
  eventId: string; kind: string; checkId: string | null; checkNumber: string | null; error: string | null
}): Notice {
  const which = a.checkId === null ? 'a check no longer held' : `check ${a.checkNumber ?? '(no number)'}`
  return {
    kind: 'PORTAL_PARKED', audience: 'ADMINS', link: '/admin/portal', dedupeKey: `parked:${a.eventId}`,
    ...(a.checkId === null ? {} : { checkId: a.checkId }),
    message: `Portal event ${a.kind} for ${which} parked: ${a.error ?? 'no detail recorded'}`,
  }
}

/** One notice for one ready action. Totals per currency, in Decimal, never a float. */
export function readyNotice(a: {
  actorName: string
  checks: readonly { checkNumber: string | null; amount: string | null; currency: string }[]
}): Notice | null {
  if (a.checks.length === 0) return null
  const totals = new Map<string, Prisma.Decimal>()
  for (const c of a.checks) {
    if (c.amount === null) continue
    totals.set(c.currency, (totals.get(c.currency) ?? new Prisma.Decimal(0)).plus(c.amount))
  }
  const money = [...totals].map(([cur, sum]) => formatMoney(sum.toFixed(2), cur)).join(', ')
  const what = a.checks.length === 1
    ? `check ${a.checks[0].checkNumber ?? '(no number)'}`
    : `${a.checks.length} checks`
  return {
    kind: 'READY_FOR_RELEASE', audience: 'FINANCE', link: '/?status=READY_FOR_RELEASE',
    message: `${a.actorName} marked ${what} READY FOR RELEASE${money ? `: ${money}` : ''}`,
  }
}

/** An in-app path, or null. Never lets a stored value send someone off-site. */
export function safeLink(link: string | null): string | null {
  if (!link || !link.startsWith('/') || link.startsWith('//') || link.startsWith('/\\')) return null
  return link
}
```

- [ ] **Step 4: Run the test, expect PASS.** If `formatMoney` renders differently from `₱12,500.00`, read `tests/money.test.ts` and correct the expected strings, not the code.

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/messages.ts tests/notifications/messages.test.ts
git commit -m "feat(notifications): pure message builders"
```

---

### Task 3: Writer and read-side queries

**Files:**
- Create: `lib/notifications/notify.ts`, `lib/notifications/queries.ts`
- Test: `tests/notifications/notify.test.ts`, `tests/notifications/queries.test.ts`

**Interfaces:**
- Consumes: `Notice` from Task 2.
- Produces:
  - `type Db = PrismaClient | Prisma.TransactionClient` (local to each file)
  - `notify(db: Db, notice: Notice, opts?: { excludeUserId?: string }): Promise<number>`
  - `safeNotify(db: Db, notices: Notice | readonly Notice[] | null, opts?: { excludeUserId?: string }): Promise<void>`
  - `countUnread(db: Db, userId: string): Promise<number>`
  - `listNotifications(db: Db, userId: string, limit?: number): Promise<Notification[]>` (newest first, default 200)
  - `markRead(db: Db, userId: string, id: string, now: Date): Promise<{ link: string | null } | null>` (null when the row is not this user's)
  - `markAllRead(db: Db, userId: string, now: Date): Promise<number>`

- [ ] **Step 1: Write the failing tests.**

`tests/notifications/notify.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { notify, safeNotify } from '@/lib/notifications/notify'
import type { Notice } from '@/lib/notifications/messages'

const adminNotice: Notice = { kind: 'SYNC_FAILED', audience: 'ADMINS', message: 'm', link: '/admin/sync' }
const everyone: Notice = { kind: 'READY_FOR_RELEASE', audience: 'FINANCE', message: 'r', link: '/?status=READY_FOR_RELEASE' }

beforeEach(resetDb)

describe('notify', () => {
  it('ADMINS reaches active admins only; FINANCE reaches every active user', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    const user = await makeUser('FINANCE_USER')
    const gone = await makeUser('FINANCE_ADMIN')
    await testDb.user.update({ where: { id: gone.id }, data: { active: false } })
    const pending = await makeUser('FINANCE_USER')
    await testDb.user.update({ where: { id: pending.id }, data: { active: false, pendingSince: new Date() } })

    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await notify(testDb, everyone)).toBe(2)

    const rows = await testDb.notification.findMany({ orderBy: { kind: 'asc' } })
    expect(rows.filter((r) => r.kind === 'SYNC_FAILED').map((r) => r.userId)).toEqual([admin.id])
    expect(rows.filter((r) => r.kind === 'READY_FOR_RELEASE').map((r) => r.userId).sort()).toEqual([admin.id, user.id].sort())
    expect(rows.every((r) => r.readAt === null && r.link !== null)).toBe(true)
  })

  it('leaves out the actor', async () => {
    const actor = await makeUser('FINANCE_USER')
    const other = await makeUser('FINANCE_USER')
    expect(await notify(testDb, everyone, { excludeUserId: actor.id })).toBe(1)
    expect((await testDb.notification.findMany()).map((r) => r.userId)).toEqual([other.id])
  })

  it('a repeated dedupeKey writes nothing more; no key never dedupes', async () => {
    await makeUser('FINANCE_ADMIN')
    expect(await notify(testDb, { ...adminNotice, dedupeKey: 'k' })).toBe(1)
    expect(await notify(testDb, { ...adminNotice, dedupeKey: 'k' })).toBe(0)
    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await notify(testDb, adminNotice)).toBe(1)
    expect(await testDb.notification.count()).toBe(3)
  })
})

describe('safeNotify', () => {
  it('never throws, and writes each notice it can', async () => {
    await makeUser('FINANCE_ADMIN')
    const broken = { ...adminNotice, checkId: 'no-such-check' } // FK violation
    await expect(safeNotify(testDb, [broken, adminNotice])).resolves.toBeUndefined()
    expect(await testDb.notification.count()).toBe(1)
    await expect(safeNotify(testDb, null)).resolves.toBeUndefined()
  })
})
```

`tests/notifications/queries.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'
import { countUnread, listNotifications, markRead, markAllRead } from '@/lib/notifications/queries'

const NOW = new Date('2026-10-16T04:00:00Z')

beforeEach(resetDb)

async function seed(userId: string, message: string, createdAt: Date, readAt: Date | null = null) {
  return testDb.notification.create({ data: { userId, kind: 'SYNC_FAILED', message, link: '/admin/sync', createdAt, readAt } })
}

describe('notification queries', () => {
  it('counts and lists only the user\'s own, newest first', async () => {
    const me = await makeUser(); const other = await makeUser()
    await seed(me.id, 'old', new Date('2026-10-15T00:00:00Z'))
    await seed(me.id, 'new', new Date('2026-10-16T00:00:00Z'))
    await seed(me.id, 'read', new Date('2026-10-14T00:00:00Z'), NOW)
    await seed(other.id, 'theirs', NOW)
    expect(await countUnread(testDb, me.id)).toBe(2)
    expect((await listNotifications(testDb, me.id)).map((n) => n.message)).toEqual(['new', 'old', 'read'])
    expect((await listNotifications(testDb, me.id, 1)).map((n) => n.message)).toEqual(['new'])
  })

  it('markRead marks the owner\'s row and returns its link; another user\'s row is refused untouched', async () => {
    const me = await makeUser(); const other = await makeUser()
    const mine = await seed(me.id, 'm', NOW)
    const theirs = await seed(other.id, 't', NOW)
    expect(await markRead(testDb, me.id, mine.id, NOW)).toEqual({ link: '/admin/sync' })
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: mine.id } })).readAt).toEqual(NOW)
    expect(await markRead(testDb, me.id, theirs.id, NOW)).toBeNull()
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull()
  })

  it('markAllRead marks only the user\'s unread rows', async () => {
    const me = await makeUser(); const other = await makeUser()
    await seed(me.id, 'a', NOW); await seed(me.id, 'b', NOW)
    await seed(other.id, 'c', NOW)
    expect(await markAllRead(testDb, me.id, NOW)).toBe(2)
    expect(await countUnread(testDb, me.id)).toBe(0)
    expect(await countUnread(testDb, other.id)).toBe(1)
  })
})
```

- [ ] **Step 2: Run both, expect FAIL** (modules not found):

```bash
node node_modules/vitest/vitest.mjs run tests/notifications/notify.test.ts tests/notifications/queries.test.ts
```

- [ ] **Step 3: Implement** `lib/notifications/notify.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Notice } from './messages'

type Db = PrismaClient | Prisma.TransactionClient

/**
 * The one writer. Resolves the audience to the users active NOW (a
 * deactivated or PENDING account receives nothing), drops the actor, and
 * writes one row each. `skipDuplicates` makes a repeated dedupeKey a no-op.
 * Returns the rows written.
 */
export async function notify(db: Db, notice: Notice, opts: { excludeUserId?: string } = {}): Promise<number> {
  const users = await db.user.findMany({
    where: {
      active: true,
      ...(notice.audience === 'ADMINS' ? { role: 'FINANCE_ADMIN' as const } : {}),
      ...(opts.excludeUserId ? { id: { not: opts.excludeUserId } } : {}),
    },
    select: { id: true },
  })
  if (users.length === 0) return 0
  const r = await db.notification.createMany({
    data: users.map((u) => ({
      userId: u.id,
      kind: notice.kind,
      message: notice.message,
      link: notice.link,
      dedupeKey: notice.dedupeKey ?? null,
      checkId: notice.checkId ?? null,
    })),
    skipDuplicates: true,
  })
  return r.count
}

/**
 * For callers whose own work has already committed: a notification that
 * cannot be written is logged and dropped, never turned into a failure of a
 * release, a ready action or a cron run. Each notice is tried on its own.
 */
export async function safeNotify(
  db: Db, notices: Notice | readonly Notice[] | null, opts: { excludeUserId?: string } = {},
): Promise<void> {
  if (notices === null) return
  const list: readonly Notice[] = Array.isArray(notices) ? notices : [notices as Notice]
  for (const n of list) {
    try {
      await notify(db, n, opts)
    } catch (e) {
      console.error(`notification ${n.kind} could not be written:`, e instanceof Error ? e.message : e)
    }
  }
}
```

`lib/notifications/queries.ts`:

```ts
import type { Notification, Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export const NOTIFICATION_PAGE_LIMIT = 200

export function countUnread(db: Db, userId: string): Promise<number> {
  return db.notification.count({ where: { userId, readAt: null } })
}

export function listNotifications(db: Db, userId: string, limit = NOTIFICATION_PAGE_LIMIT): Promise<Notification[]> {
  return db.notification.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
  })
}

/** Marks one row read, only when it is the user's. Null when it is not (or does not exist). */
export async function markRead(db: Db, userId: string, id: string, now: Date): Promise<{ link: string | null } | null> {
  const row = await db.notification.findFirst({ where: { id, userId }, select: { link: true, readAt: true } })
  if (!row) return null
  if (row.readAt === null) {
    await db.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: now } })
  }
  return { link: row.link }
}

export async function markAllRead(db: Db, userId: string, now: Date): Promise<number> {
  const r = await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: now } })
  return r.count
}
```

- [ ] **Step 4: Run both, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/notify.ts lib/notifications/queries.ts tests/notifications/notify.test.ts tests/notifications/queries.test.ts
git commit -m "feat(notifications): writer and read-side queries"
```

---

### Task 4: Portal event PARKED

**Files:**
- Modify: `lib/sync/portal-outbox.ts` (`settle`, ~line 150)
- Test: `tests/sync/portal-outbox.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `notify` (Task 3), `parkedNotice` (Task 2).

- [ ] **Step 1: Write the failing test.** Append to `tests/sync/portal-outbox.test.ts` (add `makeUser` to the factory import):

```ts
describe('deliverPortalEvents: a parked event notifies the admins', () => {
  it('writes one PORTAL_PARKED per active admin, once per event', async () => {
    const admin = await makeUser('FINANCE_ADMIN')
    await makeUser('FINANCE_USER')
    const check = await releasedCheck('AP-1')
    const ev = await queue(check.id, 'RELEASED', NOW)
    const client = fakeClient(() => ({ status: 400, body: null }))
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })

    const rows = await testDb.notification.findMany()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: admin.id, kind: 'PORTAL_PARKED', link: '/admin/portal', checkId: check.id, dedupeKey: `parked:${ev.id}`,
    })
    expect(rows[0].message).toContain(`check ${check.checkNumber}`)

    // Re-queued by RETRY and parked again: no second notification for the same event.
    await testDb.portalEvent.update({ where: { id: ev.id }, data: { status: 'PENDING', nextAttemptAt: LATER } })
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client })
    expect(await testDb.notification.count()).toBe(1)
  })

  it('a FAILED delivery that will retry notifies nobody', async () => {
    await makeUser('FINANCE_ADMIN')
    const check = await releasedCheck('AP-1')
    await queue(check.id, 'RELEASED', NOW)
    await deliverPortalEvents(testDb, { now: LATER, deadline: new Date(LATER.getTime() + 10_000), client: fakeClient(() => ({ status: 503, body: null })) })
    expect(await testDb.notification.count()).toBe(0)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (0 notifications):

```bash
node node_modules/vitest/vitest.mjs run tests/sync/portal-outbox.test.ts
```

- [ ] **Step 3: Implement.** In `lib/sync/portal-outbox.ts` add imports:

```ts
import { notify } from '@/lib/notifications/notify'
import { parkedNotice } from '@/lib/notifications/messages'
```

In `settle`, inside the `atomically` callback, immediately after the `writeAudit(...)` call and before `return true`:

```ts
    // The admins are told in the same transaction (spec 2026-10-16
    // notifications §Portal event parked): the notice exists exactly when the
    // parked state does. Once per event (dedupeKey), so RETRY → parked again
    // does not repeat it. checkId only when the check still exists, or the FK
    // would refuse the row.
    if (status === 'PARKED') {
      const parkedCheck = await tx.check.findUnique({ where: { id: ev.checkId }, select: { checkNumber: true } })
      await notify(tx, parkedNotice({
        eventId: ev.id, kind: ev.kind,
        checkId: parkedCheck ? ev.checkId : null,
        checkNumber: parkedCheck?.checkNumber ?? null,
        error: lastError,
      }))
    }
```

- [ ] **Step 4: Run the whole file, expect PASS** (existing cases unchanged; they create no admin, so no rows).

- [ ] **Step 5: Commit**

```bash
git add lib/sync/portal-outbox.ts tests/sync/portal-outbox.test.ts
git commit -m "feat(notifications): tell admins when a portal event parks"
```

---

### Task 5: Cron failures and staleness

**Files:**
- Create: `lib/notifications/cron.ts`
- Modify: `app/api/cron/sync/route.ts` (before the portal kick, ~line 178)
- Test: `tests/sync/cron-route.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `syncFailureNotices`, `staleNotices` (Task 2); `safeNotify` (Task 3); `getSyncOverview` (`lib/admin/sync-overview.ts`); `describeStaleness` (`lib/sync/staleness.ts`); `loadSettings` (`lib/settings/read.ts`).
- Produces: `notifyCronResults(db: PrismaClient, r: Parameters<typeof syncFailureNotices>[0], now: Date): Promise<void>` — never throws.

- [ ] **Step 1: Write the failing test.** Append to `tests/sync/cron-route.test.ts` (import `makeUser` from `'../helpers/factory'`):

```ts
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
```

- [ ] **Step 2: Run, expect FAIL:**

```bash
node node_modules/vitest/vitest.mjs run tests/sync/cron-route.test.ts
```

- [ ] **Step 3: Implement** `lib/notifications/cron.ts`:

```ts
import type { PrismaClient } from '@prisma/client'
import { getSyncOverview } from '@/lib/admin/sync-overview'
import { describeStaleness } from '@/lib/sync/staleness'
import { loadSettings } from '@/lib/settings/read'
import { safeNotify } from './notify'
import { staleNotices, syncFailureNotices } from './messages'

/**
 * The scheduled run's notices: one per FAILED or REFUSED read and for an
 * auto-sign FAILED, then one per stale tenant (once per stale stretch). Called
 * by the cron route after its reads. Never throws, and never changes the
 * route's HTTP status.
 *
 * Known limit (spec): if the cron stops running altogether, nothing runs the
 * stale check. The dashboard's stale line is the backstop.
 */
export async function notifyCronResults(
  db: PrismaClient, r: Parameters<typeof syncFailureNotices>[0], now: Date,
): Promise<void> {
  await safeNotify(db, syncFailureNotices(r))
  try {
    const settings = await loadSettings(db)
    const overview = await getSyncOverview(db, now, settings.values['sync.abandonedAfterMinutes'])
    const staleness = describeStaleness(
      overview.tenants.map((t) => ({ tenant: t.tenant, lastReadAt: t.lastSuccess?.startedAt ?? null })),
      now,
      settings.values['sync.staleAfterHours'],
    )
    await safeNotify(db, staleNotices(staleness))
  } catch (e) {
    console.error('stale-sync notification could not be computed:', e instanceof Error ? e.message : e)
  }
}
```

In `app/api/cron/sync/route.ts`, import `import { notifyCronResults } from '@/lib/notifications/cron'`, and insert directly after the `runAutoSign` line and before `const remaining = ...`:

```ts
  // Tell the admins what failed, and whether a tenant has gone stale (spec
  // 2026-10-16-notifications-design.md). Before the portal kick so the kick's
  // budget is measured after it; never throws, never changes the status code.
  await notifyCronResults(prisma, { outcomes, bills, billRefs, autoSign }, new Date())
```

Also add one paragraph to the route's header comment, after the AUTO-SIGN paragraph:

```ts
 * Then NOTIFICATIONS (lib/notifications/cron.ts): every FAILED or REFUSED
 * read and an auto-sign FAILED notify the active FINANCE_ADMINs, and a tenant
 * past `sync.staleAfterHours` notifies them once per stale stretch. Never a
 * failure of the cron.
```

- [ ] **Step 4: Run the whole file, expect PASS.** The guard tests still assert 0 database touches: the notifications run only after authentication.

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/cron.ts app/api/cron/sync/route.ts tests/sync/cron-route.test.ts
git commit -m "feat(notifications): scheduled sync failures and staleness notify admins"
```

---

### Task 6: READY FOR RELEASE

**Files:**
- Create: `lib/notifications/ready.ts`
- Modify: `app/checks/actions.ts` (`readyForReleaseAction`), `app/checks/bulk-actions.ts` (`bulkReadyForReleaseAction`)
- Test: `tests/actions/bulk-actions.test.ts`, `tests/actions/server-actions.test.ts` (append cases)

**Interfaces:**
- Consumes: `readyNotice` (Task 2), `safeNotify` (Task 3).
- Produces: `notifyReady(db: PrismaClient, actor: { id: string; name: string }, checkIds: readonly string[]): Promise<void>` — never throws.

- [ ] **Step 1: Write the failing tests.**

Append inside `describe('bulkReadyForReleaseAction', ...)` in `tests/actions/bulk-actions.test.ts`:

```ts
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
```

Append inside `describe('readyForReleaseAction', ...)` in `tests/actions/server-actions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, expect FAIL:**

```bash
node node_modules/vitest/vitest.mjs run tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts
```

- [ ] **Step 3: Implement** `lib/notifications/ready.ts`:

```ts
import type { PrismaClient } from '@prisma/client'
import { readyNotice } from './messages'
import { safeNotify } from './notify'

/**
 * One notification for one READY FOR RELEASE action, to every active user
 * except the actor (spec 2026-10-16). `checkIds` are the checks that MOVED;
 * the amounts are read back from the database, never taken from the form.
 * Called after the action committed, so it never throws.
 */
export async function notifyReady(
  db: PrismaClient, actor: { id: string; name: string }, checkIds: readonly string[],
): Promise<void> {
  if (checkIds.length === 0) return
  try {
    const checks = await db.check.findMany({
      where: { id: { in: [...checkIds] } },
      select: { checkNumber: true, amount: true, currency: true },
      orderBy: { checkNumber: 'asc' },
    })
    const notice = readyNotice({
      actorName: actor.name,
      checks: checks.map((c) => ({ checkNumber: c.checkNumber, amount: c.amount?.toString() ?? null, currency: c.currency })),
    })
    await safeNotify(db, notice, { excludeUserId: actor.id })
  } catch (e) {
    console.error('ready-for-release notification could not be written:', e instanceof Error ? e.message : e)
  }
}
```

In `app/checks/actions.ts`, import `import { notifyReady } from '@/lib/notifications/ready'` and replace `readyForReleaseAction`'s body:

```ts
export async function readyForReleaseAction(formData: FormData): Promise<ActionResult> {
  const user = await requireUser()
  const checkId = str(formData, 'checkId')
  const result = await run(checkId, () => markReadyForRelease(prisma, {
    checkId, userId: user.id,
    availablePickupDate: date(formData, 'availablePickupDate'),
    now: new Date(),
  }))
  // The others are told after the check moved; never fails the action.
  if (result.ok) await notifyReady(prisma, user, [checkId])
  return result
}
```

In `app/checks/bulk-actions.ts`, import the same, and replace the final `return runEach(...)` of `bulkReadyForReleaseAction`:

```ts
  const now = new Date()
  const result = await runEach(prisma, selection.checkIds, (checkId) =>
    markReadyForRelease(prisma, { checkId, userId: user.id, availablePickupDate, now }))
  // One notification for the batch, over the checks that moved (spec 2026-10-16).
  if (result.ok) await notifyReady(prisma, user, result.outcomes.filter((o) => o.ok).map((o) => o.checkId))
  return result
```

- [ ] **Step 4: Run both files, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/notifications/ready.ts app/checks/actions.ts app/checks/bulk-actions.ts tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts
git commit -m "feat(notifications): READY FOR RELEASE notifies the other Finance users"
```

---

### Task 7: The bell and /notifications

**Files:**
- Create: `app/notifications/actions.ts`, `app/notifications/page.tsx`
- Modify: `components/AppHeader.tsx`
- Test: `tests/actions/notification-actions.test.ts`

**Interfaces:**
- Consumes: `countUnread`, `listNotifications`, `markRead`, `markAllRead` (Task 3); `safeLink` (Task 2).
- Produces: `openNotificationAction(formData: FormData): Promise<void>`, `markAllReadAction(): Promise<void>`.

- [ ] **Step 1: Write the failing test** `tests/actions/notification-actions.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeUser } from '../helpers/factory'

const currentUser = { id: '', email: 'f@rcl.test', name: 'Finance User', role: 'FINANCE_USER' as const }

vi.mock('@/lib/auth', () => ({ requireUser: async () => currentUser }))
vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return { prisma: testDb }
})
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`) },
}))

beforeEach(async () => {
  await resetDb()
  currentUser.id = (await makeUser()).id
})

const form = (id: string) => { const f = new FormData(); f.append('id', id); return f }

describe('openNotificationAction', () => {
  it('marks the row read and goes to its link', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const n = await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'm', link: '/admin/sync' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/admin/sync')
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull()
  })

  it('refuses another user\'s row: untouched, back to the list', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const other = await makeUser()
    const n = await testDb.notification.create({ data: { userId: other.id, kind: 'SYNC_FAILED', message: 'm', link: '/admin/sync' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/notifications')
    expect((await testDb.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).toBeNull()
  })

  it('never follows a stored off-site link', async () => {
    const { openNotificationAction } = await import('@/app/notifications/actions')
    const n = await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'm', link: '//evil.test' } })
    await expect(openNotificationAction(form(n.id))).rejects.toThrow('REDIRECT:/notifications')
  })
})

describe('markAllReadAction', () => {
  it('marks every unread row of the user read', async () => {
    const { markAllReadAction } = await import('@/app/notifications/actions')
    await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'a' } })
    await testDb.notification.create({ data: { userId: currentUser.id, kind: 'SYNC_FAILED', message: 'b' } })
    await expect(markAllReadAction()).rejects.toThrow('REDIRECT:/notifications')
    expect(await testDb.notification.count({ where: { readAt: null } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run, expect FAIL:**

```bash
node node_modules/vitest/vitest.mjs run tests/actions/notification-actions.test.ts
```

- [ ] **Step 3: Implement** `app/notifications/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { markAllRead, markRead } from '@/lib/notifications/queries'
import { safeLink } from '@/lib/notifications/messages'

/**
 * OPEN: marks the row read and goes where it points. A row that is not the
 * session user's is refused as not found (untouched, back to the list), and a
 * stored link that is not an in-app path is never followed.
 */
export async function openNotificationAction(formData: FormData): Promise<void> {
  const user = await requireUser()
  const id = String(formData.get('id') ?? '').trim()
  const found = id ? await markRead(prisma, user.id, id, new Date()) : null
  revalidatePath('/notifications')
  redirect((found && safeLink(found.link)) ?? '/notifications')
}

export async function markAllReadAction(): Promise<void> {
  const user = await requireUser()
  await markAllRead(prisma, user.id, new Date())
  revalidatePath('/notifications')
  redirect('/notifications')
}
```

`app/notifications/page.tsx`:

```tsx
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { listNotifications, NOTIFICATION_PAGE_LIMIT } from '@/lib/notifications/queries'
import { markAllReadAction, openNotificationAction } from './actions'

export const dynamic = 'force-dynamic'

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

/**
 * The session user's own notifications, newest first (spec
 * 2026-10-16-notifications-design.md). Plain forms posting server actions: no
 * client JavaScript.
 */
export default async function NotificationsPage() {
  const user = await requireUser()
  const rows = await listNotifications(prisma, user.id)
  const unread = rows.filter((r) => r.readAt === null).length

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="NOTIFICATIONS" back={{ href: '/', label: '← DASHBOARD' }} />
      {rows.length === 0 ? (
        <EmptyState title="No notifications yet.">
          Failed or stale Acumatica reads, parked portal events and checks marked READY FOR RELEASE appear here.
        </EmptyState>
      ) : (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">
              {unread} unread{rows.length === NOTIFICATION_PAGE_LIMIT ? ` · the newest ${NOTIFICATION_PAGE_LIMIT} shown` : ''}
            </p>
            {unread > 0 && (
              <form action={markAllReadAction}>
                <button type="submit" className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline hover:bg-navy-bg hover:text-navy">
                  MARK ALL READ
                </button>
              </form>
            )}
          </div>
          <ul className="divide-y divide-hairline rounded-xl bg-white shadow-sm ring-1 ring-hairline">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className={`text-sm ${r.readAt === null ? 'font-semibold text-navy' : 'text-slate-600'}`}>{r.message}</p>
                  <p className="text-xs text-slate-400">{fmt(r.createdAt)}</p>
                </div>
                {r.link && (
                  <form action={openNotificationAction}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline hover:bg-navy-bg hover:text-navy">
                      OPEN
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
```

In `components/AppHeader.tsx`: add imports `import { prisma } from '@/lib/db'` and `import { countUnread } from '@/lib/notifications/queries'`; make the function `export async function AppHeader(...)`; at its top:

```tsx
  // The bell's count: one indexed count per render, no polling (spec
  // 2026-10-16). A failed count shows no number rather than breaking the page.
  let unread: number | null = null
  try {
    unread = await countUnread(prisma, user.id)
  } catch (e) {
    console.error('unread notification count failed:', e instanceof Error ? e.message : e)
  }
```

and insert, as the first child of the right-hand `<div className="flex flex-wrap items-center gap-3 text-sm text-slate-500">`:

```tsx
          <Link
            href="/notifications"
            className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm ring-1 ring-hairline transition hover:bg-navy-bg hover:text-navy"
          >
            NOTIFICATIONS
            {unread !== null && unread > 0 && (
              <span className="rounded-full bg-navy px-2 py-0.5 text-[10px] font-semibold text-white">{unread}</span>
            )}
          </Link>
```

Add one sentence to the header comment: "Since 2026-10-16 it carries the NOTIFICATIONS link with the user's unread count, so it is an async server component."

- [ ] **Step 4: Run the test, expect PASS.** Then typecheck:

```bash
node node_modules/vitest/vitest.mjs run tests/actions/notification-actions.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

Expected: PASS; tsc prints nothing. If tsc reports `'AppHeader' cannot be used as a JSX component` (an async component under an old `@types/react`), check `@types/react` is 19 (it is, `^19.2.18`) and report rather than work around it.

- [ ] **Step 5: Commit**

```bash
git add app/notifications components/AppHeader.tsx tests/actions/notification-actions.test.ts
git commit -m "feat(notifications): bell in the header and the /notifications page"
```

---

### Task 8: Verify, document, hand over

**Files:**
- Modify: `CLAUDE.md` ("What is missing" item 4; Layout table)

- [ ] **Step 1: Run every touched test file together:**

```bash
node node_modules/vitest/vitest.mjs run tests/notifications tests/sync/portal-outbox.test.ts tests/sync/cron-route.test.ts tests/actions/bulk-actions.test.ts tests/actions/server-actions.test.ts tests/actions/notification-actions.test.ts tests/schema.test.ts
```

Expected: all pass. A 5-second timeout that passes on a lone re-run is the remote database, not a defect; say so if it happens.

- [ ] **Step 2: Typecheck and build:**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build
```

Expected: tsc prints nothing; build succeeds and lists `/notifications`.

- [ ] **Step 3: Update CLAUDE.md.** Replace item 4 of "What is missing" with:

```markdown
4. **Notifications are in-app** (built 2026-10-16, spec `2026-10-16-notifications-design.md`): a
   NOTIFICATIONS link with the unread count in the header and `/notifications`. One `Notification`
   row per recipient. FINANCE_ADMINs are told when a scheduled read (payments, BILLS, BILL_REFS) or
   auto-sign FAILS or is REFUSED (every run), when a tenant goes past `sync.staleAfterHours` (once
   per stale stretch, `dedupeKey`), and when a portal event PARKS (in `settle`'s transaction, once
   per event). Every other active user is told once per READY FOR RELEASE action (single or bulk,
   the actor excluded). No email. Not notified, and not reachable: a supplier's pickup booking
   (rule 12). If the cron stops running, the stale notice cannot fire; the dashboard's stale line
   is the backstop. Migration `20261016000100_notification_recipients` must reach production
   before the deploy (the header queries it on every page).
```

and add a Layout row:

```markdown
| `lib/notifications/` | `messages.ts` (pure: what each notice says and to whom), `notify.ts` (the one writer, `safeNotify` for post-commit callers), `queries.ts` (bell count, page, mark read), `cron.ts`, `ready.ts`. |
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: notifications built; migration before deploy"
```

- [ ] **Step 5: Hand the user the go-live (PowerShell, one per block).** From a clean master worktree after they merge `feature/notifications`:

```powershell
node scripts/migrate.mjs prod --confirm
```

```powershell
npx.cmd vercel --prod --yes
```

Migration first, then deploy.
