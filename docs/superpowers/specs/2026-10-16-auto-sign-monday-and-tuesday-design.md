# Auto-sign on Monday and Tuesday

User request and design agreed 2026-10-16. Replaces §A1 of
`2026-10-01-signing-schedule-apv-and-table-design.md` ("Automatic: Monday cheques only"). §A2
(SIGN ALL) and §A3 (REVERT TO PENDING) are unchanged.

## Why

> "Monday - it will be signed on tuesday. The rest of the day, will be signed on Monday."

Measured in production on 2026-10-16: **727 checks at SIGNATURE PENDING**, and growing by roughly
200 a week. The 2026-10-01 rule signs only checks first read on a Monday; Tuesday-to-Sunday checks
wait for SIGN ALL, and **no one has ever signed a check by hand in this system** — there is not a
single `marked_signed` audit row. Most checks are first read on Tuesday and Thursday, so most checks
never sign.

| Week first read | Arrived | Still pending |
| --- | --- | --- |
| 14 Sep | 315 | 0 |
| 21 Sep | 347 | 0 |
| 28 Sep | 383 | 361 |
| 5 Oct | 250 | 159 |
| 12 Oct | 387 | 202 |

The weeks before 28 September were signed by the 2026-09-25 rule (3 calendar days after first
read). The week of 28 September fell between the two rules: its 66 Monday checks were never signed by
either.

Of the 727: 537 Balanced in Acumatica, 185 Closed, 1 a non-check (DEBIT ADV / CASH, never signed),
4 register-only (never auto-signed).

## The rule

Auto-sign runs at the existing cron times, 12:00 and 18:00 Manila (`vercel.json`, unchanged). The
day is the Manila calendar day (UTC+8, no daylight saving).

- **Monday run:** signs every due check first read **before 00:00 Manila that Monday**.
- **Tuesday run:** signs every due check first read **before 00:00 Manila that Tuesday**.
- **Wednesday to Sunday:** IDLE, signs nothing.

"First read" is `Check.createdAt`, as in §A1: Acumatica publishes no creation timestamp.

So a check first read on a Monday is signed on Tuesday; a check first read Tuesday to Sunday is
signed the next Monday. There is no lower bound — **user ruling 2026-10-16: the Monday run signs the
older backlog too** ("Everything older"). The Tuesday run has no lower bound either, which makes it
the retry for anything the Monday runs did not reach: one rule, two days, and nothing a run leaves
behind is stranded.

A check is **due** when all hold — unchanged from §A1 except the date test:

- `status = SIGNATURE_PENDING`
- `acumaticaPaymentId` is set (a register-only check waits for a person)
- `isCheque` (DEBIT ADV and CASH are never signed)
- `acumaticaStatus` is not `Voided` (null is allowed)
- no `signature_reverted` audit row (a person's revert is never undone by the clock)
- `createdAt` is before 00:00 Manila on the run's day, and the run's day is a Manila Monday or Tuesday

Being Closed in Acumatica does not stop a check being signed. Signing is not releasing: the 185
Closed checks become SIGNED, never RELEASED. Their release is a separate question for Finance.

## What a signature writes

As today: `status = SIGNED`, `signedAt = now`, `signedById` null, one `auto_signed` audit row
(`actorType SYSTEM`, no user), no portal event. Rule 4 is untouched — the sync never writes status;
this is the cron's own step.

The `auto_signed` row's `details.rule` becomes `'WEEKLY'` (rows written under §A1 keep `'MONDAY'`),
plus `runDay: 'MONDAY' | 'TUESDAY'`. Its remark names the run day and the check's first-read
instant, e.g. *"Signed automatically at Monday's run: this Acumatica check first reached the app on
2026-10-13T03:12:00.000Z, before that Monday. No one signed it here, so no signing user is
recorded."*

Each run still writes one `auto_sign_run` row (no `checkId`), with the same shape
(`outcome`, `signed`, `skipped`, `enabled`, `error?`).

## Time budget and leftovers

The run's 50 s deadline is unchanged; it is checked before each check, and candidates are signed
oldest first. A run that reaches it records **FAILED** with what is left, and the cron answers 500 —
as today. What the message says comes next changes, because a leftover is never stranded now:

| Run cut off | Message ends |
| --- | --- |
| Monday before 18:00 | `the 18:00 run continues` |
| Monday at or after 18:00 | `Tuesday's run continues` |
| Tuesday before 18:00 | `the 18:00 run continues` |
| Tuesday at or after 18:00 | `next Monday's run continues` |

"At or after 18:00" is `LAST_RUN_UTC_HOUR` in `lib/sync/auto-sign.ts`, tied to `vercel.json`, as now.

**First effect, expected:** Monday 19 October has about 660 checks due. The 13 October 12:00 run
signed 178 inside its budget, so the backlog will probably take two to four runs (Monday 12:00 and
18:00, Tuesday 12:00 and 18:00). Those cut-off runs will show FAILED on `/admin/sync` and make the
cron answer 500 until the backlog clears. That is the honest record of a run that did not finish,
and it is accepted rather than designed away.

## The setting

Key `autoSign.mondayEnabled` is kept, so no stored value moves and no migration is needed. Only its
text changes:

- label: `AUTO-SIGN ACUMATICA CHECKS ON MONDAY AND TUESDAY`
- help: `At 12:00 and 18:00 every Monday, a pending Acumatica check first read before that Monday is
  signed; on Tuesday, one first read before that Tuesday. Monday's checks are therefore signed on
  Tuesday, and the rest on the next Monday.`

`1` on, `0` off, default `1`, as now.

## Screens

`/admin/sync`, LAST AUTO-SIGN:
- never run: *"Auto-sign has not run yet. It runs at 12:00 and 18:00 Manila, after the sync, and
  signs on Mondays and Tuesdays."*
- IDLE: *"not a Monday or Tuesday — nothing due"*
- OK: *"N check(s) signed"* (was "N Monday check(s) signed"). A run recorded under the
  2026-09-25 days rule keeps its own wording (`legacyDays`).

The check page (`AUTOMATIC` as the signer), SIGN ALL, REVERT TO PENDING and the bulk bar are
unchanged.

## Code

- `lib/domain/auto-sign.ts` (pure): replace `isManilaTuesday` / `mondayWindow` with
  `autoSignRunDay(now): 'MONDAY' | 'TUESDAY' | null` and `signingCutoff(now): Date` (00:00 Manila on
  `now`'s day). `isDueForAutoSign` tests `createdAt < signingCutoff(now)` on a run day.
- `lib/sync/auto-sign.ts`: `listAutoSignCandidates` uses `createdAt: { lt: cutoff }` on a run day;
  `runAutoSign` is IDLE when `autoSignRunDay` is null; `leftoverFate` per the table above.
- `lib/domain/actions.ts` `autoSign`: the new `details` and remark.
- `lib/settings/registry.ts`, `lib/settings/defaults.ts`: label, help, comment.
- `app/admin/sync/page.tsx`: the three texts above.
- `app/api/cron/sync/route.ts`: its header comment.
- `CLAUDE.md`: the auto-sign paragraph under "What is missing".

## Tests

Pure (`tests/domain/auto-sign.test.ts`): run day is the Manila day at both edges; Monday's cutoff
(Sunday 23:59:59.999 signed, Monday 00:00 not); Tuesday's cutoff (Monday 23:59:59.999 signed,
Tuesday 00:00 not); an old backlog check is due on both days; nothing is due Wednesday to Sunday;
off, reverted, null Acumatica status, other statuses, register-only, non-check and Voided as now.

Database (`tests/sync/auto-sign.test.ts`, `tests/actions/auto-sign.test.ts`,
`tests/sync/cron-route.test.ts`): Monday's run lists and signs last week's and older checks but not
Monday's own; Tuesday's run signs Monday's and a Monday leftover but not Tuesday's; IDLE on
Wednesday; the four leftover messages; the new `details` and remark; the cron signs on a Monday.
`tests/settings/registry.test.ts`: the label.

## Out of scope

Holidays; a different cron time; marking Closed-in-Acumatica checks RELEASED; the 4 register-only
pending checks; the one pending non-check.
