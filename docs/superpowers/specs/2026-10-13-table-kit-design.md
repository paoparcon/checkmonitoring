# Table kit — Supplier-style header menu, Column Configuration and resize on every table

Date: 2026-10-13. User request: "i want all the customize columns and filter would like what we did
in supplier". Reference implementation: Supplier Portal commit `59e342c` (Acumatica-style header
menu and Column Configuration dialog on every page), `public/js/table-kit.js`,
`public/js/table-kit-core.js`, `createTableCustomizer` in `public/js/app.js`.

Decisions taken with the user, 2026-10-13:

- Scope: **every table** — the main check list, the transmittal picker, the report tables and the
  admin tables (exceptions below).
- **Resize everywhere** by dragging a header's right edge.
- On the main check list the **filter-box row is replaced** by the header menu and chips.
- Approach A: one shared React kit, not a port of the Supplier DOM enhancer and not per-page work.

## 1. What every table gets

**Header menu.** Clicking a header opens a menu anchored under it (kept inside the viewport; a
second click on the same header, Escape or a click outside closes it):

- Sort Ascending / Sort Descending. Picking the direction already in force removes the sort.
- Clear Filter (disabled when the column has none).
- The filter, by column kind:
  - **date** — Equals, Does Not Equal, Is Greater Than, Is Greater Than or Equal To, Is Less Than,
    Is Less Than or Equal To, Is Between; then Today and This Month (Manila calendar day); then a
    Date / From + To picker. OK applies, Enter in a picker applies, Cancel discards.
  - **amount** — the same operators as date, typed amounts instead of dates (no Today / This
    Month). Amounts are compared as decimal strings, never JS numbers (rule 8).
  - **enum** (status, company, bank and similar) — a dropdown of the known values (ALL + each
    value); the match is exact, so `SIGNED` never also matches `SIGNATURE_PENDING`. A dropdown, not
    Supplier's typed box: on the main list COMPANY and BANK are ids on the server, so a typed
    "contains" could not be honoured there, and one control everywhere is simpler to read.
  - **text** — one "contains" box, case-insensitive, thousands commas and `₱` ignored on both sides.
- A column marked `noSort` omits the sort items; one marked `noFilter` omits the filter. A column
  with neither (a buttons column, the select-all checkbox) has no menu at all.

**Chips.** Above the table, one chip per active filter — `LABEL: value` in human form
(`≥ 2026-10-01`, `2026-10-01 to 2026-10-13`) — each with ✕. A filtered header carries a visible
mark; the sorted header carries ▲ / ▼.

**Column Configuration dialog**, opened by a ⚙ CUSTOMIZE COLUMNS button beside the table:
Available Columns (hidden, A–Z) on the left and Selected Columns (shown, in table order) on the
right, each with its own search box; → / ← (or a double-click) move a column across, ↑ / ↓ reorder
the selected one. Changes are staged and land on OK; Cancel, ✕, Escape or a click on the backdrop
discard them. RESET TO DEFAULT restores the default order and visibility and forgets every width.
The last selected column cannot be removed. A column declared `locked` cannot leave Selected.

**Resize.** A grip on each header's right edge; pointer capture keeps the drag alive off the grip.
Width is clamped (min 60 px, max 800 px). A double-click on the grip forgets that column's width.

**Persistence.** Order, hidden set and widths are a per-browser, per-table preference in
`localStorage` under `check-monitoring.table.<tableId>.v1` — presentation only, never sent to the
server except where stated below (EXPORT EXCEL's `cols=`). Every read is wrapped in try/catch and
sanitised against the table's current column list: unknown keys are dropped, new columns are
inserted at their default position, a locked column is forced visible. Read after mount so the
server render and the first client render agree.

## 2. Two modes

**Client mode** — the table holds all its rows in the browser. The kit sorts and filters them in
memory. Empty values sort last in both directions; ties keep their original order. A status line
above the table reads `N of M rows` with `✕ clear filters`; filter state is not persisted and not
in the URL.

**Server mode** — the page pages through more rows than it draws. The menu does not touch rows; it
navigates to a new URL built by `lib/table-kit/menu-to-params.ts` and the server filters and sorts
as it does today. Server mode is used by the main check list and the Audit screen only.

## 3. The main check list (server mode)

- The COLUMNS chooser and the filter-box row (`ColumnFilterCell`) are removed; the kit replaces
  both. `lib/column-filters.ts` remains the one parser and refusal point.
- The menu writes the parameters that exist today, and nothing new:
  - text columns: `f.checkNumber`, `f.apv`, `f.po`, `f.payee`;
  - enum: `f.status`, `company`, `cashAccount` (the menu offers the same options the old dropdowns
    did, keyed by id; the chip shows the label);
  - dates: CHECK DATE → `f.checkDateFrom/To`, AVAILABLE DATE → `f.availablePickupDateFrom/To`,
    PICKUP SCHEDULE → `f.scheduledPickupDateFrom/To`, DATE RELEASED → `releasedFrom/To`;
  - amount → `f.amountMin/Max`.
- Operator mapping onto From/To (inclusive Manila days): Equals → From = To = d; ≥ → From = d;
  ≤ → To = d; > → From = d + 1 day; < → To = d − 1 day; Is Between → From/To; Today and This Month
  → From/To. For amounts: Equals → Min = Max = a; ≥ → Min; ≤ → Max; Is Between → Min/Max. **Does
  Not Equal, and strict > / < on amounts, are not offered on this list** — the server has no
  parameter for them and inventing one is out of scope. Reading back, a From/To pair is shown as the
  operator that produced it (From = To → Equals; only From → ≥; only To → ≤; both → Is Between).
- Sort writes `sort=<key>&dir=asc|desc` and the `cm_sort` cookie exactly as the header click does
  today (`lib/list-sort.ts`); removing the sort removes both and falls back to the default.
- Every behaviour pinned in CLAUDE.md survives: an unreadable value refuses (no rows, the chip
  marked red with `FILTER_MESSAGES`), EXPORT EXCEL / PRINT drawn disabled while refused; SIGN ALL
  honours the filters and RELEASE ALL refuses any; the `f.*` and sort parameters remain LIST
  parameters for `dashboardScreen`; the excluded-incomplete count stays the list's own.
- Columns: CHECK NUMBER, STATUS and ACTION are `locked`. ACTION has no menu. A column carrying an
  active filter is shown even when hidden (as `activeFilterColumns` does today) and is not
  persisted as shown. EXPORT EXCEL keeps `cols=` in the viewer's order. The preference migrates
  from `check-monitoring.columns.v3` on first read (order and visibility; no widths), then is kept
  under the kit's key.

## 4. The transmittal picker (client mode)

Its filter boxes, header sort and column controls are replaced by the kit. The RELEASED toggle,
ADD ALL SHOWN (adds every matching row, not only the drawn 500) and the selection checkbox column
stay. Preferences migrate from `check-monitoring.transmittal.columns.v1` (order, visibility,
widths). `lib/transmittal-picker.ts` keeps the candidate shape; its filter and sort helpers are
replaced by the kit's.

## 5. Audit (server mode)

The menu writes the screen's existing filters: WHEN → its Manila from/to days (same operator
mapping as §3, no Does Not Equal), WHO → user, ACTION → action, CHECK → check number. Keyset
pagination on `(createdAt, id)` walks newest first only, so **no Audit column sorts** — every header
is `noSort` and the order stays newest first (amended 2026-10-13 while planning: an oldest-first
keyset is a server change this request did not ask for). REMARKS and DETAILS are `noFilter`. The SYSTEM ROWS toggle and the Excel
extract are unchanged.

## 6. Every other table (client mode)

`/vouchers`; NUMBERING's series table, its detail table and its NOT NUMERIC / OUT OF PATTERN tables
(which gain a header row); OUTSTANDING (`/recon` per account) and the RECON account table; CLEARING
paste preview; `/admin/portal`;
`/admin/staged` (checks and bills); `/admin/sync` runs; `/admin/users`; the import preview report's
tables.

- Where a page caps its rows — Staged (200 per list), Portal (200), Sync (25), Vouchers
  (`VOUCHER_SCREEN_ROW_LIMIT`), Import preview (`ROWS_SHOWN`) — the status line reads
  `N of the M rows shown`, so a filtered capped table never reads as the whole set.
- Totals rows (RECON) render in `<tfoot>`, are never sorted or filtered, and are not recomputed
  from the filtered rows.
- NUMBERING's detail table interleaves MISSING lines (full-width bands) with checks in number
  order. A band means something only in that order, so while any filter or sort is in force the
  bands are left out and the status line says so; clearing them brings the bands back.
- Buttons and form columns (USERS' ACTIONS, PORTAL's retry, CLEARING's confirm column) have no menu
  and are `locked`.

**Left alone:** the PRINT sheet (CLAUDE.md: "Print keeps its fixed columns"), the FORECAST matrix
(bucket × bank cells, not a list of records) and the PLANNED OUTFLOW list on `/forecast/planned`
(a list of cards with their own forms, not a table).

## 7. Units

| Unit | Responsibility |
| --- | --- |
| `lib/table-kit/match.ts` | Pure, browser-safe: `textMatch`, `enumMatch`, date and amount operators, `manilaToday`, Today / This Month ranges, `orderRows` (empties last, stable). Amount comparison on decimal strings. |
| `lib/table-kit/layout.ts` | Pure: `sanitizeLayout(stored, columns)`, `applyLayout`, migration from the two legacy keys, width clamp. |
| `lib/table-kit/menu-to-params.ts` | Pure: menu value ⇄ URL parameters for the main list and Audit, built on `lib/column-filters.ts`. |
| `lib/table-kit/types.ts` | `KitColumn = { key, label, kind: 'text'\|'enum'\|'date'\|'amount', options?, locked?, noSort?, noFilter?, defaultHidden?, defaultWidth? }`. |
| `components/table-kit/HeaderMenu.tsx` | The menu (portal to `document.body`), focus on open, Escape / outside click. |
| `components/table-kit/FilterChips.tsx` | Chips and the status line. |
| `components/table-kit/ColumnConfigDialog.tsx` | The dialog. |
| `components/table-kit/ResizeGrip.tsx` | The drag grip. |
| `components/table-kit/useTableLayout.ts` | Load / save / reset of the layout for one `tableId`. |
| `components/table-kit/KitTable.tsx` | Client mode: given columns, rows, a `cell(row, key)` renderer and a `value(row, key)` getter, draws the table with all of the above. |
| `components/table-kit/KitHeader.tsx` | Server mode: draws the header row only; the page keeps its body and calls `onFilter` / `onSort`, which navigate. |

Styling follows the app's existing tokens (navy, hairline, slate); no new CSS framework.

## 8. Testing

- Unit: `tests/table-kit/match.test.ts` (each operator, Manila Today / This Month at the day
  boundary, enum exactness, amount strings with commas, empties last), `layout.test.ts` (sanitise,
  locked, migration from both legacy keys), `menu-to-params.test.ts` (every operator both ways; an
  unreadable value still refuses through `column-filters`).
- Extended: `column-filters`, `dashboard-view`, `table-columns`, `export/dashboard-params`,
  `transmittal/picker`. Tests that drove the removed filter row are rewritten against the
  parameters the menu writes.
- Narrow runs of the affected files only, then `tsc --noEmit` and `next build`. Browser check in
  the preview against the TEST database — the repo `.env` is production and nothing is run locally
  against it.

## 9. Delivery

Branch `feature/table-kit` in worktree `cm-table-kit`, cut from `master`. One plan, two phases:
(1) the kit, the main check list and the transmittal picker; (2) Audit and every client-mode
table. No migration, no database change, no change to any status, import, sync or portal path.
