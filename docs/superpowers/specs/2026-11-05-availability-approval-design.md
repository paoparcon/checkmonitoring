# Availability changes are approved by one person — design

**Date:** 2026-11-05 · **Requested by:** the user (Paolo Parcon), the same day ·
**Status:** approved in conversation, being built on `feature/availability-approval`.

## 1. What happened, and what was asked

On 2026-11-04 Finance moved 40 checks off the release list in two ways, and the
Supplier Portal learned of none of them:

- 36 READY FOR RELEASE checks were ticked on the list and **MARK SIGNED** was
  pressed. The ladder permits READY_FOR_RELEASE → SIGNED (it is REVERT TO
  SIGNED's edge), so `markSigned` accepted them, wrote SIGNED, kept the pickup
  date and queued nothing. The portal kept listing all 36 as available and
  reminded the suppliers seven times.
- 4 RELEASED checks were reversed to SIGNED; the REVERT reached the portal,
  whose deployed code ignores a REVERT on a released bill (separate task).

The user's ruling: *"all should be approved by Paolo Parcon … only for the
checks available for release. I want to have control in this because these are
also communicated in the supplier."* Three decisions taken the same day:

1. **One named approver**, chosen on `/admin/settings`; nobody else approves,
   not even another FINANCE_ADMIN.
2. **The approver's own actions apply at once.** Only other users' changes wait.
3. **Both directions wait**: making a check available (SIGNED →
   READY_FOR_RELEASE) and taking it back (READY_FOR_RELEASE / SCHEDULED →
   SIGNED). Both are told to the supplier.

## 2. Scope

**Gated** — every path that makes a check available or withdraws it:

| Path | Today | Now |
| --- | --- | --- |
| Check page MARK READY FOR RELEASE | `markReadyForRelease` | gate |
| List bulk MARK READY FOR RELEASE, AGING's MARK READY | `bulkReadyForReleaseAction` | gate |
| `/admin/import` READY FOR RELEASE upload | `applyReadyUpload` → `markReadyForRelease` | gate per row |
| Check page REVERT TO SIGNED | `revertAvailability` | gate |
| List bulk REVERT TO SIGNED | `bulkRevertToSignedAction` | gate |

**Not gated**, stated so nobody looks for it: MARK RELEASED and RELEASE ALL
(`markReleased`, `releaseDirectly` — the physical hand-over, Finance-only,
already a confirmation step of its own); REVERSE RELEASE (FINANCE_ADMIN only,
its own reason and destination); MARK SIGNED / REVERT TO PENDING / RESTORE
(not told to the supplier); the one-off catch-up scripts
(`mark-ready-from-release-list.ts`, `release-list.ts`), which set status
directly and are not the routine path.

**Closed with it:** `markSigned` now refuses every status but
SIGNATURE_PENDING and GENERATED. It was the bypass: with the gate in place a
MARK SIGNED on a READY check would still have withdrawn it unapproved and
untold. The ladder keeps the READY → SIGNED edge; only `revertAvailability`
walks it.

## 3. The approver is a setting

`approval.availabilityApprover` — a new setting kind `user`, group APPROVAL,
label "AVAILABILITY CHANGES ARE APPROVED BY". The stored text is a user id; the
screen shows a dropdown of active users plus NOBODY. Default: nobody, which
means **no approval step** — every action applies at once, exactly as before
this spec. `loadApprover(db, settings)` resolves the id to an active user; an
id that names a deactivated or missing user counts as nobody and the settings
screen says so (the gate must never queue requests nobody can decide).

The approver is set once, by a FINANCE_ADMIN, after the deploy. It is a
setting and not a hard-coded account because the person will change one day
and the code must not.

## 4. The request

A new table, `AvailabilityRequest`:

| Column | Meaning |
| --- | --- |
| `checkId` | the check; at most ONE PENDING request per check (partial unique index) |
| `kind` | `MAKE_AVAILABLE` or `WITHDRAW` |
| `status` | `PENDING`, `APPROVED`, `REJECTED` |
| `requestedById`, `requestedAt` | who asked, when |
| `availablePickupDate` | MAKE_AVAILABLE: the date the requester typed (required by the same guard as today) |
| `reason` | WITHDRAW: the requester's reason (required, as REVERT TO SIGNED requires it) |
| `source` | the upload's file / sheet / row / bill, when the request came from a list |
| `decidedById`, `decidedAt`, `decisionNote` | the approver's verdict; REJECT requires a note |

**The check does not move while a request is pending.** A SIGNED check stays
SIGNED, a READY check stays READY, the portal hears nothing, no `readyAt` /
pickup date is written. The request is the only record, plus one audit row
`availability_requested` on the check (details: kind, pickup date or reason,
source, requestId).

**Requesting runs the same refusals as applying.** A MAKE_AVAILABLE request
runs `checkReadyForRelease` (missing amount, payee, account, date — refused at
request time, in the requester's face, not days later at approval); a WITHDRAW
request requires a reason and a READY / SCHEDULED check. A second request on a
check with one pending is refused (`APPROVAL_PENDING`). A request on a check
whose status is not the request's starting rung is refused by the ladder.

## 5. The gate

`lib/domain/availability-approval.ts`, taking `db` like `actions.ts`:

```
applyOrRequest(db, { kind, checkId, actor, approver, now, availablePickupDate?, reason?, source? })
  → { applied: true, check } | { applied: false, request }
```

- `approver === null` (nobody set) or `actor.id === approver.id` → apply:
  `markReadyForRelease` / `revertAvailability` exactly as today.
- otherwise → `requestAvailabilityChange`.
- either way, a check with a request PENDING is refused (`APPROVAL_PENDING`):
  the approver decides the request on `/approvals` rather than acting past
  it, so no request is left standing on a check that has moved.

The server actions and the upload call the gate and report which happened.
Bulk results say `N request(s) sent to <approver> for approval` rather than
`N marked`.

## 6. Deciding

`approveAvailabilityRequest(db, { requestId, approverId, now })` — the caller
must be the approver in force (the action checks; the domain checks again
against the setting it reads inside the transaction). Loads the PENDING
request, then applies the domain action **as the approver**: `readyById` /
the `ready_for_release` audit actor is the approver, because that is who
caused the message to the supplier; the audit row's details carry
`{ approval: { requestId, requestedById, requestedAt } }`, so the trail reads
"approved by Paolo, requested by X". The request becomes APPROVED; one
`availability_approved` audit row. The portal event is queued by the domain
action as today; the server action kicks delivery and `notifyReady` tells the
others as today (the actor is the approver).

A check that moved since the request (released at the counter, cancelled)
makes approval refuse with the current status in the message
(`REQUEST_STALE`); the approver rejects it with that as the note. Nothing is
auto-closed: a request is closed only by a person.

`rejectAvailabilityRequest(db, { requestId, approverId, note, now })` — note
required; the request becomes REJECTED; one `availability_rejected` row; the
check is untouched.

**Who decides** (`canDecide`, `lib/approvals/approver.ts`): the approver in
force, and nobody else — not another FINANCE_ADMIN. The one exception: while
NOBODY is set, a FINANCE_ADMIN may decide the requests left over from a
cleared or deactivated approver, because otherwise they could never be closed
(a request is closed only by a person). Changing the approver leaves pending
requests pending; the new approver decides them.

## 7. Screens

- **`/approvals`** (every Finance user; `module-nav` lists it under CHECK
  RELEASE). PENDING requests: check number, payee, amount, company, kind,
  pickup date or reason, requested by / at, the check's CURRENT status. The
  approver sees APPROVE and REJECT (note) per row and APPROVE SELECTED /
  REJECT SELECTED over ticked rows (capped by `caps.bulkSelection`, one
  transaction per request, `runEach`). Everyone else sees the list read-only
  and who the approver is. Decided requests are listed below, newest first,
  last 50.
- **Check page.** With a pending request: a WAITING FOR APPROVAL panel
  (kind, date or reason, requester, when) replaces the MARK READY / REVERT
  TO SIGNED forms; the approver gets APPROVE / REJECT there too. Without one,
  for a non-approver while an approver is set, the buttons read **REQUEST
  READY FOR RELEASE** / **REQUEST REVERT TO SIGNED** and the success copy says
  the request went to the approver by name.
- **List bulk bar** gets `approvalRequired` and relabels the same two
  buttons; the confirm prompts say "request".
- **Dashboard TOTALS**: one line under the workflow row, `N AVAILABILITY
  CHANGE(S) WAITING FOR APPROVAL → OPEN`, shown when N > 0.
- **Header**: an APPROVALS link beside NOTIFICATIONS on every page, with the
  pending count as a badge, so the approver finds the page with nothing else
  prompting them.
- **Upload report** gains `requested` beside `readied`, and the page copy
  says requests went to the approver.
- **Settings**: the new row, with the dropdown.

## 8. Notifications

Two kinds, both to one user (a new audience `USER` with `userId`):

- `APPROVAL_REQUESTED` → the approver: "X requests READY FOR RELEASE for
  check N (pickup D)" / "X requests REVERT TO SIGNED for check N: reason".
  Link `/approvals`. Bulk: one notice per batch, "X requests READY FOR
  RELEASE for 12 checks: ₱…".
- `APPROVAL_DECIDED` → the requester: "Paolo approved / rejected your request
  for check N" (+ the note). Link to the check.

Written after the action committed through `safeNotify`, never failing it.
The READY FOR RELEASE notice to everyone else is unchanged and fires on
approval (or on the approver's own direct action).

## 9. Audit

`availability_requested`, `availability_approved`, `availability_rejected`,
all USER rows on the check. The `ready_for_release` / `reverted_availability`
rows written on approval carry `details.approval`. `writeAudit` stays the one
writer.

## 10. Migration and deploy

`20261105000000_availability_request`: the table, its enums, and the
one-pending-per-check guarantee as a unique index on `(checkId, pendingKey)`
where `pendingKey` is `'PENDING'` while open and null once decided — Prisma
cannot declare a partial unique index, and a `migrate dev` would drop one
written by hand — plus indexes on `(status, requestedAt)` and `requestedById`. It must reach production BEFORE the deploy (the check page,
dashboard and header read the table on every request). After the deploy a
FINANCE_ADMIN picks the approver on `/admin/settings`; until then nothing is
gated and the screen says so.

## 11. Tests

- `tests/domain/availability-approval.test.ts`: request (both kinds), refusals
  (guard, reason, pending duplicate, wrong rung), approve (status moves, portal
  event queued, audit actor is the approver with `details.approval`, request
  APPROVED), approve refused for a non-approver and for a stale request,
  reject (note required, check untouched), the gate (nobody set → applied;
  approver acting → applied; other → request).
- `tests/actions/actions.test.ts` (+1): `markSigned` refuses READY_FOR_RELEASE,
  SCHEDULED, RELEASED, CANCELLED.
- `tests/settings/registry.test.ts`: twelve knobs; the user kind parses an id
  and formats nobody as the empty string.
- `tests/notifications/messages.test.ts`: the two new notices.
- `tests/admin/ready-upload.test.ts` (+1): a non-approver's upload requests.
