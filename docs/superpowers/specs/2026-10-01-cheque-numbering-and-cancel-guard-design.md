# Cheque numbering report, and no CANCELLED event the portal cannot match

**Date:** 2026-10-01
**Request:** two CANCELLED events parked on `/admin/portal` (`6000354350`, `1791259553`) with
*"has no APV numbers; the portal requires at least one"*. Asked why, then: "for the voided checks
can we also import them for recording purposes? Because we are checking the check consecutives."
Then: "yes, do both — the numbering report and the guard".
**Status:** design approved in conversation, 2026-10-01. Gap rule chosen by the user: **every
number counts**. Placement chosen: **a new top tab**.

Two independent parts, built and shipped in this order: **A. the guard**, **B. the report**.
Neither depends on the other.

## Why

- **Voided cheques are already imported.** The payment feed carries `Payment` rows with status
  `Voided` and their `Voided Payment` reversals (`IMPORTED_DOC_TYPES`,
  `lib/integrations/acumatica/map.ts`); the pair is folded into one cheque keeping its original
  amount, and a cheque new to this system is created and then voided in the same transaction
  (`applyVoid`, `lib/import/upsert.ts`). Scope is the sync's: `PaymentDate >= 2026` and
  `PaymentMethod = CHK`. Nothing about ingestion changes here.
- **What Finance cannot do is check the consecutives.** No screen orders cheques by number within
  an account. NEEDS ACTION hides VOIDED; ALL CHECKS mixes every account, and hides a voided cheque
  with no amount behind `?incomplete=1`.
- **The same path parks portal events nobody can deliver.** `voidCheck` and `cancelCheck` queue a
  CANCELLED `PortalEvent` for every portal-routed cheque. The delivery client refuses an event
  with no APV before sending it (`lib/integrations/portal/client.ts`) because the portal matches on
  APV — and every cheque generated since 9 September carries no APV until it is linked. A cheque
  the sync creates already voided is the plainest case: the portal was never told it existed and
  cannot be told it is gone. RETRY rebuilds the body from the cheque and parks it again.

---

## A. The guard

### A1. The rule

`voidCheck` and `cancelCheck` (`lib/domain/actions.ts`) queue a CANCELLED event only when the
cheque is **portal-routed and has at least one APV**. Without an APV:

- no `PortalEvent` is written;
- `portalSyncStatus = NOT_APPLICABLE` (it is `PENDING` today on a routed cheque);
- `portalDomain` is still written from the route, exactly as now, so the eligibility record is
  unchanged;
- the existing `voided` / `cancelled` (and `voided_after_release`) audit row gains
  `portalNotified: false, portalSkipReason: 'no APV numbers'` in `details`. A routed cheque that
  did queue gets `portalNotified: true`. An INTERNAL cheque gets neither key — nothing was
  skipped.

"Has an APV" means what the delivery client means: `apvNumbers` if non-empty, else the cheque's
`CheckBill.apvNumber`s. That fallback moves into one exported helper,
`portalApvs(check: { apvNumbers: string[]; bills: { apvNumber: string }[] }): string[]` in
`lib/integrations/portal/apvs.ts`, used by the client's body builder and by both actions, so the
guard and the delivery check cannot disagree. `load()` in `actions.ts` therefore needs the bills'
`apvNumber` for these two actions.

The other event kinds (MARK_AVAILABLE, RELEASED, REVERT, RELEASE_REVERSED) are **not** guarded
here. A parked MARK_AVAILABLE is a cheque Finance is about to hand over and someone should see it;
a CANCELLED for a cheque the portal cannot match is noise.

**Why not later linking:** spec `2026-10-01-signing-schedule-apv-and-table-design.md` B1 links
vouchers only to **live** cheques (`judgeLink` ignores voided), so a cheque voided with no APV
does not acquire one afterwards; there is no event to send late. A cheque *cancelled* without an
APV is likewise terminal. If it ever matters, the outbox can be fed by a later step; nothing here
prevents it.

### A2. The two already parked

`scripts/close-unmatchable-cancelled.ts` (logic in `lib/admin/unmatchable-cancelled.ts`):

- **Selects** `PortalEvent` rows with `kind = CANCELLED`, `status = PARKED`, whose cheque has no
  APV by `portalApvs`. Nothing else — a parked CANCELLED that does carry an APV parked for some
  other reason and is left for a human.
- **Dry run by default**: prints cheque number, payee, event id, attempts, last error.
- **`--apply`**: writes a JSON snapshot of every selected event and its cheque's
  `portalSyncStatus` to `snapshots/` first; then, per event, in one transaction, conditional on
  the row still being PARKED: `status = SYNCED`, `lastError = 'unmatchable: no APV numbers'` —
  closed unsent, the same convention as `superseded by …` and `stale: …` — the cheque's
  `portalSyncStatus = NOT_APPLICABLE`, and one `portal_event_closed_unmatchable` audit row
  (`details: { eventId, kind, attempts, lastError }`). Idempotent: a second run selects nothing.
- `/admin/portal`'s outbox line (`lib/admin/portal-overview.ts`) counts `unmatchable: …` as its
  own figure, **N closed as unmatchable**, subtracted from delivered the same way superseded and
  stale are.

### A tests

- `actions` (void and cancel): routed with APV → event queued, `PENDING`, `portalNotified: true`;
  routed with no APV and no bills → no event, `NOT_APPLICABLE`, `portalNotified: false`; routed
  with no `apvNumbers` but a bill → event queued; INTERNAL → unchanged.
- `import/upsert`: a cheque created already voided with no APV queues nothing.
- `integrations/portal-client`: still uses `portalApvs` (existing cases stay green).
- `admin/unmatchable-cancelled`: selects only PARKED CANCELLED with no APV; apply closes,
  audits, sets the cheque; second run is a no-op; a row no longer PARKED is not touched.
- `admin/portal-overview`: the unmatchable count.

---

## B. The numbering report

### B1. Population

Every `Check` with `isCheque = true` and a `cashAccountId`, **of every status** — VOIDED,
CANCELLED, RELEASED, and cheques with no amount (`isIncomplete`) included, because the number was
used whatever happened to it.

- **The series key is the cash account.** Acumatica publishes no cheque book (`checkBookCode` is
  always null from the sync); the cash account is the one per-account fact every synced cheque
  carries. A register-only cheque with no cash account is not in any series; the page states how
  many there are, as a count with no link (the dashboard has no "no cash account" filter, and
  adding one is out of scope).
- **Numeric only.** `checkNumber` is canonical (`canonicalCheckNumber`), so a bank prefix is
  already gone. A number that is all digits is placed in the sequence, compared as `BigInt` (they
  run to ten digits and beyond; string order would put `999` after `1000`). Anything else is
  listed under **NOT NUMERIC** for that account and is not in the sequence.
- **Company filter**: the existing company dropdown values; narrows which accounts are listed.

### B2. The rule — every number counts

Within one cash account, sort the numeric cheques ascending. Every whole number strictly between
the lowest and the highest held number that no cheque holds is **MISSING**. Consecutive missing
numbers are reported as **one line** — first, last, count — never one row each, because a jump
between booklets can be millions of numbers.

- Two cheques on the same number within one account (possible: `@@unique` is
  `[companyId, checkNumber]`, and a cheque's `companyId` is not constrained to its cash account's
  company) are both shown, flagged **DUPLICATE NUMBER**, and count once as held. Not an error; a
  fact to look at.
- Before the lowest held number and after the highest, nothing is inferred.
- **The scope boundary is printed on the page and in the file**: the sync reads payments from
  2026 onward, so the first number of an account may sit partway through a booklet and earlier
  numbers are not known here. Likewise a cheque Acumatica holds with a memo instead of a number
  is on `/admin/staged`, not here — its number may be one of the MISSING.

Pure function, no database: `buildSeries(cheques: SeriesCheque[]): AccountSeries` in
`lib/numbering/series.ts`, returning ordered entries
`{ kind: 'CHEQUE', cheque } | { kind: 'MISSING', from, to, count }`, plus `notNumeric`,
`duplicates`, and a summary `{ first, last, held, voided, cancelled, missingNumbers, missingRuns,
notNumeric }`. Arithmetic is `BigInt` inside the function; every number and count leaves it as a
decimal string, so nothing downstream does arithmetic on a JS number.

Query: `lib/numbering/query.ts` — one `findMany` per request selecting `id, checkNumber,
checkDate, payeeName, amount, status, cashAccount { id, code, bank.code, company.code }`, ordered
by cash account. ~12,000 rows; loaded whole, grouped in memory.

### B3. Screen — `/numbering`

A new module in `lib/module-nav.ts`, **NUMBERING**, between RECON and ADMINISTRATION,
`adminOnly: false`. Page guarded by `requireUser()` like `/recon`.

- **Summary (no `account`)**: one row per cash account — ACCOUNT, BANK, COMPANY, FIRST, LAST,
  HELD, VOIDED, CANCELLED, **MISSING** (numbers, and runs in brackets), NOT NUMERIC. The account
  links to its detail. Above it the company filter and the count of cheques with no cash account.
  Sorted by account code.
- **One account (`?account=<cashAccountId>`)**: every entry in number order — NUMBER, DATE,
  PAYEE, AMOUNT, STATUS (the existing `StatusPill`), each cheque linked to `/checks/[id]` — with
  each MISSING run as a full-width highlighted line `6000354301 – 6000354349 · MISSING · 49`.
  A **MISSING ONLY** toggle (`?missing=1`) shows just the gaps. A duplicate is flagged
  DUPLICATE NUMBER on its own row; a NOT NUMERIC section follows the table when non-empty. BACK TO ALL ACCOUNTS keeps the company filter.
- An unknown `account` id is a 404 text state on the page, not a widened view.
- Amounts are rendered from the decimal string; no total is shown (the report is about numbers,
  and a total over VOIDED and CANCELLED cheques would be read as money).

### B4. Export — `/api/export/numbering`

Same parameters (`company`, `account`, `missing`), session-guarded like `/api/export/recon`.

- **SUMMARY** sheet: the summary table plus the scope note.
- **One sheet per account** (only the open account when `account` is set; all listed accounts
  otherwise), named by account code (sanitised to Excel's 31-character, no-`[]:*?/\` rule; a
  collision gets a numeric suffix): the entries as on screen, MISSING lines with FROM, TO, COUNT
  in their own columns and the row styled, so a filter on STATUS = MISSING works.
- Cheque numbers written as **text** cells (ten-digit numbers lose nothing, but a leading zero
  would). Amounts as the existing decimal handling in `lib/export/sheet-style.ts` /
  `recon-workbook.ts` does.
- Filename `cheque-numbering-<Manila day>.xlsx`, the `recon` pattern (`slugify`).

### B tests

- `numbering/series` (pure): consecutive run; one gap; a large gap is one line with the right
  count; adjacent gaps around a single cheque; duplicate number; non-numeric excluded; ten-digit
  and mixed-length numbers ordered numerically; single cheque (no gaps); empty account.
- `numbering/query`: includes VOIDED, CANCELLED, incomplete; excludes `isCheque = false` and no
  cash account (counted); company filter.
- `numbering-view` (URL → state): `account`, `missing`, company; unknown account.
- `export/numbering-workbook`: sheets, names sanitised and de-duplicated, MISSING row columns,
  numbers as text.
- `export/numbering-route`: unauthenticated refused; parameters honoured.
- `module-nav` +1.

---

## Out of scope

- Ingesting anything new. Pre-2026 cheques, non-CHK payments and memo-numbered cheques stay as
  they are; the report states the boundary instead.
- Booklet ranges typed by Finance, or a booklet-size heuristic. Rejected in conversation for
  "every number counts"; either can be added later as a narrowing of the MISSING lines.
- Guarding event kinds other than CANCELLED.
- Recording an explanation against a MISSING number (spoiled form, etc.). Worth having once
  Finance has worked the list once and knows what the explanations are.

---

## C. Addendum, 2026-10-02 — dotted re-uses count as used numbers

**Request:** "do the trailing-dot fix" — then, after measurement, the user chose to show dotted
references on NUMBERING rather than change the import.

### Why not strip the dot at import

Measured 2026-10-02 (read-only) over the 773 Acumatica payments staged `NO_CHECK_NUMBER`:
169 state a cheque number followed only by dots (`6000146879.`, `1791361883..`; trailers seen:
`.` 158, `..` 8, `...` 1, `....` 1, `,` 1). Of those, **66 share the undotted number with a
cheque already held here under the same company — under a DIFFERENT Acumatica payment**, often
the adjacent CV (`CV-ST012434 "6000146879."` vs `CV-ST012433 6000146879`, VOIDED). Acumatica
refuses a duplicate cheque reference on a cash account, so a second payment document on the same
physical cheque number is entered with a dot appended (one more dot each further time) — a void
and re-issue, or two vouchers on one cheque. **The dot is Acumatica's "this cheque number again"
marker, not a typo.** Stripping it at import would collapse a second payment onto an existing
cheque under the `(companyId, checkNumber)` key — 66 at least, some onto VOIDED cheques — which is
the silent collision `lib/import/normalise.ts` warns against. The import is unchanged.

### C1. The rule

A staged row counts in a cash account's series when **all** hold:
- `source = ACUMATICA`, `reason = NO_CHECK_NUMBER`, `promotedCheckId` is null;
- its `statedCheckRef`, trimmed, **ends with at least one `.`**, and with only the trailing dots
  removed it passes the existing rule — `canonicalCheckNumber` then `isBareCheckNumber` (so a
  known bank prefix is fine, nothing else is loosened). One pure function,
  `stagedSeriesNumber(statedCheckRef): string | null`, in `lib/numbering/series.ts`;
- its `cashAccountCode` names a cash account here. The series is that account's.

Read only. Nothing is written, promoted or re-keyed; the staged queue is unchanged.

### C2. The series

`buildSeries(cheques, staged = [])` — the second argument is optional, so every existing caller
is unchanged.
- MISSING is computed over the union of cheque numbers and staged numbers, so a number used only
  by a dotted payment is **not** MISSING.
- A new entry kind, `{ kind: 'STAGED'; staged; number }`, sits at its number; at a number a
  cheque also holds, the cheque row comes first, then the STAGED line(s).
- `first` / `last` span both. `held` stays distinct **cheque** numbers. New summary field
  `staged`: the count of STAGED entries. A staged line never sets `duplicate` on a cheque.
- MISSING ONLY shows MISSING lines only, as now.

### C3. Query

`listNumberingAccounts` also reads the qualifying staged rows (≈800 at most), maps each by
`cashAccountCode` to a cash account, honours the same `companyId` / `cashAccountId` filters, and
passes them to `buildSeries`. An account that holds only staged numbers still gets a series.
Staged amounts are two-decimal strings, as cheques are.

### C4. Screen and file

- **Screen:** a STAGED line shows the stated reference verbatim (`6000146879.`), the cheque date,
  payee, amount and a grey **STAGED** label with `Acumatica <CV>` beside it. No link —
  `/admin/staged` is admin-only. The summary table gains a **STAGED** column.
- **File:** a STAGED row: CHECK NUMBER = the stated reference verbatim, STATUS = `STAGED`, NOTE =
  `Acumatica <CV>: the same cheque number used again (staged)`. SUMMARY gains a STAGED column after
  CANCELLED.
- **Scope note** (`NUMBERING_SCOPE_NOTE`): a number Acumatica re-used with a trailing dot now
  counts as used and is listed as STAGED; a memo reference with no number (`PCF26-00001`) can
  still hide behind a MISSING line.

### C5. Tests

`numbering/series` (pure): a staged-only number closes a gap; cheque + staged on one number;
`..` and a bank prefix; a reference without a dot, or not a number once dots are removed, is
ignored; staged extends `last`; `held` / `staged` / `duplicates` counts. `numbering/query`:
qualifying staged rows join their account; a promoted row, a non-dotted row and a WORKBOOK row
are ignored; the company filter applies. `export/numbering-workbook`: a STAGED row and the
SUMMARY column. `numbering-view`: none unless the scope note is pinned.

### C6. Out of scope

Register-staged rows; any change to the staged queue or to import keying; promoting dotted
payments to cheques (the `(companyId, checkNumber)` key cannot hold two payments on one number —
a model change, if it is ever wanted).

---

## D. Addendum, 2026-10-02 — Acumatica's "CashAccount" is the cheque book

**Found** on the live NUMBERING tab right after §C shipped: STAGED 0 on every account, 4 cash
accounts, and "11,614 cheques with no cash account". Measured read-only the same day:

- `CashAccount` holds six register labels (`BPI STK`, `BPI P&P`, `BPI A1`, `MBTC A1+`, `MBTC P&P`,
  `BDO A1`) with 1,342 cheques between them.
- `CheckBook` holds eight codes — `BPI-S-4636` (4,813 cheques), `MBT-A-4155` (2,176), `BPI-S-8879`
  (753), `BPI-A-5713` (573), `MBT-A-9048` (455), `BDO-A-3838` (283), `BPI-A-8879` (14),
  `MBT-S-1121` (5) — all from the retired register.
- **Acumatica's `CashAccount` column states exactly those cheque-book codes** (staged Acumatica rows,
  verbatim: `BPI-S-4636` 256, `MBT-A-4155` 158, `BDO-A-3838` 71, `BPI-A-5713` 32, …, plus
  non-books `PCF-SITIO` 241, `PAYROLL` 3, `PCF-SILANG`, `RSB-S-0869`, `MBTC-S-988`).
- `map.ts` claims the inquiry "publishes no checkbook" and sets `checkBookCode: null`, then looks the
  code up in `CashAccount`, which never matches. Result: **3,844 Acumatica cheques carry no cheque
  book; 3,501 cheques carry neither book nor cash account, 1,091 of them dated since 2026-09-10**.
- NUMBERING (§B) keys on cash account, so it sees ~1,342 cheques; the staged dotted payments (§C)
  carry book codes, so none joins. **The dashboard BANK filter/column and RECON also key on the
  cash-account label** — measured separately and reported as a follow-up, not changed here.

### D1. The sync records the cheque book

`mapPayment` sets `checkBookCode` to the trimmed `CashAccount` value (and keeps `cashAccountCode` as
it is). `upsertCheck` already resolves `checkBookCode` against `CheckBook.code` and writes
`checkBookId` (in `IMPORT_WRITABLE`); a code that is no cheque book (`PAYROLL`, `PCF-SITIO`) finds
none and stays null — nothing is invented. The misleading comment in `map.ts` is corrected. Status
is untouched (rule 4).

### D2. Backfilling existing cheques — a targeted repair, not a full re-sync

A FULL re-sync would rewrite every import-writable field on ~15,000 rows and add an audit row for
each. Instead, `lib/admin/check-books.ts` + `scripts/backfill-check-books.ts <TENANT> [--apply]`:
- reads the payments feed (`PAYMENTS_FEED`, `paymentsInScopeFilter()`, columns `Type`,
  `ReferenceNbr`, `CashAccount`; a voided pair's `Payment` row wins) — read-only by construction;
- selects cheques with `acumaticaTenant = TENANT`, `acumaticaPaymentId` set, `checkBookId` null;
- per cheque: the payment's `CashAccount` → a `CheckBook` by code. **Set only when the book's
  company is the cheque's company**; a mismatch is reported and left (a book under a sibling
  company is the failure `map.ts` warns about). Reported, not set: no such payment in the feed, a
  code that is no cheque book (counted by code), a company mismatch;
- dry run by default; `--apply` writes a JSON snapshot of every candidate first, then per cheque in
  its own transaction (`TX_OPTIONS`, 30 s): `updateMany` conditional on `checkBookId` still null,
  one `check_book_backfilled_from_acumatica` audit row (`{ checkBookCode, acumaticaPaymentId }`).
  Idempotent. Prints counts and codes, never amounts or payees. Run by the user, from a terminal.

### D3. NUMBERING groups by cheque book

- The series key is `Check.checkBookId`; the company filter is the book's company; the `account`
  parameter carries a cheque-book id (the parameter name is kept, so existing links still parse).
- Staged dotted payments (§C) join on `CheckBook.code = StagedCheck.cashAccountCode`.
- Cheques with no cheque book are stated as a count: "NOT IN ANY SERIES: N CHEQUES WITH NO CHEQUE
  BOOK" (page and file). An unknown `account` id is still a not-found state / 404.
- `NumberingAccount` keeps its shape (`accountId`, `account` = the book code, `bank`, `company`).
  `lib/numbering/query.ts` gains `listCheckBookOptions(db)` — `{ id, code, bankCode }[]`, by code —
  which the page and route use instead of `getFilterOptions().cashAccounts`.
- Copy: "cash account" → "cheque book" on the page, the summary header (ACCOUNT → CHEQUE BOOK), the
  file and the scope note.

### D4. Tests

`integrations/acumatica-map`: `checkBookCode` equals the trimmed `CashAccount`. `import/upsert`: an
Acumatica row whose `CashAccount` is a cheque-book code gets `checkBookId`; a non-book code leaves
it null. `admin/check-books` (database; the Acumatica client faked): selection, company mismatch
reported, non-book and not-in-feed reported, dry run writes nothing, apply sets the book and one
audit row, second apply is a no-op, a cheque that gained a book meanwhile is untouched, status
unchanged. `numbering/query` and `export/numbering-route`: regrouped by cheque book.

### D5. Out of scope

The dashboard BANK filter/column and RECON grouping (follow-up, measured and reported). Deriving a
cash-account label from a cheque book. Adding `PCF-SITIO` / `PAYROLL` as books.

---

## E. Addendum, 2026-10-05 — cheque books are shared across companies; the company check goes

**Measured** after the user's first `backfill-check-books.ts GOLIVE --apply` (537 set, 1,070 more
settable, **1,331 refused as company mismatches**), read-only, grouped by (book, book company,
cheque company): `BPI-S-8879` (on record STPP) — 776 STK, 38 A1+, 32 HAMFI, 13 IND refused;
`MBT-A-9048` (A1PP) — 356 A1+; `BPI-A-5713` (A1+) — 70 STK; `BPI-S-4636` (STK) — 21 A1+, 5 HAMFI,
2 IND; and smaller. **The register itself already filed cheques of several companies under one
book**: `BPI-S-4636` holds 4,823 STK + 42 A1+ + 33 HAMFI + 14 IND; `BPI-S-8879` 695 STK + 22 HAMFI +
17 IND + 16 STPP; `BPI-A-5713` 548 STK + 29 A1+; `MBT-A-9048` 396 A1+ + 58 A1PP. **A cheque book is a
bank account, and one account pays several companies' bills.** §D's company check rested on the
opposite assumption. **User ruling 2026-10-05: drop it** — Acumatica's `CashAccount` is the fact.

### E1. Sync and repair

- `upsertCheck` accepts the book `checkBookCode` names, whatever its company. `checkBookRefused`
  goes; `checkBookChanged` stays (a book change on update is still recorded).
- `planCheckBookBackfill` drops `companyMismatch`; every cheque whose payment names a cheque book is
  a candidate. The script stops printing the mismatch section.
- `CheckBook.companyId` stays in the schema and in reference data; nothing reads it for a decision.
  CLAUDE.md "What is missing" item 11 is closed by this ruling.

### E2. NUMBERING

- A series is still one cheque book and still holds **every** cheque in it, of every company — a
  company's view of a shared book must not turn another company's cheques into MISSING numbers.
- The **company filter selects the books that company's cheques use** (a book qualifies when at
  least one of its cheques has that `companyId`), then shows those books whole. The cheque-book
  option list and the `account` parameter are unchanged.
- `NumberingAccount.company` becomes the companies among the series' cheques, most cheques first,
  joined `", "` (e.g. `STK, A1+, HAMFI`); `""` for a staged-only book. The COMPANY column (page and
  SUMMARY sheet) shows that.
- `countChequesWithoutCheckBook` keeps narrowing by the cheque's own company.

### E3. Tests

`import/upsert`: the cross-company cases now expect the book set (create) and moved (update), with
`checkBookChanged`, and no `checkBookRefused` key. `admin/check-books`: the former mismatch cheque is
a candidate and gets its book on apply. `numbering/query`: a book holding two companies' cheques is
one series with `company` listing both; filtering by either company returns that whole book (no
MISSING where the other company's cheques sit); a book with none of the company's cheques is left
out.

---

## F. Addendum, 2026-10-05 — OUT OF PATTERN numbers leave the gap count

**Found** on the live NUMBERING tab right after §E shipped: MISSING read in the billions
(`BPI-S-4636` 600,031,002,200). Measured read-only the same day, per book: each has one dominant
number shape and a few cheques that break it — `BPI-S-4636` 5,974 ten-digit `6000…` plus 18 of
another length (`60000`, `600039037`, `60003162116`, `000006`) and 18 `1791…`; `BPI-A-5713` 610
`6000…` plus 21 off-length and 19 `1791…`; `MBT-A-4155` 2,584 `1791…` plus 10 off-length and 20
`6000…`; `MBT-A-9048` one 11-digit `17913405552`; `BDO-A-3838` 285 six-digit plus 36 written
`0000179xxx` (the same BDO numbers, zero-padded) and a few `1791…`; `BPI-S-8879`, `BPI-A-8879`,
`MBT-S-1121` clean. Almost all misfits are Acumatica rows — a digit dropped or added, or another
bank's number keyed under this account. One of them stretches a series across billions. **User
ruling 2026-10-05: list them separately.** Nothing in the data changes.

### F1. The rule (pure, in `lib/numbering/series.ts`)

- A number's **shape** is `(digits, lead)`: `digits` = its length with leading zeros removed,
  `lead` = its first two digits after leading zeros are removed. `0000179241` → `(6, "17")`, the
  same shape as `179241`; `6000354350` → `(10, "60")`; `1791361374` → `(10, "17")`; `0000` → `(0, "")`.
- A book's **pattern** is the shape held by the most numeric cheques (ties broken by more digits,
  then by `lead`). Staged lines do not vote.
- **Only a series with at least 20 numeric cheques is checked** (`PATTERN_MIN_CHEQUES = 20`). Below
  that there is too little evidence to call any number a misfit, and every number stays in.
- A numeric cheque or staged line whose shape differs from the pattern is **OUT OF PATTERN**: it is
  not placed in the sequence and does not bound any MISSING run. Everything else is as before.
- `AccountSeries` gains `outOfPattern: SeriesEntry[]` (CHEQUE and STAGED entries, in BigInt order)
  and `pattern: { digits: number; lead: string } | null`; `SeriesSummary` gains `outOfPattern:
  number`. `first` / `last` span only the in-pattern numbers.

### F2. Screen and file

- Summary table and SUMMARY sheet: an **OUT OF PATTERN** column after NOT NUMERIC.
- One book: after the table, an **OUT OF PATTERN — NOT IN THE SEQUENCE** section listing those
  cheques (number linked to the cheque page, date, payee, amount, status) and staged lines, with a
  line stating the pattern, e.g. "This book's numbers are 10 digits starting 60; these are not."
  Hidden under MISSING ONLY, as NOT NUMERIC is.
- Workbook: those rows after the sequence, NOTE `OUT OF PATTERN (expected 10 digits starting 60)`.
- Scope note: add "A number that does not match its book's usual length and first digits is listed
  as OUT OF PATTERN — usually a mistyped or misfiled cheque number in Acumatica — and left out of
  the gap count."

### F3. Tests

`numbering/series` (pure): below 20 cheques nothing is out of pattern; 20+ ten-digit `60…` plus one
`60000` and one `1791…` → both out of pattern, MISSING only between the in-pattern numbers;
`0000179241` among six-digit `17…` numbers is in pattern; a staged line of the wrong shape goes out;
`first`/`last` and counts. `export/numbering-workbook`: the rows and the column. Existing tests keep
their meaning (they use fewer than 20 cheques).

---

## G. Addendum, 2026-10-05 — NUMBERING follows Acumatica's data

**User, 2026-10-05:** "I told you to follow acumatica reference." Measured read-only the same day:
10,987 Acumatica cheques already carry the book Acumatica states; **61 carry a different book left
from the register** (32 `BPI-S-4636`→`BPI-A-5713`, 13 `MBT-A-9048`→`MBT-A-4155`, 4 →`MBT-S-9048`,
1 →`PAYROLL`, …); 1 number differs; **1,102 cheques in a book are register-only** (no Acumatica
payment). NUMBERING rebuilt purely from Acumatica's own payments (PaymentRef in CashAccount, no data
from here) shows the same anomalies — `MBT-A-4155` `1719333663`..`1797334184`, `MBT-S-9048`
`17913404695`, `MBT-A-9048` `1790405938`, `BPI-A-8879` mixing `1791…`/`6000…`: **the remaining
errors are Acumatica's own entries**, corrected there. The user chose all three of:

### G1. Realign books to Acumatica

`planCheckBookBackfill` also selects Acumatica cheques (tenant + payment id) whose `checkBookId` is
set but differs from the book their payment's `CashAccount` names:
- the code is a cheque book → `realign` candidate (move to that book);
- the code is not a cheque book (`PAYROLL`, `MBT-S-9048`, …) → `clear` candidate (set `checkBookId`
  null — per Acumatica the cheque is in no cheque book).

Applied in the same run as the fill, one transaction each, conditional on `checkBookId` still being
the planned `from` value, `TX_OPTIONS`, one `check_book_realigned_to_acumatica` audit row
(`{ from, to, code, acumaticaPaymentId }`, `to` null for a clear). Snapshot first (it already
records every candidate; it now records `from`). The script prints the realign and clear counts by
pair. Status never changes.

### G2. NUMBERING shows only Acumatica cheques

`listNumberingAccounts` adds `acumaticaPaymentId: { not: null }` to every cheque query (book
selection by company included). `countChequesWithoutCheckBook` counts only Acumatica cheques.
New `countRegisterOnlyCheques(db, { companyId? })` = `isCheque` and `acumaticaPaymentId` null. The
page (summary view) and the SUMMARY sheet state: "N REGISTER-ONLY CHEQUES (NOT IN ACUMATICA) ARE NOT
SHOWN." Staged lines are Acumatica rows already. The scope note says each series is built from
Acumatica's own cheque numbers and cash accounts.

### G3. TO FIX IN ACUMATICA (export only)

The NUMBERING workbook gains a sheet `TO FIX IN ACUMATICA` (after SUMMARY, before the book sheets),
one row per:
- every OUT OF PATTERN cheque (reason `OUT OF PATTERN — expected N digits starting LL`);
- each book's **stray end**: the first in-pattern number when the next one is more than 10,000
  higher, and the last when the previous one is more than 10,000 lower (reason `STRAY FIRST
  NUMBER — next is N higher` / `STRAY LAST NUMBER — previous is N lower`), repeated inward while it
  holds, at most 3 from each end. `STRAY_GAP = 10000`.

Columns: CHEQUE BOOK, CHECK NUMBER (text), CV (the Acumatica payment reference), CHEQUE DATE, PAYEE,
STATUS, REASON. Staged out-of-pattern lines are included with their CV. It changes no count on the
page or in the series — it is a to-do list. `SeriesCheque` gains `cv: string | null`
(`acumaticaPaymentId`); the pure function `strayEnds(series): { cheque; staged; reason }[]` lives in
`lib/numbering/series.ts`.

### G4. Tests

`admin/check-books`: realign (book differs → moved, audit row with from/to), clear (non-book →
null), a cheque whose book changed after planning is untouched, fill behaviour unchanged.
`numbering/query`: a register-only cheque is excluded and counted; company book-selection ignores
register-only cheques. `numbering/series`: `strayEnds` (first/last beyond 10,000; inward up to 3;
none when gaps are small; ignores out-of-pattern). `export/numbering-workbook`: the TO FIX sheet's
rows and reasons; the register-only line on SUMMARY.

---

## H. Addendum, 2026-11-03 — NUMBERING is the check inventory

User request, 2026-11-03: *"we will use numbering module for check inventory, have a check box for
tick marks and remarks if the checks are missing. It should be in series even the checks are
missing from acumatica so the finance will record the status."* This is the item the original
"Out of scope" list deferred ("Recording an explanation against a MISSING number"), now wanted.

### H1. The rule

A **MISSING number is a line of its own**, with a tick box and a remarks field, so the status of a
physical check Acumatica does not hold — unused in the vault, spoiled, lost, written by hand and
never encoded — is recorded here and not in a spreadsheet. Nothing about the series changes:
`buildSeries` still reports a gap as one MISSING run with its exact count, and every count on the
page and on SUMMARY is the same as before.

- **A run of at most `INVENTORY_LIST_MAX = 100` numbers is listed one number per line.** Measured
  on production the day this was built: 687 MISSING runs across 9 books; at 100, 579 runs (84%)
  are listed number by number — 5,014 lines in all, at most 1,915 on one book (BPI-S-4636) — and
  the 108 longer runs stay one line each. The largest run is 11,913,041,270 numbers.
- **A longer run is one line with one tick and one remark for the whole run**, keyed to the run's
  first number; the note also stores the run's last number (`runTo`) as it was that day. If the
  run has since changed shape (a check arrived inside it), the line says which run the note was
  recorded on and asks for it to be confirmed again. Nothing is inferred.
- **A note is keyed by check book and canonical number** (decimal, no leading zeros), so a bound
  padded to the book's width finds the note recorded on the bare number, and `007` and `7` are one
  key.
- **A note on a number that later arrives from Acumatica is kept** and shown read-only beside the
  check (RECORDED WHILE MISSING), on screen and in the file. It is never written onto the check:
  a check's status and remarks are the check's own.
- **A note is refused for a number a check in that book holds** (the number is not missing; the
  refusal names the check and its status), for a number that is not all digits, for a run end
  that is not a number or precedes its start, and for a remark over 500 characters.
- **Every Finance user** may tick and remark, as with FINANCE NOTES on a check. Each save is one
  `inventory_note_recorded` audit row — `actorType USER`, **no `checkId`** (there is no check) —
  carrying the book, the number, the run end, the tick and remark, and what it replaced. Rows in
  `CheckInventoryNote` are written in place and never deleted; the history is the audit trail.

### H2. Screen

The one-book view (`/numbering?account=…`) gains an INVENTORY · TICK AND REMARKS column. Each
MISSING number is an amber row — number, NO CHECK IN THIS SYSTEM, a MISSING pill — whose cell is
`components/InventoryNoteCell.tsx`: a tick box saved the moment it changes and a remarks box saved
when it is left (or Enter) with text that differs from what is recorded; the row then states who
recorded it and when, with no page reload (a book can show 7,000 lines). A refused save puts the
box back as recorded and shows the domain's words. A line above the table states the inventory:
MISSING numbers, lines, TICKED, WITH REMARKS. MISSING ONLY shows the gap lines alone — the
worksheet. SUMMARY gains a TICKED column: the MISSING numbers covered by a ticked note, a ticked
run counting every number it still spans.

### H3. File

The book sheets write each MISSING number as its own row (FROM = TO = the number, COUNT 1), a
long run as one row whose NOTE says it is too long to list, and four new columns at the end —
TICKED (YES/NO), REMARKS, RECORDED BY, RECORDED AT (Manila) — so the file is the inventory as the
screen shows it. SUMMARY gains TICKED. The row cap applies as before.

### H4. Code

`lib/numbering/inventory.ts` (pure: `inventoryKey`, `toInventoryLines`, `inventoryCounts`,
`runNoteStale`, `INVENTORY_LIST_MAX`); `lib/numbering/inventory-notes.ts` (`loadInventoryNotes`,
`recordInventoryNote` — the one writer, with its audit row); `NumberingAccount.lines` and
`.inventory` from `listNumberingAccounts`; `app/numbering/actions.ts`
(`recordInventoryNoteAction`); migration `20261103000000_check_inventory_note`.

### H5. Tests

`numbering/inventory` (pure: key, short run listed, cap, billion-number run, padded bounds, a
held number keeps its note, staged passes through, counts, stale run note);
`numbering/inventory-notes` (row and audit, update in place with `before`, run bounds, refused
held number / non-numeric / unknown book / long remark, loading by book);
`actions/inventory-note-action`; `numbering/query` +2; `numbering-view` +1;
`export/numbering-workbook` +3 and the MISSING-row expectations updated.

### H6. Second pass, same day — a long run opens on a click

User, on seeing `174267 – 174389 · MISSING · 123` in production: *"this can be click then back to
collapse."* The run line is now a button: a click lists the run's numbers beneath it, one amber
row each with its own tick and remark, `INVENTORY_EXPAND_PAGE = 200` at a time with SHOW NEXT for
the rest (a run can be billions, so nothing is listed until asked, and the numbers are generated in
the browser from `from` and `to`); another click closes it. The whole-run tick and remark stay on
the run line. Consequences:

- **A note is on one number OR on a run, never both in one row.** The key is now
  `(checkBookId, checkNumber, runTo)`, `runTo = ''` for a single number (migration
  `20261103000100_check_inventory_note_run_key`; existing null → ''). The whole-run tick on
  174267–174389 and the tick on 174267 itself are two rows. The pure layer still reads `runTo` as
  null for a single number.
- A run line carries `notes`: the single-number notes recorded inside it, so an opened run shows
  them. `inventoryCounts` counts a ticked run as every number it spans, else its ticked numbers.
- A run note recorded on exactly this run wins; failing that, the newest recorded on a run from the
  same first number, and the line says the run has changed.
- `components/MissingRunRows.tsx` (client) is the run line and its opened rows;
  `components/MissingNumberRow.tsx` is one MISSING number, used by both the server table and an
  opened run. The file is unchanged: a run is still one row there.

### H7. Out of scope

Ticking a HELD check (its status is its record); a bulk "tick all"; a note on a range Finance
types by hand; reading the inventory back into Acumatica.
