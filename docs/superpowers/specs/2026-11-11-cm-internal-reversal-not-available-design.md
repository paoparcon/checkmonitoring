# An INTERNAL check un-released in Check Monitoring is not available in the portal

**Date:** 2026-11-11 · **Status:** built; portal migration 097 and the portal deploy first, then nothing on the Check Monitoring side needs deploying (comments and this file only).

This file is kept identical in both repositories: Supplier Portal (`prop-db/Supplier-Database`) and Check Monitoring (`RCL PROJECTS/Check Monitoring`).

## What was wrong

Measured 2026-11-11 against production: Check Monitoring's dashboard said **106 checks READY FOR RELEASE (₱5,847,506.53)**; the portal's Check Availability tile said **109 CHECKS AVAILABLE**. All 106 are in the portal. The three extra are `6000363516` (STK, AP-ST045586), `6000363517` (HAMFI, AP-HF002250) and `6000363518` (STK, AP-ST045588): INTERNAL checks, SIGNED in Check Monitoring.

On 2026-11-09 at 15:48 Manila a Finance user signed, readied and released the three in one action, then reversed each release six minutes later with the destination SIGNED. Check Monitoring sent the portal RELEASED and then RELEASE_REVERSED, both flagged `internal: true` (rule 2: an INTERNAL check is sent only RELEASED, RELEASE_REVERSED and CANCELLED, never MARK_AVAILABLE or REVERT). The portal's RELEASE_REVERSED case, written under spec `2026-10-19-cm-internal-release-quiet` ("the row goes back to AVAILABLE_FOR_RELEASE, so the bill ages again"), set the rows to AVAILABLE_FOR_RELEASE — quietly, nobody notified — and the Checks Available tile counts every row at that status, internal or not.

An internal bill never legitimately holds AVAILABLE_FOR_RELEASE in the portal: Check Monitoring never sends MARK_AVAILABLE for one, so no payee is ever told to collect it. The status was reached only through an undo. The 2026-10-19 goal — the bill ages again — holds on any status but RELEASED (`src/data/paid.js`), so it did not need AVAILABLE_FOR_RELEASE.

## The rule

**The portal never holds an INTERNAL bill at AVAILABLE_FOR_RELEASE.** An internal RELEASE_REVERSED returns the row to **READY_FOR_SIGNATURE** — the last stage before availability, which the admin tiles count as IN PROCESS — whatever Check Monitoring's destination (READY FOR RELEASE or SIGNED). The old release day is cleared, `released_at` is cleared (the existing RELEASED → other transition in `updateCheckRelease`), `internal_payee` stays true, nobody is notified, and the bill ages again. A supplier RELEASE_REVERSED is unchanged: AVAILABLE_FOR_RELEASE with the pickup date the event carries.

Check Monitoring sends nothing new. The event body already carries `internal: true` and the portal decides on that alone; a destination is not sent because the portal has no stage for "signed" and an internal check is never announced either way.

## Portal changes

- `src/integrations/check-monitoring.js`, `applyOne`, case RELEASE_REVERSED: `ev.internal` → `updateCheckRelease({ status: 'READY_FOR_SIGNATURE', releaseDate: null, quiet: true })`; otherwise as before. A row not at RELEASED is still `noop` (CANCELLED: `refused`).
- Migration `097_internal_reversal_not_available.sql`: every `check_release` row with `internal_payee = true`, `status = 'AVAILABLE_FOR_RELEASE'` and `notified_at is null` (never announced) moves to READY_FOR_SIGNATURE with `release_date`, the pickup confirmation and the reminder counters cleared, one `audit_log` row each (`action = check_monitoring_internal_reversal_fix`, before/after status). An internal row a portal user announced, and every supplier row, is left alone. Expected on production: the three rows above. **If the portal checkout already has a 097, renumber this file; the runner applies files in name order and records each by filename.**
- Tests (`test/check-monitoring-internal.test.js`, node:test on pg-mem): the internal reversal lands on READY_FOR_SIGNATURE with `released_at` and `release_date` null, `internal_payee` kept, no notification or email; a second reversal is `noop`; a re-release pays the bill again; a supplier reversal still lands on AVAILABLE_FOR_RELEASE with its date; migration 097 moves the internal unannounced row only, writes the audit row, and is idempotent.

## Check Monitoring changes

None in behaviour. `lib/domain/actions.ts` (`reverseRelease`) and `lib/integrations/portal/client.ts` carry a note that the portal lands an internal reversal on READY_FOR_SIGNATURE since this date; `CLAUDE.md` records the measurement. The existing test pins that an INTERNAL RELEASE_REVERSED body is flagged `internal: true` and needs no pickup date.

## Rollout

1. Portal: carry the change into the portal checkout that holds migration 096 (the check list) — the 2026-10-29 ZIP extract on the Mac does NOT; deploying from it would regress the portal. Run its tests, `npm run migrate` (097), `vercel --prod` from that checkout, merge to `main`.
2. Check the tile: 106 CHECKS AVAILABLE, 3 IN PROCESS.
3. Check Monitoring: merge to master (comments and docs only; the auto-deploy carries nothing that changes behaviour).

## Decisions taken by default

- READY_FOR_SIGNATURE rather than FOR_PROCESSING (the row's default): a released check had been printed and signed, so the stage before availability is the honest one. Either keeps the row off the Checks Available tile.
- The migration does not move an internal row with `notified_at` set: a portal user announced it, so a portal user settles it.
- Rows reversed again in future under the old code: none can be — the fix ships before any further use.
