# Check Monitoring → Supplier Portal integration — design

Date: 2026-09-26. Canonical copy lives in the Supplier Portal repo
(`docs/superpowers/specs/2026-09-26-check-monitoring-integration-design.md`); the Check
Monitoring repo carries an identical copy at the same path. Both must change together.

## Goal

When Finance changes a cheque in Check Monitoring (`checkmonitoring.rclcompanies.com`), the
Supplier Portal (`supplier-portal.rclcompanies.com`) reflects it without anyone re-encoding
it: **ready for release → available for pickup**, **released → picked up**, plus the
corrections (availability withdrawn, release reversed, cancelled/voided).

Direction is one way, Check Monitoring → Supplier Portal. Check Monitoring is the record for
these events (user ruling 2026-09-26). The supplier's *planned* pickup confirmation flowing
back (Plan 3 Task 6 in Check Monitoring) is a follow-up, not this design.

## What already exists

- Check Monitoring writes a `PortalEvent` outbox row **in the same transaction** as every
  status change in `lib/domain/actions.ts`: `MARK_AVAILABLE`, `RELEASED`, `REVERT`,
  `RELEASE_REVERSED`. Rows have been queuing as `PENDING` in production since Plan 3 paused
  (2026-09-04). Nothing drains them. `cancelCheck` / `voidCheck` queue nothing.
- Check Monitoring's Plan 3 (`docs/superpowers/plans/2026-09-04-portal-automation.md`)
  designed a worker that logs in to the portal by **session cookie as an `encoder` service
  account** and calls three existing portal routes. It stalled because that account does
  not exist and the client would have to learn portal ids.
- The Supplier Portal has no inbound machine auth except the cron bearer
  (`/api/cron/*`, `CRON_SECRET`, constant-time compare). Its session is a stateless HMAC
  cookie (`src/auth/session.js`). Checks become available today only through the Excel
  "Checks Available Summary" import (`POST /api/checks/import`, matched on APV/PO) and
  picked up only when an encoder sets `status = RELEASED` by hand.

## Decision

Finish the push. Keep the outbox, replace the auth, and give the monitoring side **one**
portal endpoint that matches on APV so it never needs portal ids.

Rejected: a pull feed (would orphan the outbox or need an ack protocol); a shared database
(couples schemas, no audit); session-cookie login (a human-style account for a machine,
plus login/expiry handling for nothing).

## Part 1 — Supplier Portal

### 1.1 Service identity

Migration `069_check_monitoring_service.sql` inserts `app_user` row `check-monitoring`
(role `admin`, `admin_tier = 'encoder'`, `active = true`, `password_hash = '!'` so no
password can ever verify; `on conflict (username) do nothing`). Every change the
integration makes carries this user's id in `updated_by` and `audit_log.user_id`, so the
history reads "check-monitoring" instead of a person (Plan 3's decision D6, satisfied
without a login).

Auth is `Authorization: Bearer <CHECK_MONITORING_TOKEN>` via a new middleware
`requireServiceToken` in `src/auth/service.js`:

- env unset → 503 `{ error: 'integration not configured' }` (never open by default);
- header mismatch → 401 (constant-time compare, same as the cron routes);
- match → resolves the `check-monitoring` user (503 if the migration has not run, so a
  half-deployed portal refuses rather than acting as nobody) and sets `req.session = { userId, username, role: 'admin', service: true }`.

The cookie middleware is untouched; the service route is registered separately. The token
is a 64-hex random string the user generates once and sets in both Vercel projects.

### 1.2 Endpoint

`POST /api/integrations/check-monitoring/events` — one event per request.

```jsonc
{
  "eventId": "cuid",                 // PortalEvent.id — idempotency key
  "kind": "MARK_AVAILABLE | RELEASED | RELEASE_REVERSED | REVERT | CANCELLED",
  "apvs": ["APV-000123", "..."],     // Check.apvNumbers — a cheque may pay several bills
  "poNumbers": ["PO-ST-000123"],     // optional fallback keys, same order-insensitive set
  "checkNo": "6000353106",
  "bank": "BPI",                     // bank code; portal stores "checkNo · BANK"
  "availablePickupDate": "2026-09-30", // Manila date, MARK_AVAILABLE + RELEASE_REVERSED
  "releaseDate": "2026-10-02",       // Manila date, RELEASED
  "orNumber": "12345", "orDate": "2026-10-02" // optional, RELEASED
}
```

Validation (400): `eventId` non-empty string; `kind` in the list; `apvs` non-empty array
of strings (≤ 50); dates `^\d{4}-\d{2}-\d{2}$` where present. No `reason` field: the
encoder's reason is internal on both sides and never travels.

Matching reuses the import matcher, extracted from `src/checks/import.js` into
`resolveRefs(pool, refs)` so both callers share it: `upper(trim())`, APV first then PO,
`trade` wins over `broker_transaction` on a double match. Each matched APV yields one
`(domain: local|broker, parentId)`; the handler applies the kind to each.

Response 200:

```jsonc
{ "eventId": "...", "replay": false,
  "results": [ { "ref": "APV-000123", "domain": "local", "releaseId": 41, "outcome": "applied" } ],
  "unmatched": ["APV-000999"] }
```

`outcome` ∈ `applied | already | noop | refused` (with `reason` on `refused`). The
request is 200 whether or not anything matched; the caller reads `results` / `unmatched`.
Only auth, validation and a thrown store error produce non-200.

### 1.3 Kind → portal action

All through the existing store functions (`src/checks/store.js`, `broker-store.js`), so
notifications, the notify-once latch, audit and SOA settlement behave exactly as when an
encoder does the same thing in the UI. Every handler is idempotent and reads the row's
*current* state; `already` means the row is already where the event wants it.

| kind | local action | already / noop / refused |
| --- | --- | --- |
| `MARK_AVAILABLE` | `markAvailable({ tradeIds, pickupDate: availablePickupDate, checkNumbers })` — revives a `CANCELLED` row (`fromImport`), one email per supplier | already: `AVAILABLE_FOR_RELEASE` or `RELEASED` |
| `RELEASED` | `getOrCreateCheckRelease` then `updateCheckRelease({ status: 'RELEASED', releaseDate, orNumber, orDate, checkNumber })` — stamps `released_at`, settles SOAs | already: `RELEASED`; refused: `CANCELLED` (the portal's cancellation is terminal; a human resolves) |
| `RELEASE_REVERSED` | `updateCheckRelease({ status: 'AVAILABLE_FOR_RELEASE', releaseDate: availablePickupDate })` — clears `released_at` | noop: not `RELEASED`; refused: `CANCELLED` |
| `REVERT` | `updateCheckRelease({ status: 'REVERTED_FOR_REUPLOADING' })` (Plan 3's reading: withdrawn for re-upload). Since 2026-11-03 a `RELEASED` row is first un-released (release cleared, silently) and then withdrawn — Check Monitoring's REVERSE RELEASE to SIGNED sends one REVERT, because its outbox keeps only the newest message per cheque | noop: not `AVAILABLE_FOR_RELEASE` or `RELEASED` |
| `CANCELLED` | new `cancelDirect({ id })`: the body of `approveCancel` without the request precondition — sets `CANCELLED`, clears release/pickup/latch columns, audit `check_cancel_service`, tells the payee only if `notified_at` was set | already: `CANCELLED` |

Broker twins for every row (`markBrokerAvailable`, `updateBrokerCheckRelease`,
`cancelBrokerDirect`). Void-after-release in monitoring arrives as `CANCELLED` and, as in
the UI's cancellation, the portal's paid status reverts (paid derives from `RELEASED`).

What the endpoint deliberately does **not** do: missed-pickup reminders and revert
candidates. Both belong to the full-file Excel import ("what the file left out"); an event
about one cheque carries no such information.

### 1.4 Idempotency and audit

Migration `069` also creates `integration_event (event_id text primary key, source text,
kind text, received_at timestamptz, result jsonb)`. The handler inserts the row *after*
applying; a replayed `eventId` returns the stored `result` with `replay: true` and applies
nothing. The store functions are themselves idempotent, so a crash between apply and
insert costs nothing on retry.

One `audit_log` row per accepted event: action `check_monitoring_event`, entity
`integration_event`, `entity_id = eventId`, `after = result`, user = service user — on top
of the rows the store functions already write.

### 1.5 What stays

The Excel "Checks Available Summary" import and manual RELEASED remain as the fallback;
nothing in the UI changes. Encoders keep the ability to correct a row by hand; the next
event for that cheque is applied against whatever state they left.

## Part 2 — Check Monitoring

### 2.1 Schema

Migration adds `CANCELLED` to `PortalEventKind`. `cancelCheck` and `voidCheck` queue a
`CANCELLED` event when `portalRoute(eligibility)` is non-null — including the Acumatica
void from `lib/import/upsert.ts`, which is the one status change an import may make.
Payload: `{ action: 'CANCELLED', checkNumber }`.

### 2.2 Client — `lib/integrations/portal/client.ts`

`deliver(event, check, { baseUrl, token, fetchImpl })` builds the body from the cheque
**at delivery time** (`apvNumbers`, PO numbers from its `CheckBill` rows if present, cheque
number, bank code from `cashAccount.bank.code` or `checkBook.bank.code`, the dates from the
payload as Manila `YYYY-MM-DD`), asserts `portalRoute(check.eligibility) !== null` before
building anything (rule 2: an INTERNAL cheque never produces a portal call — the second,
independent check), and POSTs with the bearer. `baseUrl` and `token` come from
`PORTAL_BASE_URL` / `PORTAL_TOKEN` in env. Tests inject `fetchImpl`; no live calls.

### 2.3 Worker — `lib/sync/portal-outbox.ts`

`deliverPortalEvents(db, { now, deadline, fetchImpl })`:

1. **Latest wins per cheque.** Among `PENDING`/`FAILED` events eligible now
   (`nextAttemptAt <= now`), only the newest per `checkId` is delivered; older ones are
   marked `SYNCED` with `lastError = 'superseded by <id>'`. The portal is told the cheque's
   current truth, not its history — this is what makes the six-week backlog safe to drain:
   a stale `MARK_AVAILABLE` for a cheque since released must not email a supplier "ready
   for pickup" seconds before "picked up".
2. **Claim** with a conditional `updateMany` (`status → IN_FLIGHT`, `claimedAt`,
   `claimedBy`) so two runs cannot deliver the same event.
3. **Deliver.** On 200, in this precedence:
   - any `refused` → `PARKED` immediately with the reason (`portalSyncStatus = FAILED`);
   - otherwise nothing matched (`results` empty, `unmatched` non-empty) → `FAILED`, retry
     **daily** for 7 days (the portal receives bills from Acumatica nightly; a cheque can
     precede its bill), then `PARKED`;
   - otherwise → `SYNCED`, `Check.portalSyncStatus = SYNCED`, `portalTradeId` learned from
     the first `releaseId`; any partial `unmatched` list is kept in `lastError` for the
     admin page.
4. **Errors.** Network error / 5xx / 503 (portal not configured) → `FAILED` with backoff
   1 m, 5 m, 30 m, 2 h, then daily; `PARKED` after 12 attempts. 401 → `PARKED` (token
   wrong; every event would fail the same way). 400 → `PARKED` (payload defect).
5. Stops at `deadline`; whatever is left waits for the next trigger.

Final review 2026-09-26 added: a winner whose kind contradicts the cheque's current status
is closed unsent as **stale** (rule in §2.5); a lost supersede freezes that cheque for the
run, as a live claim does; a 401 parks the one event and stops the run (every event would
fail the same way); each request carries a timeout of min(remaining budget, 10 s), never
below 1 s, and an abort backs off like any network error.

`PARKED` is the human's queue. Every transition writes the existing `AuditLog` row shape
(`actorType: SYSTEM`, action `portal_event_<status>`).

### 2.4 Triggers

- **Immediately after an action:** `app/checks/actions.ts` and `bulk-actions.ts` schedule
  `deliverPortalEvents` with an ~8 s deadline through Next's `after()`, so the user's
  response is not held and a portal outage never fails the Finance action.
- **Daily cron** `/api/cron/sync` runs it after auto-sign with the remaining budget; this
  is what retries backlog and unmatched events.
- **Admin page `/admin/portal`** (FINANCE_ADMIN): counts by status, the `PARKED` and
  `FAILED` rows with cheque, kind, attempts, last error; actions *Retry* (→ `PENDING`,
  `nextAttemptAt = now`) and *Deliver now*. Minimal — no filters, no export.

### 2.5 Backlog cutover

Before the first production delivery, with Check Monitoring deployed but its
`PORTAL_BASE_URL` / `PORTAL_TOKEN` still **unset** (every kick returns `{ skipped }`, so
nothing can go out during the review): `npx.cmd tsx scripts/portal-backlog.ts` counts the
open events, applies latest-wins as a dry run and prints the winners — kind, cheque, payee,
current status and a `stale` column, no amounts. Expected: mostly `RELEASED` for cheques the
portal already shows as picked up (→ `already`) and `MARK_AVAILABLE` for the currently ready
ones.

`stale` (final review 2026-09-26) marks a winner whose kind contradicts the cheque's current
status; the worker closes such a row unsent (`SYNCED`, `lastError = 'stale: cheque is now
<status>'`, audit `details.stale = true`). The rule, `kindMatchesStatus` in
`lib/sync/portal-outbox.ts`: `MARK_AVAILABLE` / `RELEASE_REVERSED` need `READY_FOR_RELEASE`
or `SCHEDULED`; `RELEASED` needs `RELEASED`; `REVERT` needs `GENERATED`,
`SIGNATURE_PENDING` or `SIGNED`; `CANCELLED` needs `CANCELLED` or `VOIDED`. Before this
branch cancel/void queued nothing, so the backlog holds `MARK_AVAILABLE` rows for cheques
since cancelled or voided — closing them stale is right, but the portal would then never
hear of the cancellation. `scripts/portal-backlog.ts --queue-cancelled` counts those cheques
(portal-routed, `CANCELLED`/`VOIDED`, an open `MARK_AVAILABLE`, no `CANCELLED` event); with
`--apply` it queues one `CANCELLED` event each (a SYSTEM `portal_event_backfilled` audit row
per cheque, same transaction; idempotent). Run it only once the user has agreed.

Then set the two env vars, redeploy, press DELIVER NOW on `/admin/portal`; the cron drains
the rest.

## Sequencing

Rewritten after the final review (2026-09-26) so the token cannot be live before the backlog
has been reviewed; the plan's Task 7 Step 7 is the same list.

1. **Supplier Portal side live:** migration 069, service auth, endpoint, tests → deploy +
   migrate prod; generate the token and set `CHECK_MONITORING_TOKEN` there.
2. **Check Monitoring enum:** `npx.cmd prisma migrate deploy` on production (adds
   `CANCELLED`).
3. **Deploy Check Monitoring with `PORTAL_BASE_URL` / `PORTAL_TOKEN` UNSET.** Kicks return
   `{ skipped }`; nothing can go out; new cancellations already queue `CANCELLED`.
4. **Backlog review on production** (§2.5): `scripts/portal-backlog.ts`, winners and the
   `stale` column reviewed with the user; `--queue-cancelled` dry run and, if agreed,
   `--apply`.
5. **Set `PORTAL_BASE_URL` and `PORTAL_TOKEN`** (monitoring, Vercel Production) and redeploy.
6. **`/admin/portal` → DELIVER NOW**; the daily cron finishes the rest.

## Testing

**Supplier Portal** (`node:test`, pg-mem): 503 without env, 401 on bad token, 200 as the
service user; each kind against local and broker parents in each starting state
(applied/already/noop/refused); `MARK_AVAILABLE` emails once per supplier and revives a
cancelled row; `RELEASED` settles the SOA; `CANCELLED` tells a notified payee and not an
un-notified one; replayed `eventId` applies nothing; `unmatched` reported and the matched
ones still applied; audit rows carry the service user; the extracted matcher keeps
`test/checks-import*.test.js` green.

**Check Monitoring** (Vitest, real test DB, injected fetch): payload built from the cheque,
INTERNAL cheque throws before any fetch; `cancelCheck` / `voidCheck` queue `CANCELLED`
only for portal-routed cheques; latest-wins supersedes; claim is exclusive; each response
class lands on the specified status and backoff; deadline stops the run; the cron route
reports the worker outcome; `/admin/portal` is admin-only. `npx tsc --noEmit` clean.

## Out of scope

Pickup confirmations flowing back to Check Monitoring (`SCHEDULED`); a pull/reconciliation
feed; removing the Excel import; staff email.

## Addendum 2026-10-02: the RECEIPT kind and outbox lanes

A new outbox kind, `RECEIPT`, carries the supplier's receipt (OR/CR reference, type, optional
amount, optional scanned file) to the portal. Latest-wins from section 2.3 now runs per **lane**,
two per cheque:

- **Status lane:** MARK_AVAILABLE, REVERT, RELEASED, RELEASE_REVERSED, CANCELLED.
- **Receipt lane:** RECEIPT.

Supersede happens inside a lane only; a RECEIPT never closes a status event and vice versa.
Ordering: a RECEIPT is held until its cheque's newest status-lane event is SYNCED (delivered,
superseded or closed stale), across runs and while that event is PARKED, so the portal hears
RELEASED before the receipt that goes with it. A RECEIPT settling never writes
`Check.portalSyncStatus` or `portalTradeId`; those belong to the status lane.

Payload: the queued event is a record only (`orNumber`, `amount`, `hasFile`); the body is built
from the cheque at delivery. The amount is `Decimal(18,2)` sent as a 2-decimal string. The file
is at most 3 MB (PDF, JPG or PNG), stored in `CheckReceiptFile` (BYTEA), loaded only for RECEIPT
deliveries and sent base64 inside the request, so a RECEIPT gets a 30 s request timeout and is
not started with less than 6 s left in the run (receipt actions kick with a 25 s budget). An INTERNAL cheque, or one with no APV, queues
no RECEIPT (the receipt stays recorded in Check Monitoring). `attachReceiptFile` adds a missing
amount or file after the receipt exists (add-only, never a replacement). Server actions accept a
4 MB body.
