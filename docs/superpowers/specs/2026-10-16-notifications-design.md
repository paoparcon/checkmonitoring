# In-app notifications — design

Date: 2026-10-16. Status: approved in conversation (user, 2026-10-16: "proceed").

## Why

CLAUDE.md, "What is missing", item 4: *"No notifications at all. A failed sync is silent;
nobody is told a check is ready or that a supplier booked a pickup."* Since the register was
retired, a scheduled read that fails means a check does not exist anywhere Finance can see, and
the only signal today is a line on the dashboard or a row on `/admin/sync` that somebody has to
go and look at.

## User rulings (2026-10-16)

1. **Events:** a scheduled sync or the auto-sign run FAILED or REFUSED; a portal outbox event
   PARKED; a check marked READY FOR RELEASE; the sync gone stale.
2. **Channel: in-app only.** No email, no provider, no new secret.
3. **Recipients split by role:** sync/auto-sign failures, stale sync and parked portal events go
   to every active FINANCE_ADMIN; READY FOR RELEASE goes to every active Finance user (both roles)
   except the person who did it.
4. **READY FOR RELEASE notifies once per action**, not once per check and not as a digest.

**Out of reach, said rather than built around:** a supplier booking or confirming a pickup.
Rule 12 — the portal client sends only, and nothing reads from the portal. That notification
waits for the pickup-confirmation follow-up (old Plan 3 Task 6).

## Model

The existing `Notification` table (in the init migration, never written by any code — checked
with `git log -S` and a grep on 2026-10-16) has one `readAt` and no recipient, so it cannot say
who has read what. It becomes **one row per recipient**:

```prisma
model Notification {
  id        String    @id @default(cuid())
  userId    String
  kind      String    // NotificationKind, a string like SyncRun.mode
  message   String
  link      String?   // an in-app path, e.g. /admin/sync
  dedupeKey String?
  checkId   String?
  readAt    DateTime?
  createdAt DateTime  @default(now())

  user  User   @relation(fields: [userId], references: [id])
  check Check? @relation(fields: [checkId], references: [id])

  @@unique([userId, dedupeKey])
  @@index([userId, readAt, createdAt])
}
```

`type` is renamed to `kind`. The migration clears the table first (`DELETE FROM "Notification"`),
because adding the required `userId` column to a table with rows in it would fail. The table has
never been written to, so nothing is lost. Postgres allows several NULLs in a unique index, so
`dedupeKey` only applies when it is set.

A notification is **not** an audit row. It can be marked read, and it carries no amount except
as words in `message`. Nothing deletes notifications, and there is no delete path for users
(rule 6): the `User` relation adds no cascade.

Kinds (`lib/notifications/kinds.ts`):

| kind | audience | link |
| --- | --- | --- |
| `SYNC_FAILED` | admins | `/admin/sync` |
| `AUTO_SIGN_FAILED` | admins | `/admin/sync` |
| `SYNC_STALE` | admins | `/admin/sync` |
| `PORTAL_PARKED` | admins | `/admin/portal` |
| `READY_FOR_RELEASE` | all Finance users except the actor | `/?status=READY_FOR_RELEASE` |

## The writer

`lib/notifications/notify.ts`:

```ts
notify(db, {
  kind, audience: 'ADMINS' | 'FINANCE', message, link?, checkId?, dedupeKey?, excludeUserId?,
}): Promise<number>   // rows written
```

`notify` resolves the audience to the `active` users at that moment (`role = FINANCE_ADMIN` for
ADMINS, every role for FINANCE), drops `excludeUserId`, and writes with
`createMany({ skipDuplicates: true })`, so a repeated `dedupeKey` for the same user writes
nothing. A PENDING or deactivated account (`active = false`) never receives anything.

The messages are built by pure functions in `lib/notifications/messages.ts`, tested without a
database.

## The events

### Sync or auto-sign failed (cron only)

In `app/api/cron/sync/route.ts`, after every result has been collected and before the response
is returned, a pure function `syncFailureNotices(outcomes, bills, billRefs, autoSign)` turns the
results into a list of notices, and the route writes each one with `notify`:

- payments `FAILED` → `SYNC_FAILED`, "Scheduled Acumatica read failed for GOLIVE: <message>"
- payments `REFUSED_NO_WATERMARK` → `SYNC_FAILED`, "… refused for GOLIVE: no watermark — a first
  read must be run from a terminal"
- BILLS / BILL_REFS `FAILED` or a refusal → `SYNC_FAILED`, naming the read (vouchers / PO numbers)
- auto-sign `FAILED` → `AUTO_SIGN_FAILED`, with its error

These are **not** failures and send nothing: `RAN`, `IN_PROGRESS`, `SKIPPED_PAYMENT_NOT_RUN`,
`SKIPPED_TIME_BUDGET`, and auto-sign `OK` / `IDLE` / `DISABLED`. A run that fails at 12:00 and
again at 18:00 notifies twice, which is correct: it failed twice. The notices have no
`dedupeKey`.

A failed manual SYNC NOW does not notify, because the person who pressed it sees the error on
screen.

### Sync is stale (cron only)

Also in the cron route: each tenant's last successful read comes from `getSyncOverview`, as on
the dashboard, and is checked with `describeStaleness` against `sync.staleAfterHours`. Each stale
tenant gets `SYNC_STALE` with `dedupeKey = stale:<tenant>:<lastReadAt ISO | never>`, so one stale
stretch notifies once, and the next stretch (after a successful read) notifies again.

**Known limit:** if the cron itself stops running, nothing runs this check. The dashboard's
stale line remains the backstop for that case, and the spec says so rather than inventing a
second scheduler.

### Portal event parked

In `settle` (`lib/sync/portal-outbox.ts`), inside the transaction that sets `status = PARKED`:
`PORTAL_PARKED`, "Portal event <kind> for check <number> parked: <lastError>", `checkId` set,
`dedupeKey = parked:<eventId>`. Being in the same transaction means the notification exists
exactly when the parked state does. `settle` runs from the cron, from `/admin/portal` and from
action kicks; all three are covered. The "check no longer exists" parking path goes through
`settle` with `flagCheck = false` and notifies too (with no `checkId`).

`notify` is called with the transaction client, so a failed write rolls back the settle, and the
event stays IN_FLIGHT until its claim lapses and the next run retries it. That is the one place
a notification can affect the work. It is accepted because the alternative (a parked event that
no one is told about) is the exact failure this feature exists to remove.

### Check marked READY FOR RELEASE

- **`readyForReleaseAction`** (single check, `app/checks/actions.ts`): after a successful
  `markReadyForRelease`.
- **`bulkReadyForReleaseAction`** (the list and AGING, `app/checks/bulk-actions.ts`): after
  `runEach`, over the outcomes with `ok: true` only. If none succeeded, nothing is sent.

One notification per action, to every active Finance user except the actor:
"<actor name> marked 12 checks READY FOR RELEASE — PHP 1,234,567.89". For a single check:
"<actor name> marked check 6000354012 READY FOR RELEASE — PHP 12,500.00". Amounts are totalled
**per currency**, as decimal strings (rule 8) using `Prisma.Decimal` and shown with
`formatMoney`. A check with no amount cannot reach READY FOR RELEASE (the guard requires one).
The total is read back from the database for the checks that moved, not taken from the form.

**Not notified:** `reverseRelease` (RELEASED → READY_FOR_RELEASE is a correction an admin is
already looking at), `lib/admin/acumatica-reconcile.ts` and the one-off scripts.

## Failure isolation

The cron and the server actions call `notify` **after** their own work has committed, inside a
`try/catch` that logs and moves on (`safeNotify` in `lib/notifications/notify.ts`). A
notification that cannot be written never turns a release, a ready action or a cron run into a
failure, and never changes the cron's HTTP status. The parked-event path is the deliberate
exception, explained above.

## Where users see them

- **The bell** in `AppHeader`: "NOTIFICATIONS" with the unread count (`3`), linking to
  `/notifications`. The count comes from `countUnread(db, userId)`, one indexed count on each
  page render, with no polling and no client JavaScript. `AppHeader` becomes an `async` server
  component that runs the count itself, so none of the pages that render it change. (No client
  component imports `AppHeader`; checked 2026-10-16.) If the count query throws, the bell shows
  no number rather than breaking the page.
- **`/notifications`** (`requireUser()`): the user's own notifications, newest first, the newest
  200. Unread rows are bold. Each row has its time (Manila), its message, and OPEN when it has a
  link. OPEN posts `openNotificationAction(id)`, which marks that row read (only when it belongs
  to the session's user) and redirects to its `link`. MARK ALL READ posts
  `markAllReadAction()`, an `updateMany` over the user's unread rows. An `id` that is not the
  user's is refused as not found, so one user cannot read or mark another's.
- `link` is always written by the app from the fixed table above. The redirect still accepts
  only a path that starts with `/` and not `//`, so a stored value can never send a user off-site.

## Testing (narrow files, the shared TEST database)

- `tests/notifications/messages.test.ts`: pure. Each message's wording, the per-currency total,
  `syncFailureNotices` (which outcomes notify and which do not).
- `tests/notifications/notify.test.ts`: the audience (admins vs everyone), inactive and pending
  users excluded, `excludeUserId`, dedupe.
- `tests/notifications/queries.test.ts`: `countUnread`, `listNotifications`, mark one (the owner
  only) and mark all.
- `tests/actions/notification-actions.test.ts`: OPEN refuses another user's row and an
  off-site link.
- `tests/sync/portal-outbox.test.ts` (extended): a parked event writes one `PORTAL_PARKED` per
  admin, and a re-park of the same event writes nothing more.
- `tests/sync/cron-route.test.ts` (extended): a FAILED tenant notifies the admins; a RAN run does
  not; a stale tenant notifies once across two runs.
- `tests/actions/bulk-actions.test.ts` (extended): one notification for a batch, the actor
  excluded, failures not counted, nothing sent when nothing moved.

Then `npx tsc --noEmit` and `next build`.

## Go-live

Migration `<timestamp>_notification_recipients` must reach production **before** the deploy,
because `AppHeader` queries the new column on every page.
