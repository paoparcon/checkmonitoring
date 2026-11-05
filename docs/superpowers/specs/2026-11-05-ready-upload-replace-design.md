# READY upload: ADD or REPLACE — design

**Date:** 2026-11-05 · **Requested by:** the user, the same day ·
**Status:** being built on `feature/cleared-status-and-uploads`.

## 1. What happened, and what was asked

Finance uploaded two lists on 2026-11-05 (LOCAL SUPPLIER 11.6, 236 checks; BROKERS
11.3, 23) and the app showed 265 READY FOR RELEASE. The 9 extra were checks
readied from earlier lists (8 from FOR RELEASE 10.30, one from the 4 September
approval workbook) and never released. The upload only ever adds — "nothing is
demoted by a list" — so a check that drops off Finance's list stays available,
and the supplier keeps being told it is.

The user: *"Maybe we can have an option if this is additional or replacement. If
replacement, we need confirmation of the checks ready for release and not
included in the upload if they will return or will revert to SIGNED. This will
also forwarded to the supplier portal and revert the status."*

## 2. Behaviour

- **Several files in one upload.** The file box takes more than one .xlsx; their
  rows are read as one list (sheet names are prefixed with the file name when
  there is more than one file). Finance's list arrives as LOCAL + BROKERS, and a
  replacement that saw one of them would offer to withdraw the other's checks.
- **MODE: ADD (default) or REPLACE.** ADD is exactly the upload as it was.
- **REPLACE** adds one section to the preview: **READY NOW, NOT ON THIS LIST** —
  every READY_FOR_RELEASE or SCHEDULED check that no row of the upload names.
  A check is *named* when its check number is on any row, or any AP bill it
  carries (`apvNumbers` ∪ `CheckBill`) is on any row — whatever that row's
  verdict. So a check the list names ambiguously, or with a bill on the wrong
  check, is never offered for withdrawal.
- Each off-list check shows its number, company, payee, amount, status, pickup
  date and where its availability came from (the file on its latest
  `ready_for_release` audit row, else the date it was readied). **Each needs an
  explicit choice — KEEP READY or REVERT TO SIGNED** — with SET ALL buttons;
  CONFIRM is disabled until every off-list check has one. There is no default:
  that choice is the confirmation the user asked for. A REVERT needs a reason,
  prefilled "Not on the replacement release list (<files>)" and editable.
- **CONFIRM** re-reads the same files on the server and re-plans. It readies the
  listed checks as before, then, for each check the form chose REVERT for, that
  is still in the re-planned off-list set, calls the gate (`applyOrRequest`,
  kind WITHDRAW, with the reason and `source` = files + `replacement: true`).
  So: `revertAvailability`, the REVERT portal event, the audit row — or, for a
  user who is not the approver, a request to the approver. A chosen id that is
  no longer off the list (readied by someone, released, now named) is reported,
  not reverted. KEEP writes nothing.
- One 30 s budget covers both loops; what it does not reach is counted, and the
  same upload again finishes it (readied rows read ALREADY READY, reverted
  checks are no longer READY).
- The upload is still FINANCE_ADMIN only.

## 3. Not changed

ADD never withdraws anything. A list never pulls back a RELEASED check. A
SIGNED / pending check off the list is not touched in either mode.

## 4. Tests

`tests/admin/ready-upload.test.ts`: off-list set (named by number, by bill,
ALREADY READY excluded; SCHEDULED included; SIGNED/RELEASED not offered); ADD
offers nothing; apply reverts only chosen off-list checks with the portal REVERT
and reason, refuses an id that is not off-list, a non-approver's revert becomes
a WITHDRAW request; `mergeUploads` prefixes sheets per file.
