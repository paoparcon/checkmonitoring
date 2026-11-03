# AGING Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new `/aging` module that lists SIGNED checks in the Supplier Portal's aging buckets (days past the earliest due date of the bills each check pays) and lets Finance tick checks and mark them READY FOR RELEASE.

**Architecture:** The existing BILL_REFS read of Acumatica's `AP-Bills and Adjustments` also stores each bill's `DueDate` and `Terms` in a new reference table, `AcumaticaBillTerms`. A pure module (`lib/aging/buckets.ts`) ages a check from its bills. A server query loads the SIGNED population once, and a client picker built from the table kit (the TRANSMITTAL picker's pattern) draws the bucket strip, filters, selection and the MARK READY FOR RELEASE button. That button calls the existing `bulkReadyForReleaseAction` unchanged. An Excel export ages the same population.

**Tech Stack:** Next.js 15 App Router, Prisma 6 / PostgreSQL (Neon), Vitest, ExcelJS, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-10-15-aging-module-design.md`

## Global Constraints

- Work only in the worktree `C:\Users\User\Desktop\RCL PROJECTS\cm-aging` on branch `feature/aging`. Never commit in the main checkout.
- **Local `.env` is production.** No script, dev server or migration runs against it unless the task says so and the user has said yes in chat.
- Amounts are decimal strings end to end (rule 8). Totals are summed in centavos as BigInt with `amountToCentavos` (`lib/transmittal.ts`). Use `BigInt(0)`, never `0n` literals (Next's file tracer breaks on them).
- Acumatica is read-only (rule 3). Only `fetchAll` / `fetchPage` of the existing client.
- An import never changes a check's status (rule 4). The only status change in this feature is SIGNED → READY_FOR_RELEASE through `bulkReadyForReleaseAction`.
- Buckets, exactly: `current` CURRENT (≤ 0 days past due), `b30` 1–30 DAYS, `b60` 31–60 DAYS, `b90` 61–90 DAYS, `b90plus` OVER 90 DAYS (> 90), `noDue` NO DUE DATE. OVERDUE = b30 + b60 + b90 + b90plus.
- Never-aging terms (a terms code that, upper-cased with all whitespace removed, starts with): `COD`, `PDC`, `DATCHECK`, `DATEDCHECK`, `100PBD`, `100BPD`.
- Days are Manila calendar days (`manilaToday` in `lib/manila-day.ts`).
- Population: `status = SIGNED`, `isCheque = true`, `isIncomplete = false`.
- Spell "check", not "cheque", in new code, copy and comments.
- Windows: run tools as `node node_modules/vitest/vitest.mjs run <files>` and `node node_modules/typescript/bin/tsc --noEmit` from Git Bash. Run only the test files a task names. The full suite takes 30+ minutes and the TEST database is shared with other sessions.
- Before any test run: `node node_modules/prisma/build/index.js generate` from this worktree (the Prisma client is shared through the `node_modules` junction).
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

### Deliberate changes from the spec (made while planning, against the code)

1. **Filters are the table kit's column filters, held in the browser**, as on TRANSMITTAL (`components/TransmittalPicker.tsx`), not URL parameters. SIGNED is about 1,400 checks, which TRANSMITTAL already loads whole. The kit's `needleError` marks an unreadable box red and the kit matches nothing for it, so an unreadable box still refuses rather than widening.
2. **The export ages the whole SIGNED population**, with no filter parameters. Its SUMMARY sheet carries bucket × bank, so a bank's figure is read off the sheet. The file says it covers all SIGNED checks.
3. The pure functions are named `neverAges`, `daysPastDue`, `bucketOfDays` and `ageCheck`, not `agingBucketFor` / `checkDueDate`.

Task 0 writes these into the spec.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/probe-bill-terms.ts` (create) | One-off, read-only: prints the column names and five rows of `AP-Bills and Adjustments` per tenant. |
| `prisma/schema.prisma` (modify) | `AcumaticaBillTerms` model. |
| `prisma/migrations/20261015000100_acumatica_bill_terms/migration.sql` (create) | The table. |
| `tests/helpers/db.ts` (modify) | `resetDb` truncates the new table. |
| `lib/integrations/acumatica/bill-refs.ts` (modify) | `BILL_REF_COLUMNS.dueDate` / `.terms`; `mapBillRef` returns `dueDate`, `termsCode`. |
| `lib/sync/bill-refs.ts` (modify) | Writes `AcumaticaBillTerms` for every in-scope bill; `termsWritten` in the result. |
| `scripts/sync.ts` (modify) | `--bill-refs` snapshots the new table too, and prints the terms counts. |
| `lib/aging/buckets.ts` (create) | Pure bucket rule. |
| `lib/aging/query.ts` (create) | The SIGNED population as `AgingRow[]`. |
| `lib/aging-picker.ts` (create) | Pure: kit columns, row values, bucket strip totals, cap check. |
| `components/AgingPicker.tsx` (create) | Client: strip, kit table, selection, MARK READY FOR RELEASE. |
| `app/aging/page.tsx` (create) | The page. |
| `lib/module-nav.ts` (modify) | `AGING` module. |
| `lib/export/aging-workbook.ts` (create) | SUMMARY + one sheet per bucket. |
| `app/api/export/aging/route.ts` (create) | The download. |
| `CLAUDE.md` (modify) | One paragraph on AGING; the first-fill command. |

---

### Task 0: Worktree setup; record the planning changes in the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-aging-module-design.md`

- [ ] **Step 0: Link node_modules and .env into the worktree (not committed)**

From Git Bash in `C:\Users\User\Desktop\RCL PROJECTS\cm-aging`:

```bash
cp "../Check Monitoring/.env" .env
cmd //c mklink //J node_modules "..\\Check Monitoring\\node_modules"
ls node_modules/vitest/vitest.mjs node_modules/prisma/build/index.js node_modules/tsx/dist/cli.mjs
```

Expected: the three paths are listed. `.env` and `node_modules` are git-ignored; confirm with `git status --short`, which must not show them.

- [ ] **Step 1: Edit the spec**

Replace the paragraph starting `**Filters (URL parameters):**` with:

```markdown
**Filters:** the table kit's per-column filters, held in the browser as on TRANSMITTAL (COMPANY,
BANK and BUCKET are dropdowns; CHECK NO., CV, APV, PO, PAYEE text; dates and AMOUNT ranges). An
unreadable box is marked red and matches nothing; it never widens. The population is about 1,400
checks and is loaded whole.
```

Replace the `**Export:**` paragraph with:

```markdown
**Export:** EXPORT EXCEL (`/api/export/aging`): every SIGNED check in the population, no filters.
A SUMMARY sheet (bucket × count × amount, then bucket × bank) and one sheet per non-empty bucket
with the table's columns. The title block says "ALL SIGNED CHECKS". Read-only.
```

In the Units table, change the `lib/aging/buckets.ts` row's "Does" cell to
`` `neverAges`, `daysPastDue`, `bucketOfDays`, `ageCheck`. Pure. `` and the dependency to
`` `manilaToday` ``. Change `lib/aging-view.ts` to
`` `lib/aging-picker.ts` | Kit columns, row values, strip totals, cap check. Pure. | table kit types ``.

In "The buckets" section, replace `` `agingBucketFor(dueDate, termsCode, today)` and `checkDueDate(bills)` `` with `` `ageCheck(bills, now)` ``.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-15-aging-module-design.md
git commit -m "docs(spec): AGING - browser-side kit filters, whole-population export

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: Measure DueDate and Terms in Acumatica (GATE)

The whole data side depends on `AP-Bills and Adjustments` publishing a due date and a terms code. Measure before building.

**Files:**
- Create: `scripts/probe-bill-terms.ts`

- [ ] **Step 1: Write the probe**

```ts
/**
 * Read-only probe (2026-10-15, AGING plan task 1): does AP-Bills and
 * Adjustments publish a due date and a terms code, and under what names?
 * One $top=5 GET per tenant through the read-only client. Writes nothing,
 * touches no database.
 *
 *   npx.cmd tsx scripts/probe-bill-terms.ts
 */
import 'dotenv/config'
import { createAcumaticaClient } from '../lib/integrations/acumatica/client'
import { BILL_REFS_FEED } from '../lib/integrations/acumatica/bill-refs'

const TENANTS = { GOLIVE: 'ACUMATICA_ODATA_URL', MANUFACTURING: 'ACUMATICA_ODATA_URL_MFG' } as const

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

async function main() {
  for (const [tenant, urlVar] of Object.entries(TENANTS)) {
    const client = createAcumaticaClient({
      baseUrl: env(urlVar), user: env('ACUMATICA_ODATA_USER'), password: env('ACUMATICA_ODATA_PASSWORD'),
    })
    const rows = await client.fetchPage(BILL_REFS_FEED, { top: 5, filter: "Type eq 'Bill'" })
    const columns = rows.length > 0 ? Object.keys(rows[0]).sort() : []
    console.log(`\n${tenant}: ${rows.length} rows`)
    console.log(`COLUMNS  ${columns.join(', ')}`)
    const wanted = columns.filter((c) => /due|term/i.test(c))
    console.log(`DUE/TERMS COLUMNS  ${wanted.join(', ') || '(none)'}`)
    for (const r of rows) {
      console.log('  ' + ['ReferenceNbr', ...wanted].map((c) => `${c}=${JSON.stringify(r[c])}`).join('  '))
    }
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1 })
```

- [ ] **Step 2: Ask the user before running it**

It reads production Acumatica with the local `.env` credentials. It writes nothing. Ask in chat:
"May I run `npx.cmd tsx scripts/probe-bill-terms.ts`? It makes one read-only request per tenant and writes nothing." Wait for a yes.

- [ ] **Step 3: Run it**

Run: `npx.cmd tsx scripts/probe-bill-terms.ts` (PowerShell) or `node node_modules/tsx/dist/cli.mjs scripts/probe-bill-terms.ts` (Git Bash).
Expected: for each tenant, a `DUE/TERMS COLUMNS` line naming a due-date column (assumed `DueDate`) and a terms column (assumed `Terms`), with day values like `"2026-10-29T00:00:00"` and codes like `"30D"`.

- [ ] **Step 4: Decide**

- Both tenants publish both columns → record the exact names. If they are not `DueDate` / `Terms`, use the measured names in Task 3's `BILL_REF_COLUMNS` and everywhere this plan writes `DueDate` / `Terms` in test rows. Continue.
- Either tenant lacks either column → **STOP.** Report the output to the user. The spec's fallback (CheckBill only) needs their go-ahead before any further task.

- [ ] **Step 5: Commit the probe with the measurement in its header**

Add one line to the probe's doc comment: `Measured 2026-10-15: GOLIVE <names>, MANUFACTURING <names>.`

```bash
git add scripts/probe-bill-terms.ts
git commit -m "chore(scripts): probe AP-Bills and Adjustments for DueDate and Terms (read-only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `AcumaticaBillTerms` table

**Files:**
- Modify: `prisma/schema.prisma` (after `model AcumaticaBill`)
- Create: `prisma/migrations/20261015000100_acumatica_bill_terms/migration.sql`
- Modify: `tests/helpers/db.ts` (next to `await tx.acumaticaBill.deleteMany()`)
- Test: `tests/schema.test.ts`

**Interfaces:**
- Produces: Prisma model `acumaticaBillTerms` with `apvNumber` (id), `tenant`, `dueDate: Date | null`, `termsCode: string | null`, `lastModifiedOn: Date | null`, `updatedAt`.

- [ ] **Step 1: Check the migration timestamp is the latest**

Run: `ls prisma/migrations | tail -3; ls "../Check Monitoring/prisma/migrations" | tail -3; ls ../cm-self-registration/prisma/migrations | tail -3`
Expected: nothing later than `20261015000100`. If there is, use a later timestamp in this task's migration folder name.

- [ ] **Step 2: Write the failing schema test**

Append to `tests/schema.test.ts`:

```ts
describe('AcumaticaBillTerms', () => {
  const APV = `TEST-SCHEMA-TERMS-${Date.now()}`
  afterAll(async () => {
    await prisma.acumaticaBillTerms.deleteMany({ where: { apvNumber: APV } })
  })

  it('is keyed by the APV alone, and both values may be absent', async () => {
    await prisma.acumaticaBillTerms.create({ data: { apvNumber: APV, tenant: 'GOLIVE' } })
    await expect(prisma.acumaticaBillTerms.create({
      data: { apvNumber: APV, tenant: 'MANUFACTURING', termsCode: '30D' },
    })).rejects.toThrow()
    const row = await prisma.acumaticaBillTerms.findUniqueOrThrow({ where: { apvNumber: APV } })
    expect(row.dueDate).toBeNull()
    expect(row.termsCode).toBeNull()
    expect(row.lastModifiedOn).toBeNull()
    expect(row.updatedAt).toBeInstanceOf(Date)
  })
})
```

- [ ] **Step 3: Add the model**

In `prisma/schema.prisma`, after `model AcumaticaBill { … }`:

```prisma
/// A bill's due date and terms, from Acumatica's AP-Bills and Adjustments
/// (spec 2026-10-15-aging-module-design.md). Reference data like
/// AcumaticaBill: no Check relation, no audit row. Written by the BILL_REFS
/// read for EVERY in-scope Bill / Prepayment, blank Vendor Ref included, and
/// never deleted. A separate table because every AcumaticaBill row reads as
/// "this bill names a PO".
model AcumaticaBillTerms {
  // `ReferenceNbr`, trimmed and upper-cased — the APV.
  apvNumber      String    @id
  // GOLIVE or MANUFACTURING: the tenant whose read last wrote the row.
  tenant         String
  // `DueDate`, a calendar day (UTC midnight).
  dueDate        DateTime?
  // `Terms`, trimmed, otherwise verbatim.
  termsCode      String?
  lastModifiedOn DateTime?
  updatedAt      DateTime  @updatedAt
}
```

- [ ] **Step 4: Write the migration**

`prisma/migrations/20261015000100_acumatica_bill_terms/migration.sql`:

```sql
-- AGING (spec 2026-10-15): each AP bill's due date and terms, mirrored from
-- Acumatica by the BILL_REFS read. Reference data; no FK to "Check".
CREATE TABLE "AcumaticaBillTerms" (
    "apvNumber" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "termsCode" TEXT,
    "lastModifiedOn" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcumaticaBillTerms_pkey" PRIMARY KEY ("apvNumber")
);
```

- [ ] **Step 5: Truncate it in tests**

In `tests/helpers/db.ts`, directly after `await tx.acumaticaBill.deleteMany()`, add:

```ts
    await tx.acumaticaBillTerms.deleteMany()
```

- [ ] **Step 6: Generate, migrate TEST, run the test**

Ask the peer sessions (ListAgents / SendMessage) before touching the TEST database, as the shared-checkout memory says. Then:

```bash
node node_modules/prisma/build/index.js generate
node scripts/migrate.mjs test
node node_modules/vitest/vitest.mjs run tests/schema.test.ts
```

Expected: the migration applies; `AcumaticaBillTerms` test PASS; every other schema test still PASS.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261015000100_acumatica_bill_terms tests/helpers/db.ts tests/schema.test.ts
git commit -m "feat(schema): AcumaticaBillTerms - each AP bill's due date and terms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Map DueDate and Terms from the feed

**Files:**
- Modify: `lib/integrations/acumatica/bill-refs.ts` (`BILL_REF_COLUMNS`, `BillRef`, `mapBillRef`)
- Test: `tests/integrations/acumatica-bill-refs.test.ts`

**Interfaces:**
- Produces: `BillRef` gains `dueDate: Date | null` (UTC midnight of the stated day) and `termsCode: string | null` (trimmed, null when blank). `billRefsSelect()` includes both columns.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integrations/acumatica-bill-refs.test.ts`:

```ts
describe('mapBillRef — due date and terms (AGING, 2026-10-15)', () => {
  const row = (o: Record<string, unknown> = {}) => ({
    Type: 'Bill', ReferenceNbr: 'AP-ST044591', Date: '2026-09-29T00:00:00',
    VendorRef: 'PO-ST-031109', LastModifiedOn: '2026-09-29T08:15:00',
    DueDate: '2026-10-29T00:00:00', Terms: ' 30D ', ...o,
  })

  it('reads the due date as a day and the terms trimmed', () => {
    const ref = mapBillRef(row())!
    expect(ref.dueDate).toEqual(new Date('2026-10-29T00:00:00Z'))
    expect(ref.termsCode).toBe('30D')
  })

  it('a missing or blank value is null, and the bill is still mapped', () => {
    const ref = mapBillRef(row({ DueDate: null, Terms: '   ' }))!
    expect(ref.apvNumber).toBe('AP-ST044591')
    expect(ref.dueDate).toBeNull()
    expect(ref.termsCode).toBeNull()
  })

  it('a bill with a blank Vendor Ref still carries its terms', () => {
    const ref = mapBillRef(row({ VendorRef: '' }))!
    expect(ref.vendorRef).toBe('')
    expect(ref.termsCode).toBe('30D')
  })

  it('selects both columns', () => {
    expect(billRefsSelect()).toEqual(expect.arrayContaining([BILL_REF_COLUMNS.dueDate, BILL_REF_COLUMNS.terms]))
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-bill-refs.test.ts`
Expected: FAIL. `ref.dueDate` is undefined; `BILL_REF_COLUMNS.dueDate` is undefined.

- [ ] **Step 3: Implement**

In `lib/integrations/acumatica/bill-refs.ts`:

```ts
export const BILL_REF_COLUMNS = {
  type: 'Type',
  ref: 'ReferenceNbr',
  date: 'Date',
  vendorRef: 'VendorRef',
  lastModified: 'LastModifiedOn',
  // AGING (2026-10-15): measured on both tenants by scripts/probe-bill-terms.ts.
  dueDate: 'DueDate',
  terms: 'Terms',
} as const
```

Add to the `BillRef` type:

```ts
  /** `DueDate` as a calendar day (UTC midnight); null when the feed states none. */
  dueDate: Date | null
  /** `Terms`, trimmed; null when blank. */
  termsCode: string | null
```

In `mapBillRef`'s returned object, add:

```ts
    dueDate: naiveDate(r[BILL_REF_COLUMNS.dueDate], { dayOnly: true }),
    termsCode: text(r[BILL_REF_COLUMNS.terms]) || null,
```

- [ ] **Step 4: Run them and see them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/integrations/acumatica-bill-refs.test.ts`
Expected: PASS, the existing cases included.

- [ ] **Step 5: Type-check**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no errors. Any code building a `BillRef` literal (for example `scripts/sync.ts` or tests) must get the two new fields. Fix each error by adding `dueDate: null, termsCode: null`.

- [ ] **Step 6: Commit**

```bash
git add lib/integrations/acumatica/bill-refs.ts tests/integrations/acumatica-bill-refs.test.ts
git commit -m "feat(bill-refs): read each bill's DueDate and Terms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The BILL_REFS read writes `AcumaticaBillTerms`

**Files:**
- Modify: `lib/sync/bill-refs.ts`
- Modify: `scripts/sync.ts` (`billRefs()`)
- Test: `tests/sync/bill-refs.test.ts`

**Interfaces:**
- Consumes: `BillRef.dueDate`, `BillRef.termsCode` (Task 3); `prisma.acumaticaBillTerms` (Task 2).
- Produces: `BillRefsRunResult.termsWritten: number`, the terms rows inserted or changed.

- [ ] **Step 1: Write the failing tests**

Append to `tests/sync/bill-refs.test.ts` (it already has `docRow`, `read`, `testDb`, `NOW`):

```ts
describe('AcumaticaBillTerms (AGING, 2026-10-15)', () => {
  it('writes every in-scope bill, blank Vendor Ref included, and leaves AcumaticaBill as it was', async () => {
    const { result } = read([
      docRow({ ReferenceNbr: 'AP-ST000001', DueDate: '2026-10-29T00:00:00', Terms: '30D' }),
      docRow({ ReferenceNbr: 'AP-ST000002', VendorRef: '', DueDate: '2026-11-15T00:00:00', Terms: 'COD' }),
    ])
    const res = await result
    expect(res.termsWritten).toBe(2)
    const terms = await testDb.acumaticaBillTerms.findMany({ orderBy: { apvNumber: 'asc' } })
    expect(terms.map((t) => [t.apvNumber, t.tenant, t.dueDate?.toISOString().slice(0, 10), t.termsCode])).toEqual([
      ['AP-ST000001', 'GOLIVE', '2026-10-29', '30D'],
      ['AP-ST000002', 'GOLIVE', '2026-11-15', 'COD'],
    ])
    expect((await testDb.acumaticaBill.findMany()).map((b) => b.apvNumber)).toEqual(['AP-ST000001'])
  })

  it('updates a changed bill, counts an unchanged one as not written, never deletes', async () => {
    await (read([docRow({ ReferenceNbr: 'AP-ST000001', DueDate: '2026-10-29T00:00:00', Terms: '30D' })]).result)
    const again = await (read([docRow({ ReferenceNbr: 'AP-ST000001', DueDate: '2026-10-29T00:00:00', Terms: '30D' })]).result)
    expect(again.termsWritten).toBe(0)
    const changed = await (read([docRow({ ReferenceNbr: 'AP-ST000001', DueDate: '2026-11-28T00:00:00', Terms: '60D' })]).result)
    expect(changed.termsWritten).toBe(1)
    const row = await testDb.acumaticaBillTerms.findUniqueOrThrow({ where: { apvNumber: 'AP-ST000001' } })
    expect(row.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-28')
    expect(row.termsCode).toBe('60D')
    // A Vendor Ref going blank deletes the AcumaticaBill row, never the terms.
    await (read([docRow({ ReferenceNbr: 'AP-ST000001', VendorRef: '', DueDate: '2026-11-28T00:00:00', Terms: '60D' })]).result)
    expect(await testDb.acumaticaBill.count()).toBe(0)
    expect(await testDb.acumaticaBillTerms.count()).toBe(1)
  })

  it('a bill the feed gives neither value is still recorded, as nulls', async () => {
    await (read([docRow({ ReferenceNbr: 'AP-ST000003' })]).result)
    const row = await testDb.acumaticaBillTerms.findUniqueOrThrow({ where: { apvNumber: 'AP-ST000003' } })
    expect(row.dueDate).toBeNull()
    expect(row.termsCode).toBeNull()
  })
})
```

(`docRow`'s default has no `DueDate` / `Terms`, which is what the third case relies on.)

- [ ] **Step 2: Run them and see them fail**

Run: `node node_modules/prisma/build/index.js generate && node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts`
Expected: the three new cases FAIL (`termsWritten` undefined, no rows).

- [ ] **Step 3: Implement**

In `lib/sync/bill-refs.ts`:

1. Add `termsWritten: number` to `BillRefsRunResult` with the doc comment `/** AcumaticaBillTerms rows actually written (inserted, or changed). AGING, 2026-10-15. */`.
2. After `let noPo = 0`, add `let termsWritten = 0`.
3. After the `drop` loop and before the watermark is computed, add:

```ts
  // AGING (2026-10-15): every in-scope bill's due date and terms, blank Vendor
  // Ref or not, into their own table. Never deleted. A failed batch holds the
  // watermark like any other.
  const allRefs = [...byApv.values()]
  for (let i = 0; i < allRefs.length; i += WRITE_BATCH) {
    const batch = allRefs.slice(i, i + WRITE_BATCH)
    try {
      termsWritten += await upsertTermsBatch(db, tenant, batch)
    } catch (error) {
      errors++
      problems.push(`terms ${batch[0].apvNumber}…${batch[batch.length - 1].apvNumber}: ${describe(error)}`)
    }
  }
```

4. Add `termsWritten` to the returned object.
5. Add below `upsertBatch`:

```ts
/** `upsertBatch`'s shape for AcumaticaBillTerms: one statement, a no-op for an unchanged bill. */
async function upsertTermsBatch(db: Db, tenant: AcumaticaTenant, batch: readonly BillRef[]): Promise<number> {
  const payload = JSON.stringify(batch.map((b) => ({
    apvNumber: b.apvNumber,
    tenant,
    dueDate: b.dueDate?.toISOString() ?? null,
    termsCode: b.termsCode,
    lastModifiedOn: b.lastModifiedOn?.toISOString() ?? null,
  })))
  return db.$executeRaw(Prisma.sql`
    INSERT INTO "AcumaticaBillTerms" ("apvNumber", "tenant", "dueDate", "termsCode", "lastModifiedOn", "updatedAt")
    SELECT x."apvNumber", x."tenant", x."dueDate", x."termsCode", x."lastModifiedOn", (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS x("apvNumber" text, "tenant" text, "dueDate" timestamp(3), "termsCode" text, "lastModifiedOn" timestamp(3))
    ON CONFLICT ("apvNumber") DO UPDATE
       SET "tenant" = EXCLUDED."tenant",
           "dueDate" = EXCLUDED."dueDate",
           "termsCode" = EXCLUDED."termsCode",
           "lastModifiedOn" = EXCLUDED."lastModifiedOn",
           "updatedAt" = EXCLUDED."updatedAt"
     WHERE ("AcumaticaBillTerms"."tenant", "AcumaticaBillTerms"."dueDate", "AcumaticaBillTerms"."termsCode", "AcumaticaBillTerms"."lastModifiedOn")
           IS DISTINCT FROM (EXCLUDED."tenant", EXCLUDED."dueDate", EXCLUDED."termsCode", EXCLUDED."lastModifiedOn")`)
}
```

6. Extend the file's top doc comment with one sentence: `Since 2026-10-15 it also writes every in-scope bill's DueDate and Terms to AcumaticaBillTerms (AGING), blank Vendor Ref included, never deleted.`

- [ ] **Step 4: Run them and see them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/sync/bill-refs.test.ts tests/sync/cron-route.test.ts`
Expected: PASS, existing cases included. If an existing case uses `toEqual` on the whole result object, add `termsWritten: <n>` to its expectation.

- [ ] **Step 5: The script snapshots and reports the new table**

In `scripts/sync.ts` `billRefs()`:

In the DRY branch, after `withPo`, add `const withDue = inScope.filter((b) => b.dueDate !== null).length` and change the log line's tail to
`` `bills dated 2024 or later, ${withPo.toLocaleString()} naming a PO, ${withDue.toLocaleString()} with a due date. Nothing was written.\n` ``.

Replace the snapshot block's `before` and `writeFile` lines with:

```ts
  const before = await db.acumaticaBill.findMany({ orderBy: { apvNumber: 'asc' } })
  const termsBefore = await db.acumaticaBillTerms.findMany({ orderBy: { apvNumber: 'asc' } })
  await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
  const snap = join(
    process.cwd(), 'snapshots', `bill-refs-${t}-${now.toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), tenant: t, rows: before, terms: termsBefore }, null, 2))
  console.log(`SNAPSHOT    ${snap} (${before.length.toLocaleString()} bills, ${termsBefore.length.toLocaleString()} terms)`)
```

After the `ref but no PO` line add:

```ts
  console.log(`  terms rows written            ${res.termsWritten.toLocaleString()}`)
```

Update the script's header comment for `--bill-refs`: `…mirrored into AcumaticaBill and AcumaticaBillTerms (due date and terms, AGING)…`, and say the snapshot covers both tables.

- [ ] **Step 6: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit`. Expected: no errors.

```bash
git add lib/sync/bill-refs.ts scripts/sync.ts tests/sync/bill-refs.test.ts
git commit -m "feat(bill-refs): mirror each bill's due date and terms into AcumaticaBillTerms

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The bucket rule

**Files:**
- Create: `lib/aging/buckets.ts`
- Test: `tests/aging/buckets.test.ts`

**Interfaces:**
- Consumes: `manilaToday(now: Date): string` from `lib/manila-day.ts`.
- Produces:
  - `AGING_BUCKETS: readonly ['current','b30','b60','b90','b90plus','noDue']`, `type AgingBucket`
  - `AGING_LABELS: Record<AgingBucket, string>`
  - `OVERDUE_BUCKETS: readonly AgingBucket[]` (`b30`, `b60`, `b90`, `b90plus`)
  - `neverAges(terms: string | null): boolean`
  - `daysPastDue(dueDate: Date, now: Date): number`
  - `bucketOfDays(days: number): Exclude<AgingBucket, 'noDue'>`
  - `type BillTerms = { dueDate: Date | null; termsCode: string | null }`
  - `type CheckAging = { dueDate: Date | null; daysPastDue: number | null; bucket: AgingBucket }`
  - `ageCheck(bills: readonly BillTerms[], now: Date): CheckAging`

- [ ] **Step 1: Write the failing tests**

`tests/aging/buckets.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  AGING_BUCKETS, AGING_LABELS, OVERDUE_BUCKETS, neverAges, daysPastDue, bucketOfDays, ageCheck,
} from '@/lib/aging/buckets'

// 15 Oct 2026, 10:00 Manila.
const NOW = new Date('2026-10-15T10:00:00+08:00')
const day = (d: string) => new Date(`${d}T00:00:00Z`)

describe('the buckets are the Supplier Portal\'s', () => {
  it('lists them in order with their labels', () => {
    expect(AGING_BUCKETS).toEqual(['current', 'b30', 'b60', 'b90', 'b90plus', 'noDue'])
    expect(AGING_BUCKETS.map((b) => AGING_LABELS[b])).toEqual([
      'CURRENT', '1–30 DAYS', '31–60 DAYS', '61–90 DAYS', 'OVER 90 DAYS', 'NO DUE DATE',
    ])
    expect(OVERDUE_BUCKETS).toEqual(['b30', 'b60', 'b90', 'b90plus'])
  })

  it.each([
    [-5, 'current'], [0, 'current'], [1, 'b30'], [30, 'b30'], [31, 'b60'], [60, 'b60'],
    [61, 'b90'], [90, 'b90'], [91, 'b90plus'], [400, 'b90plus'],
  ] as const)('%i days past due is %s', (d, bucket) => {
    expect(bucketOfDays(d)).toBe(bucket)
  })
})

describe('daysPastDue — Manila calendar days', () => {
  it('counts whole days from the due day to today', () => {
    expect(daysPastDue(day('2026-10-14'), NOW)).toBe(1)
    expect(daysPastDue(day('2026-10-15'), NOW)).toBe(0)
    expect(daysPastDue(day('2026-10-20'), NOW)).toBe(-5)
  })

  it('at 00:30 Manila it is already the 15th (UTC still says the 14th)', () => {
    expect(daysPastDue(day('2026-10-14'), new Date('2026-10-15T00:30:00+08:00'))).toBe(1)
  })

  it('a due date stored at Manila midnight is the same day as one at UTC midnight', () => {
    expect(daysPastDue(new Date('2026-10-14T00:00:00+08:00'), NOW)).toBe(1)
  })
})

describe('neverAges — COD, PDC, dated check, 100PBD', () => {
  it.each(['COD', 'cod', 'PDC7', 'PDC 30', 'DAT CHECK', 'Dated Check', '100PBD', '100 BPD'])('%s never ages', (t) => {
    expect(neverAges(t)).toBe(true)
  })
  it.each(['30D', 'NET 45', '', null, 'C.O.D'])('%s ages', (t) => {
    expect(neverAges(t)).toBe(false)
  })
})

describe('ageCheck — the earliest due date of the bills a check pays', () => {
  it('takes the earliest dated bill', () => {
    const a = ageCheck([
      { dueDate: day('2026-09-30'), termsCode: '30D' },
      { dueDate: day('2026-07-01'), termsCode: '30D' },
    ], NOW)
    expect(a.dueDate).toEqual(day('2026-07-01'))
    expect(a.daysPastDue).toBe(106)
    expect(a.bucket).toBe('b90plus')
  })

  it('a never-aging bill gives no date; a dated bill beside it still decides', () => {
    const a = ageCheck([
      { dueDate: day('2026-01-01'), termsCode: 'PDC30' },
      { dueDate: day('2026-10-01'), termsCode: '30D' },
    ], NOW)
    expect(a.dueDate).toEqual(day('2026-10-01'))
    expect(a.bucket).toBe('b30')
  })

  it('only never-aging bills: CURRENT, with no date', () => {
    expect(ageCheck([{ dueDate: day('2026-01-01'), termsCode: 'COD' }], NOW))
      .toEqual({ dueDate: null, daysPastDue: 0, bucket: 'current' })
  })

  it('no bills, or no dates: NO DUE DATE', () => {
    expect(ageCheck([], NOW)).toEqual({ dueDate: null, daysPastDue: null, bucket: 'noDue' })
    expect(ageCheck([{ dueDate: null, termsCode: '30D' }], NOW).bucket).toBe('noDue')
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/aging/buckets.test.ts`
Expected: FAIL, cannot resolve `@/lib/aging/buckets`.

- [ ] **Step 3: Implement**

`lib/aging/buckets.ts`:

```ts
import { manilaToday } from '@/lib/manila-day'

/**
 * AGING — the Supplier Portal's buckets (spec 2026-10-15-aging-module-design.md).
 *
 * Copied as a rule from `Supplier Portal/src/aging/store.js` (`bucketOf`) and
 * `src/data/due.js` (`neverAges`), never fetched: the portal client sends only
 * (rule 12). The axis is days past DUE DATE, not the check date, which is
 * why this is not `lib/forecast/buckets.ts`. Pure: `now` is passed in.
 */

export const AGING_BUCKETS = ['current', 'b30', 'b60', 'b90', 'b90plus', 'noDue'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

export const AGING_LABELS: Record<AgingBucket, string> = {
  current: 'CURRENT',
  b30: '1–30 DAYS',
  b60: '31–60 DAYS',
  b90: '61–90 DAYS',
  b90plus: 'OVER 90 DAYS',
  noDue: 'NO DUE DATE',
}

export const OVERDUE_BUCKETS: readonly AgingBucket[] = ['b30', 'b60', 'b90', 'b90plus']

// The portal's user ruling of 2026-10-08: COD, PDC, dated checks and 100PBD
// are always current. Compared with every space removed, so "PDC 30" is PDC30.
const NEVER_AGES_PREFIXES = ['COD', 'PDC', 'DATCHECK', 'DATEDCHECK', '100PBD', '100BPD']

export function neverAges(terms: string | null): boolean {
  const key = (terms ?? '').toUpperCase().replace(/\s+/g, '')
  return key !== '' && NEVER_AGES_PREFIXES.some((p) => key.startsWith(p))
}

const DAY_MS = 24 * 60 * 60 * 1000
const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)

/** Whole Manila days from the due day to today; positive once it is overdue. */
export function daysPastDue(dueDate: Date, now: Date): number {
  return Math.round((dayMs(manilaToday(now)) - dayMs(manilaToday(dueDate))) / DAY_MS)
}

export function bucketOfDays(days: number): Exclude<AgingBucket, 'noDue'> {
  if (days <= 0) return 'current'
  if (days <= 30) return 'b30'
  if (days <= 60) return 'b60'
  if (days <= 90) return 'b90'
  return 'b90plus'
}

export type BillTerms = { dueDate: Date | null; termsCode: string | null }
export type CheckAging = { dueDate: Date | null; daysPastDue: number | null; bucket: AgingBucket }

/**
 * A check pays one or more bills; the earliest due date among the bills that
 * age decides — the most overdue bill is the one that matters. A never-aging
 * bill contributes no date. Only never-aging bills: CURRENT. Nothing dated:
 * NO DUE DATE.
 */
export function ageCheck(bills: readonly BillTerms[], now: Date): CheckAging {
  let earliest: Date | null = null
  let anyNeverAges = false
  for (const b of bills) {
    if (neverAges(b.termsCode)) { anyNeverAges = true; continue }
    if (b.dueDate && (earliest === null || b.dueDate < earliest)) earliest = b.dueDate
  }
  if (earliest) {
    const days = daysPastDue(earliest, now)
    return { dueDate: earliest, daysPastDue: days, bucket: bucketOfDays(days) }
  }
  if (anyNeverAges) return { dueDate: null, daysPastDue: 0, bucket: 'current' }
  return { dueDate: null, daysPastDue: null, bucket: 'noDue' }
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/aging/buckets.test.ts`
Expected: PASS. `C.O.D` ages because the dots stay in the key; that matches the portal, which keeps punctuation.

- [ ] **Step 5: Commit**

```bash
git add lib/aging/buckets.ts tests/aging/buckets.test.ts
git commit -m "feat(aging): the Supplier Portal's buckets, aged on the earliest bill due date

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The SIGNED population, aged

**Files:**
- Create: `lib/aging/query.ts`
- Test: `tests/aging/query.test.ts`

**Interfaces:**
- Consumes: `listChecks`, `toTableRow`, `displayApvNumbers` (`lib/queries.ts`); `ageCheck`, `AgingBucket` (Task 5); `prisma.acumaticaBillTerms` (Task 2).
- Produces:

```ts
export type AgingRow = {
  id: string
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  payee: string | null
  company: string
  bank: string | null        // check book code, else cash account label
  checkDate: string | null   // YYYY-MM-DD
  dueDate: string | null     // YYYY-MM-DD
  daysPastDue: number | null
  bucket: AgingBucket
  amount: string | null
  currency: string
}
export const AGING_LIMIT = 25_000
export async function loadAgingRows(db, now: Date): Promise<{ rows: AgingRow[]; truncated: boolean }>
```

- [ ] **Step 1: Write the failing tests**

`tests/aging/query.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { loadAgingRows } from '@/lib/aging/query'

const NOW = new Date('2026-10-15T10:00:00+08:00')
const day = (d: string) => new Date(`${d}T00:00:00Z`)

beforeEach(resetDb)

describe('loadAgingRows', () => {
  it('is SIGNED real checks with an amount, nothing else', async () => {
    const keep = await makeCheck({ status: 'SIGNED', checkNumber: '6000000001' })
    await makeCheck({ status: 'SIGNATURE_PENDING', checkNumber: '6000000002' })
    await makeCheck({ status: 'READY_FOR_RELEASE', checkNumber: '6000000003' })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000004', isCheque: false })
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000005', amount: null })
    const { rows, truncated } = await loadAgingRows(testDb, NOW)
    expect(rows.map((r) => r.id)).toEqual([keep.id])
    expect(truncated).toBe(false)
  })

  it('ages a check by the earliest Acumatica due date of its APVs', async () => {
    const c = await makeCheck({ checkNumber: '6000000010', apvNumbers: ['AP-ST000001', 'AP-ST000002'] })
    await testDb.acumaticaBillTerms.createMany({ data: [
      { apvNumber: 'AP-ST000001', tenant: 'GOLIVE', dueDate: day('2026-09-30'), termsCode: '30D' },
      { apvNumber: 'AP-ST000002', tenant: 'GOLIVE', dueDate: day('2026-07-01'), termsCode: '30D' },
    ] })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.id).toBe(c.id)
    expect(row.dueDate).toBe('2026-07-01')
    expect(row.daysPastDue).toBe(106)
    expect(row.bucket).toBe('b90plus')
    expect(row.amount).toBe('197715.42')
  })

  it('falls back to the CheckBill due date only for an APV Acumatica gives no date', async () => {
    const c = await makeCheck({ checkNumber: '6000000020', apvNumbers: ['AP-ST000003'] })
    await testDb.checkBill.create({ data: {
      checkId: c.id, apvNumber: 'AP-ST000003', amount: '100.00', dueDate: day('2026-10-10'), termsCode: '30D',
    } })
    await testDb.acumaticaBillTerms.create({ data: { apvNumber: 'AP-ST000003', tenant: 'GOLIVE' } })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.dueDate).toBe('2026-10-10')
    expect(row.bucket).toBe('b30')
  })

  it('prefers Acumatica over CheckBill when both state a date', async () => {
    const c = await makeCheck({ checkNumber: '6000000030', apvNumbers: ['AP-ST000004'] })
    await testDb.checkBill.create({ data: {
      checkId: c.id, apvNumber: 'AP-ST000004', amount: '100.00', dueDate: day('2026-01-01'),
    } })
    await testDb.acumaticaBillTerms.create({ data: {
      apvNumber: 'AP-ST000004', tenant: 'GOLIVE', dueDate: day('2026-10-20'), termsCode: '30D',
    } })
    const [row] = (await loadAgingRows(testDb, NOW)).rows
    expect(row.bucket).toBe('current')
    expect(row.daysPastDue).toBe(-5)
  })

  it('a check with no APV, or no known date, is NO DUE DATE', async () => {
    await makeCheck({ checkNumber: '6000000040' })
    await makeCheck({ checkNumber: '6000000041', apvNumbers: ['AP-ST000099'] })
    const { rows } = await loadAgingRows(testDb, NOW)
    expect(rows.map((r) => [r.checkNumber, r.bucket, r.dueDate])).toEqual([
      ['6000000040', 'noDue', null],
      ['6000000041', 'noDue', null],
    ])
  })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/aging/query.test.ts`
Expected: FAIL, cannot resolve `@/lib/aging/query`.

- [ ] **Step 3: Implement**

`lib/aging/query.ts`:

```ts
import { listChecks, toTableRow, displayApvNumbers } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import { ageCheck, type AgingBucket, type BillTerms } from '@/lib/aging/buckets'

type Db = Parameters<typeof listChecks>[0]

/** Above this the page says it is short. SIGNED is ~1,400 (measured 2026-10). */
export const AGING_LIMIT = 25_000

export type AgingRow = {
  id: string
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  payee: string | null
  company: string
  /** The check book, else the register label (`accountWhere`'s rule). */
  bank: string | null
  checkDate: string | null
  dueDate: string | null
  daysPastDue: number | null
  bucket: AgingBucket
  /** Decimal string, rule 8. */
  amount: string | null
  currency: string
}

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/**
 * THE POPULATION (spec 2026-10-15): SIGNED, a real check, an amount — the only
 * checks that may move to READY FOR RELEASE. Each is aged by its bills: per
 * APV, Acumatica's due date and terms (`AcumaticaBillTerms`), and only when
 * Acumatica states no date, the approval workbook's (`CheckBill`).
 */
export async function loadAgingRows(db: Db, now: Date): Promise<{ rows: AgingRow[]; truncated: boolean }> {
  const checks = (await listChecks(
    db, { statusIn: ['SIGNED'], incomplete: false }, AGING_LIMIT, { key: 'checkNumber', dir: 'asc' },
  )).filter((c) => c.isCheque)

  const apvs = [...new Set(checks.flatMap((c) => displayApvNumbers(c)))]
  const terms = apvs.length === 0 ? [] : await db.acumaticaBillTerms.findMany({
    where: { apvNumber: { in: apvs } },
    select: { apvNumber: true, dueDate: true, termsCode: true },
  })
  const byApv = new Map(terms.map((t) => [t.apvNumber, t]))

  const rows = checks.map((c): AgingRow => {
    const table = toTableRow(c)
    const bills: BillTerms[] = table.apvNumbers.map((apv) => {
      const acu = byApv.get(apv)
      const local = c.bills.find((b) => b.apvNumber === apv)
      return acu?.dueDate
        ? { dueDate: acu.dueDate, termsCode: acu.termsCode }
        : { dueDate: local?.dueDate ?? null, termsCode: acu?.termsCode ?? local?.termsCode ?? null }
    })
    const aging = ageCheck(bills, now)
    return {
      id: c.id,
      checkNumber: c.checkNumber,
      cvNumber: c.cvNumber,
      apvNumbers: table.apvNumbers,
      poNumbers: table.poNumbers,
      payee: table.payeeName,
      company: table.companyCode,
      bank: table.cashAccountCode,
      checkDate: ymd(table.checkDate),
      dueDate: ymd(aging.dueDate),
      daysPastDue: aging.daysPastDue,
      bucket: aging.bucket,
      amount: table.amount,
      currency: table.currency,
    }
  })
  rows.sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))
  return { rows, truncated: checks.length >= AGING_LIMIT }
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/aging/query.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit`. Expected: no errors.

```bash
git add lib/aging/query.ts tests/aging/query.test.ts
git commit -m "feat(aging): SIGNED checks aged by Acumatica due dates, CheckBill as fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The picker's pure parts

**Files:**
- Create: `lib/aging-picker.ts`
- Test: `tests/aging/picker.test.ts`

**Interfaces:**
- Consumes: `AgingRow` (Task 6); `AGING_BUCKETS`, `AGING_LABELS`, `OVERDUE_BUCKETS`, `AgingBucket` (Task 5); `KitColumn` (`lib/table-kit/types.ts`); `amountToCentavos`, `formatAmount` (`lib/transmittal.ts`).
- Produces:
  - `AGING_TABLE_ID = 'aging'`
  - `agingColumns(companies: readonly string[], banks: readonly string[]): KitColumn[]`
  - `agingValue(r: AgingRow, key: string): string | null`
  - `type StripTotal = { count: number; amount: string }` (amount formatted with thousands separators, PHP and other currencies summed separately: the strip shows PHP only and says how many non-PHP checks it left out)
  - `stripTotals(rows: readonly AgingRow[]): { buckets: Record<AgingBucket, StripTotal>; overdue: StripTotal; all: StripTotal; nonPhp: number }`
  - `type BucketChoice = 'ALL' | 'OVERDUE' | AgingBucket`
  - `inBucket(rows: readonly AgingRow[], choice: BucketChoice): AgingRow[]`
  - `selectionTotal(rows: readonly AgingRow[], selected: ReadonlySet<string>): StripTotal`

- [ ] **Step 1: Write the failing tests**

`tests/aging/picker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { agingColumns, agingValue, stripTotals, inBucket, selectionTotal } from '@/lib/aging-picker'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', ...o,
})

const ROWS = [
  row({ id: 'a', bucket: 'current', amount: '0.10', daysPastDue: -3 }),
  row({ id: 'b', bucket: 'b30', amount: '1000.25' }),
  row({ id: 'c', bucket: 'b90plus', amount: '2000.65', daysPastDue: 120 }),
  row({ id: 'd', bucket: 'noDue', amount: '5.00', dueDate: null, daysPastDue: null }),
  row({ id: 'e', bucket: 'b30', amount: '99.00', currency: 'USD' }),
]

describe('stripTotals — centavo-exact, PHP only', () => {
  it('counts every bucket, OVERDUE and ALL', () => {
    const t = stripTotals(ROWS)
    expect(t.buckets.current).toEqual({ count: 1, amount: '0.10' })
    expect(t.buckets.b30).toEqual({ count: 1, amount: '1,000.25' })
    expect(t.buckets.b60).toEqual({ count: 0, amount: '0.00' })
    expect(t.buckets.b90plus).toEqual({ count: 1, amount: '2,000.65' })
    expect(t.buckets.noDue).toEqual({ count: 1, amount: '5.00' })
    expect(t.overdue).toEqual({ count: 2, amount: '3,000.90' })
    expect(t.all).toEqual({ count: 4, amount: '3,006.00' })
    expect(t.nonPhp).toBe(1)
  })
})

describe('inBucket', () => {
  it('ALL, OVERDUE and one bucket', () => {
    expect(inBucket(ROWS, 'ALL').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(inBucket(ROWS, 'OVERDUE').map((r) => r.id)).toEqual(['b', 'c', 'e'])
    expect(inBucket(ROWS, 'noDue').map((r) => r.id)).toEqual(['d'])
  })
})

describe('selectionTotal', () => {
  it('sums the selected PHP rows', () => {
    expect(selectionTotal(ROWS, new Set(['b', 'c']))).toEqual({ count: 2, amount: '3,000.90' })
  })
})

describe('agingColumns / agingValue', () => {
  it('has the spec\'s columns in order, with dropdowns for company, bank and bucket', () => {
    const cols = agingColumns(['STK'], ['BPI-S-4636'])
    expect(cols.map((c) => c.key)).toEqual([
      'checkNumber', 'cvNumber', 'apvNumbers', 'poNumbers', 'payee', 'company', 'bank',
      'checkDate', 'dueDate', 'daysPastDue', 'bucket', 'amount',
    ])
    expect(cols.find((c) => c.key === 'bucket')!.kind).toBe('enum')
    expect(cols.find((c) => c.key === 'company')!.options).toEqual([{ value: 'STK', label: 'STK' }])
  })

  it('reads values as the kit sorts and filters them', () => {
    const r = row({ apvNumbers: ['AP-1', 'AP-2'] })
    expect(agingValue(r, 'apvNumbers')).toBe('AP-1, AP-2')
    expect(agingValue(r, 'daysPastDue')).toBe('14')
    expect(agingValue(r, 'bucket')).toBe('b30')
    expect(agingValue(row({ daysPastDue: null }), 'daysPastDue')).toBeNull()
  })
})
```

- [ ] **Step 2: Check how the kit treats a number column, then run the tests and see them fail**

Run: `grep -n "case 'amount'\|kind === 'amount'" lib/table-kit/match.ts`
DAYS PAST DUE is a whole number of days. The kit's `amount` kind parses decimal strings and gives a numeric sort and range filter, so use `kind: 'amount'` for it. Then:

Run: `node node_modules/vitest/vitest.mjs run tests/aging/picker.test.ts`
Expected: FAIL, cannot resolve `@/lib/aging-picker`.

- [ ] **Step 3: Implement**

`lib/aging-picker.ts`:

```ts
import type { KitColumn } from '@/lib/table-kit/types'
import { amountToCentavos, formatAmount } from '@/lib/transmittal'
import { AGING_BUCKETS, AGING_LABELS, OVERDUE_BUCKETS, type AgingBucket } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'

/**
 * AGING's picker, the pure parts (spec 2026-10-15). The table kit filters,
 * sorts and lays out the rows, as on TRANSMITTAL; this module describes the
 * columns, and adds the bucket strip and the selection in centavos (rule 8).
 * The strip shows PHP only: totals are never mixed across currencies.
 */

export const AGING_TABLE_ID = 'aging'

const LABELS: Record<string, string> = {
  checkNumber: 'CHECK NO.', cvNumber: 'CV', apvNumbers: 'APV', poNumbers: 'PO NUMBER', payee: 'PAYEE',
  company: 'COMPANY', bank: 'BANK', checkDate: 'CHECK DATE', dueDate: 'DUE DATE',
  daysPastDue: 'DAYS PAST DUE', bucket: 'BUCKET', amount: 'AMOUNT',
}

const opts = (vs: readonly string[]) => vs.map((v) => ({ value: v, label: v }))

export function agingColumns(companies: readonly string[], banks: readonly string[]): KitColumn[] {
  const text = (key: string): KitColumn => ({ key, label: LABELS[key], kind: 'text' })
  return [
    { ...text('checkNumber'), className: 'font-medium', locked: true },
    text('cvNumber'),
    text('apvNumbers'),
    text('poNumbers'),
    text('payee'),
    { key: 'company', label: LABELS.company, kind: 'enum', options: opts(companies) },
    { key: 'bank', label: LABELS.bank, kind: 'enum', options: opts(banks) },
    { key: 'checkDate', label: LABELS.checkDate, kind: 'date' },
    { key: 'dueDate', label: LABELS.dueDate, kind: 'date' },
    { key: 'daysPastDue', label: LABELS.daysPastDue, kind: 'amount', align: 'right', className: 'tabular-nums' },
    {
      key: 'bucket', label: LABELS.bucket, kind: 'enum',
      options: AGING_BUCKETS.map((b) => ({ value: b, label: AGING_LABELS[b] })),
    },
    { key: 'amount', label: LABELS.amount, kind: 'amount', align: 'right', className: 'tabular-nums' },
  ]
}

export function agingValue(r: AgingRow, key: string): string | null {
  switch (key) {
    case 'apvNumbers': return r.apvNumbers.join(', ') || null
    case 'poNumbers': return r.poNumbers.join(', ') || null
    case 'daysPastDue': return r.daysPastDue === null ? null : String(r.daysPastDue)
    default: {
      const v = (r as Record<string, unknown>)[key]
      return typeof v === 'string' && v !== '' ? v : null
    }
  }
}

export type StripTotal = { count: number; amount: string }

const ZERO = BigInt(0)

function total(rows: readonly AgingRow[]): StripTotal {
  let sum = ZERO
  let count = 0
  for (const r of rows) {
    if (r.currency !== 'PHP' || r.amount === null) continue
    const c = amountToCentavos(r.amount)
    if (c === null) continue
    sum += c
    count++
  }
  return { count, amount: formatAmount(centavosText(sum)) }
}

/** Centavos back to a plain decimal string (`"-1234.05"`) for `formatAmount`. */
function centavosText(c: bigint): string {
  const neg = c < ZERO
  const abs = neg ? -c : c
  return `${neg ? '-' : ''}${(abs / BigInt(100)).toString()}.${(abs % BigInt(100)).toString().padStart(2, '0')}`
}

export function stripTotals(rows: readonly AgingRow[]) {
  const buckets = Object.fromEntries(
    AGING_BUCKETS.map((b) => [b, total(rows.filter((r) => r.bucket === b))]),
  ) as Record<AgingBucket, StripTotal>
  return {
    buckets,
    overdue: total(rows.filter((r) => OVERDUE_BUCKETS.includes(r.bucket))),
    all: total(rows),
    nonPhp: rows.filter((r) => r.currency !== 'PHP').length,
  }
}

export type BucketChoice = 'ALL' | 'OVERDUE' | AgingBucket

export function inBucket(rows: readonly AgingRow[], choice: BucketChoice): AgingRow[] {
  if (choice === 'ALL') return [...rows]
  if (choice === 'OVERDUE') return rows.filter((r) => OVERDUE_BUCKETS.includes(r.bucket))
  return rows.filter((r) => r.bucket === choice)
}

export function selectionTotal(rows: readonly AgingRow[], selected: ReadonlySet<string>): StripTotal {
  return total(rows.filter((r) => selected.has(r.id)))
}
```

- [ ] **Step 4: Run them and see them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/aging/picker.test.ts`
Expected: PASS. Note `all` counts 4 because the USD row is left out of the PHP total and counted in `nonPhp`.

- [ ] **Step 5: Commit**

```bash
git add lib/aging-picker.ts tests/aging/picker.test.ts
git commit -m "feat(aging): picker columns, bucket strip and selection totals in centavos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The page, the picker and the module bar

**Files:**
- Create: `components/AgingPicker.tsx`
- Create: `app/aging/page.tsx`
- Modify: `lib/module-nav.ts`
- Test: `tests/module-nav.test.ts`

**Interfaces:**
- Consumes: `loadAgingRows`, `AgingRow` (Task 6); everything Task 7 produces; `bulkReadyForReleaseAction`, `BulkActionResult`, `BulkOutcome` (`app/checks/bulk-actions.ts`, `lib/bulk-run.ts`); kit pieces `applyKit`, `needleError` (`lib/table-kit/match`), `setWidth`, `visibleColumns`, `widthStyle` (`lib/table-kit/layout`), `useTableLayout`, `KitHeaderRow`, `FilterChips`, `ColumnConfigButton` (`components/table-kit/`); `loadSettings` (`lib/settings/read`); `requireUser` (`lib/auth`); `AppHeader`.

- [ ] **Step 1: Write the failing module-bar test**

In `tests/module-nav.test.ts`:
- Change the first test's title to `'lists the nine in bar order, ADMINISTRATION last and admin-only'`. Change its expected ids to `['CHECK_RELEASE', 'AGING', 'VOUCHERS', 'FORECAST', 'CLEARING', 'RECON', 'NUMBERING', 'TRANSMITTAL', 'ADMINISTRATION']` and the `adminOnly` list to eight `false` then `true`. Add `expect(MODULES.find((m) => m.id === 'AGING')!.href).toBe('/aging')`.
- In `activeModule`'s first test add `expect(activeModule('/aging')).toBe('AGING')`.
- In `modulesFor` change `toHaveLength(7)` to `toHaveLength(8)`.

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts`
Expected: FAIL on the id list.

- [ ] **Step 2: Add the module**

In `lib/module-nav.ts`, add `'AGING'` to `ModuleId` after `'CHECK_RELEASE'`, and to `MODULES` after the CHECK_RELEASE entry:

```ts
  { id: 'AGING', label: 'AGING', href: '/aging', prefixes: ['/aging'], adminOnly: false },
```

Add to the doc comment: `AGING (2026-10-15) lists SIGNED checks in the Supplier Portal's aging buckets for the next release run.`

Run: `node node_modules/vitest/vitest.mjs run tests/module-nav.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the client picker**

`components/AgingPicker.tsx`:

```tsx
'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { formatAmount } from '@/lib/transmittal'
import { bulkReadyForReleaseAction } from '@/app/checks/bulk-actions'
import type { BulkActionResult, BulkOutcome } from '@/lib/bulk-run'
import { AGING_BUCKETS, AGING_LABELS } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'
import {
  AGING_TABLE_ID, agingColumns, agingValue, inBucket, selectionTotal, stripTotals, type BucketChoice,
} from '@/lib/aging-picker'
import type { KitSort } from '@/lib/table-kit/types'
import { applyKit, needleError } from '@/lib/table-kit/match'
import { setWidth, visibleColumns, widthStyle } from '@/lib/table-kit/layout'
import { useTableLayout } from './table-kit/useTableLayout'
import { KitHeaderRow } from './table-kit/KitHeaderRow'
import { FilterChips } from './table-kit/FilterChips'
import { ColumnConfigButton } from './table-kit/ColumnConfigDialog'

/** Rows drawn at once; SELECT ALL SHOWN still selects every match. */
const DRAW_LIMIT = 500

const BUCKET_TONE: Record<string, string> = {
  current: 'ring-emerald-300', b30: 'ring-amber-300', b60: 'ring-amber-400',
  b90: 'ring-rose-300', b90plus: 'ring-rose-400', noDue: 'ring-slate-300',
}

export function AgingPicker({ rows, cap, truncated }: { rows: readonly AgingRow[]; cap: number; truncated: boolean }) {
  const router = useRouter()
  const companies = useMemo(() => [...new Set(rows.map((r) => r.company))].sort(), [rows])
  const banks = useMemo(() => [...new Set(rows.map((r) => r.bank).filter((b): b is string => b !== null))].sort(), [rows])
  const columns = useMemo(() => agingColumns(companies, banks), [companies, banks])
  const { layout, preview, save, reset } = useTableLayout(AGING_TABLE_ID, columns)
  const [choice, setChoice] = useState<BucketChoice>('OVERDUE')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState<KitSort>({ key: 'daysPastDue', dir: 'desc' })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [pickupDate, setPickupDate] = useState('')
  const [result, setResult] = useState<BulkActionResult | null>(null)
  const [pending, startTransition] = useTransition()

  const activeKeys = Object.keys(filters).filter((k) => filters[k].trim() !== '')
  const visible = visibleColumns(columns, layout, activeKeys)
  const errors: Record<string, string> = {}
  for (const k of activeKeys) {
    const c = columns.find((x) => x.key === k)
    const e = c ? needleError(c, filters[k]) : null
    if (e) errors[k] = e
  }
  // The strip counts the kit-filtered rows across every bucket, so a card's
  // count is the row count its table shows.
  const filtered = useMemo(() => applyKit(rows, columns, agingValue, filters, null), [rows, columns, filters])
  const strip = useMemo(() => stripTotals(filtered), [filtered])
  const matching = useMemo(
    () => applyKit(inBucket(filtered, choice), columns, agingValue, {}, sort),
    [filtered, choice, columns, sort],
  )
  const picked = selectionTotal(rows, selected)
  const overCap = selected.size > cap

  const toggle = (id: string) => setSelected((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const ready = () => {
    // selected.size, not picked.count: a ticked non-PHP check is readied too, it is only left out of the peso total.
    if (!confirm(`Mark ${selected.size} check(s), PHP ${picked.amount}, READY FOR RELEASE?`)) return
    const fd = new FormData()
    for (const id of selected) fd.append('checkId', id)
    fd.append('availablePickupDate', pickupDate)
    startTransition(async () => {
      const r = await bulkReadyForReleaseAction(fd)
      setResult(r)
      if (r.ok && r.succeeded > 0) {
        setSelected(new Set())
        router.refresh()
      }
    })
  }

  const failures = result?.ok
    ? result.outcomes.filter((o): o is Extract<BulkOutcome, { ok: false }> => !o.ok)
    : []

  const card = (key: BucketChoice, label: string, t: { count: number; amount: string }, tone: string) => (
    <button
      key={key} type="button" onClick={() => setChoice(key)} aria-pressed={choice === key}
      className={`rounded-xl bg-white px-3 py-2 text-left ring-1 ${tone} ${choice === key ? 'ring-2 ring-navy' : ''}`}
    >
      <div className="text-[11px] font-semibold tracking-widest text-slate-500">{label}</div>
      <div className="text-lg font-semibold text-slate-900">{t.count.toLocaleString('en-PH')}</div>
      <div className="text-xs tabular-nums text-slate-600">₱{t.amount}</div>
    </button>
  )

  const cell = (r: AgingRow, key: string) => {
    switch (key) {
      case 'checkNumber': return <Link href={`/checks/${r.id}`} className="underline-offset-2 hover:underline" onClick={(e) => e.stopPropagation()}>{r.checkNumber}</Link>
      case 'amount': return formatAmount(r.amount)
      case 'bucket': return AGING_LABELS[r.bucket]
      default: return agingValue(r, key) ?? '—'
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-medium tracking-wide text-slate-600">
        SIGNED CHECKS ONLY. AGED BY THE EARLIEST DUE DATE OF THE BILLS EACH CHECK PAYS, AS IN THE SUPPLIER PORTAL.
        {strip.buckets.noDue.count > 0 && <> {strip.buckets.noDue.count.toLocaleString('en-PH')} HAVE NO DUE DATE.</>}
        {strip.nonPhp > 0 && <> {strip.nonPhp} NON-PHP CHECK(S) ARE LISTED BUT NOT IN THE PESO TOTALS.</>}
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {AGING_BUCKETS.map((b) => card(b, AGING_LABELS[b], strip.buckets[b], BUCKET_TONE[b]))}
        {card('OVERDUE', 'OVERDUE', strip.overdue, 'ring-rose-300')}
        {card('ALL', 'ALL', strip.all, 'ring-slate-300')}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ColumnConfigButton columns={columns} layout={layout} onSave={save} onReset={reset} />
        <button
          type="button" onClick={() => setSelected(new Set(matching.map((r) => r.id)))} disabled={matching.length === 0}
          className="h-9 rounded-lg bg-navy px-3 text-sm font-medium tracking-wide text-white disabled:opacity-40"
        >
          SELECT ALL SHOWN ({matching.length.toLocaleString('en-PH')})
        </button>
        <button
          type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}
          className="h-9 rounded-lg bg-white px-3 text-sm font-medium tracking-wide text-slate-600 ring-1 ring-hairline disabled:opacity-40"
        >
          CLEAR
        </button>
        <a href="/api/export/aging" className="h-9 rounded-lg bg-white px-3 py-2 text-sm font-medium tracking-wide text-slate-700 ring-1 ring-hairline">
          EXPORT EXCEL
        </a>
      </div>

      <FilterChips
        columns={columns} filters={filters} errors={errors}
        onClear={(k) => setFilters((f) => ({ ...f, [k]: '' }))} onClearAll={() => setFilters({})}
        count={{ shown: matching.length, total: rows.length, capped: truncated }}
      />

      <div className="max-h-[60vh] overflow-auto rounded-lg ring-1 ring-hairline">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-slate-50 text-left tracking-wide text-slate-500">
            <KitHeaderRow
              columns={visible} widths={layout.widths} sort={sort} filters={filters} errors={errors} cellClassName="px-2 py-2 font-semibold"
              onSort={(key, dir) => setSort(dir ? { key, dir } : null)}
              onFilter={(key, n) => setFilters((f) => ({ ...f, [key]: n }))}
              onResize={(key, w) => preview(setWidth(layout, key, w))}
              onResizeEnd={(key, w) => save(setWidth(layout, key, w))}
              leading={<th className="w-9 px-2 py-2" />}
            />
          </thead>
          <tbody>
            {matching.length === 0 && (
              <tr><td colSpan={visible.length + 1} className="px-2 py-6 text-center text-slate-500">NO SIGNED CHECKS MATCH.</td></tr>
            )}
            {matching.slice(0, DRAW_LIMIT).map((r) => (
              <tr key={r.id} className="cursor-pointer border-t border-slate-100 hover:bg-navy-bg" onClick={() => toggle(r.id)}>
                <td className="px-2 py-1.5">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                    onClick={(e) => e.stopPropagation()} aria-label={`Select ${r.checkNumber}`} />
                </td>
                {visible.map((col) => (
                  <td key={col.key} style={widthStyle(layout.widths[col.key])}
                    className={`truncate px-2 py-1.5 ${col.align === 'right' ? 'text-right' : ''} ${col.className ?? ''}`}>
                    {cell(r, col.key)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {matching.length > DRAW_LIMIT && (
          <p className="border-t border-slate-100 px-2 py-2 text-center text-xs text-slate-500">
            SHOWING THE FIRST {DRAW_LIMIT} OF {matching.length.toLocaleString('en-PH')} — FILTER TO NARROW, OR USE SELECT ALL SHOWN.
          </p>
        )}
      </div>

      <div className="sticky bottom-0 z-10 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold tracking-wide text-slate-900">
            {selected.size.toLocaleString('en-PH')} SELECTED · ₱{picked.amount}
          </span>
          {overCap && (
            <span className="text-xs font-semibold tracking-wide text-warning-ink">
              AT MOST {cap.toLocaleString('en-PH')} AT A TIME — UNTICK SOME.
            </span>
          )}
          <label htmlFor="aging-pickup-date" className="text-xs font-medium tracking-wide text-slate-600">AVAILABLE PICKUP DATE</label>
          <input id="aging-pickup-date" type="date" value={pickupDate} onChange={(e) => setPickupDate(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1 text-sm" />
          <button
            type="button" onClick={ready}
            disabled={pending || selected.size === 0 || overCap || pickupDate === ''}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? 'WORKING…' : 'MARK READY FOR RELEASE'}
          </button>
        </div>
        {result && !result.ok && <p className="mt-2 text-sm text-warning-ink">{result.message}</p>}
        {result?.ok && (
          <div className="mt-2 text-sm text-slate-700">
            {result.succeeded} MARKED READY FOR RELEASE{result.failed > 0 && `, ${result.failed} REFUSED:`}
            {failures.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-warning-ink">
                {failures.map((f) => <li key={f.checkId}>{f.checkNumber ?? f.checkId}: {f.message}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
```

(Checked while planning: `applyKit`'s `sort` is `KitSort`, which admits `null`; the check page is `app/checks/[id]`; `₱` is what `formatMoney` uses for PHP.)

- [ ] **Step 4: Write the page**

`app/aging/page.tsx`:

```tsx
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadSettings } from '@/lib/settings/read'
import { loadAgingRows } from '@/lib/aging/query'
import { AppHeader } from '@/components/AppHeader'
import { AgingPicker } from '@/components/AgingPicker'

/**
 * AGING (spec 2026-10-15-aging-module-design.md): SIGNED checks in the
 * Supplier Portal's buckets — days past the earliest due date of the bills
 * each check pays — ticked and marked READY FOR RELEASE through the existing
 * `bulkReadyForReleaseAction`. No other write. `requireUser()` first: it
 * lists payees and amounts.
 */
export const dynamic = 'force-dynamic'

export default async function AgingPage() {
  const user = await requireUser()
  const now = new Date()
  const [{ rows, truncated }, settings] = await Promise.all([loadAgingRows(prisma, now), loadSettings(prisma)])

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="AGING" back={{ href: '/', label: '← DASHBOARD' }} />
      <AgingPicker rows={rows} cap={settings.values['caps.bulkSelection']} truncated={truncated} />
    </main>
  )
}
```

- [ ] **Step 5: Type-check and build**

Run: `node node_modules/typescript/bin/tsc --noEmit`
Expected: no errors.
Run: `node node_modules/next/dist/bin/next build`
Expected: the build succeeds and `/aging` is listed as a dynamic route.

- [ ] **Step 6: Commit**

```bash
git add components/AgingPicker.tsx app/aging/page.tsx lib/module-nav.ts tests/module-nav.test.ts
git commit -m "feat(aging): /aging - bucket strip, kit table, mark SIGNED checks ready for release

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Excel export

**Files:**
- Create: `lib/export/aging-workbook.ts`
- Create: `app/api/export/aging/route.ts`
- Test: `tests/export/aging-workbook.test.ts`, `tests/export/aging-route.test.ts`

**Interfaces:**
- Consumes: `AgingRow`, `loadAgingRows` (Task 6); `AGING_BUCKETS`, `AGING_LABELS` (Task 5); `amountToCentavos` (`lib/transmittal.ts`); `styleHeaderCell`, `DATE_FORMAT`, `COUNT_FORMAT` (`lib/export/sheet-style.ts`); `currencyNumberFormat` (`lib/export/report.ts`); `getSessionUser` (`lib/auth`); `manilaToday` (`lib/manila-day`).
- Produces: `SUMMARY_SHEET = 'SUMMARY'`, `AGING_HEADERS`, `buildAgingWorkbook({ rows, generatedAt, generatedBy }): Promise<Buffer>`, `agingFilename(now: Date): string` → `AGING <YYYY-MM-DD>.xlsx`.

- [ ] **Step 1: Write the failing workbook test**

`tests/export/aging-workbook.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildAgingWorkbook, agingFilename, SUMMARY_SHEET, AGING_HEADERS } from '@/lib/export/aging-workbook'
import type { AgingRow } from '@/lib/aging/query'

const row = (o: Partial<AgingRow>): AgingRow => ({
  id: 'x', checkNumber: '6000000001', cvNumber: 'CV-1', apvNumbers: ['AP-1'], poNumbers: ['PO-1'],
  payee: 'HENKEL', company: 'STK', bank: 'BPI-S-4636', checkDate: '2026-09-01', dueDate: '2026-10-01',
  daysPastDue: 14, bucket: 'b30', amount: '1000.10', currency: 'PHP', ...o,
})

async function load(rows: AgingRow[]) {
  const buf = await buildAgingWorkbook({ rows, generatedAt: new Date('2026-10-15T10:00:00+08:00'), generatedBy: 'Paolo Parcon' })
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)
  return wb
}

describe('buildAgingWorkbook', () => {
  it('has SUMMARY and one sheet per non-empty bucket, in bucket order', async () => {
    const wb = await load([row({ id: 'a', bucket: 'b90plus' }), row({ id: 'b', bucket: 'current' })])
    expect(wb.worksheets.map((w) => w.name)).toEqual([SUMMARY_SHEET, 'CURRENT', 'OVER 90 DAYS'])
  })

  it('says it covers all SIGNED checks, and totals each bucket in centavos', async () => {
    const wb = await load([row({ id: 'a', amount: '0.10' }), row({ id: 'b', amount: '0.20' })])
    const summary = wb.getWorksheet(SUMMARY_SHEET)!
    const text = summary.getSheetValues().flat().filter((v) => typeof v === 'string').join(' ')
    expect(text).toContain('ALL SIGNED CHECKS')
    const b30 = summary.getColumn(1).values.indexOf('1–30 DAYS')
    expect(summary.getRow(b30).getCell(2).value).toBe(2)
    expect(summary.getRow(b30).getCell(3).value).toBe(0.3)
  })

  it('writes the table columns on a bucket sheet', async () => {
    const wb = await load([row({})])
    const sheet = wb.getWorksheet('1–30 DAYS')!
    expect(sheet.getRow(1).values).toEqual([undefined, ...AGING_HEADERS])
    expect(sheet.getRow(2).getCell(1).value).toBe('6000000001')
  })

  it('names the file by the Manila day', () => {
    expect(agingFilename(new Date('2026-10-15T00:30:00+08:00'))).toBe('AGING 2026-10-15.xlsx')
  })
})
```

Run: `node node_modules/vitest/vitest.mjs run tests/export/aging-workbook.test.ts`
Expected: FAIL, cannot resolve the module.

- [ ] **Step 2: Implement the workbook**

`lib/export/aging-workbook.ts`:

```ts
import ExcelJS from 'exceljs'
import { amountToCentavos } from '@/lib/transmittal'
import { manilaToday } from '@/lib/manila-day'
import { AGING_BUCKETS, AGING_LABELS, type AgingBucket } from '@/lib/aging/buckets'
import type { AgingRow } from '@/lib/aging/query'
import { COUNT_FORMAT, styleHeaderCell } from './sheet-style'
import { currencyNumberFormat } from './report'

/**
 * AGING as a workbook (spec 2026-10-15): SUMMARY (bucket × count × PHP amount,
 * then bucket × bank), and one sheet per non-empty bucket. Every SIGNED check
 * in the population, no filters, and the title block says so. Amounts are
 * summed in centavos and written as Excel numbers — a presentational value,
 * never added to anything here (see workbook.ts).
 */

export const SUMMARY_SHEET = 'SUMMARY'

export const AGING_HEADERS = [
  'CHECK NO.', 'CV', 'APV', 'PO NUMBER', 'PAYEE', 'COMPANY', 'BANK', 'CHECK DATE', 'DUE DATE',
  'DAYS PAST DUE', 'BUCKET', 'CURRENCY', 'AMOUNT',
] as const

const ZERO = BigInt(0)

function phpCentavos(rows: readonly AgingRow[]): bigint {
  let sum = ZERO
  for (const r of rows) {
    if (r.currency !== 'PHP' || r.amount === null) continue
    sum += amountToCentavos(r.amount) ?? ZERO
  }
  return sum
}

// Centavos → an Excel number. Safe: a sum of SIGNED checks is far below 2^53 centavos.
const asNumber = (c: bigint) => Number(c) / 100

export function agingFilename(now: Date): string {
  return `AGING ${manilaToday(now)}.xlsx`
}

export async function buildAgingWorkbook(args: {
  rows: readonly AgingRow[]
  generatedAt: Date
  generatedBy: string
}): Promise<Buffer> {
  const { rows, generatedAt, generatedBy } = args
  const wb = new ExcelJS.Workbook()
  const byBucket = new Map<AgingBucket, AgingRow[]>(AGING_BUCKETS.map((b) => [b, rows.filter((r) => r.bucket === b)]))

  const summary = wb.addWorksheet(SUMMARY_SHEET)
  summary.addRow(['AGING — ALL SIGNED CHECKS'])
  summary.addRow([`Aged by the earliest due date of the bills each check pays, as in the Supplier Portal. Generated ${manilaToday(generatedAt)} by ${generatedBy}. Peso totals only.`])
  summary.addRow([])
  const head = summary.addRow([])
  ;['BUCKET', 'CHECKS', 'AMOUNT (PHP)'].forEach((h, i) => styleHeaderCell(head.getCell(i + 1), h, i === 0 ? 'left' : 'right'))
  for (const b of AGING_BUCKETS) {
    const inB = byBucket.get(b)!
    const r = summary.addRow([AGING_LABELS[b], inB.length, asNumber(phpCentavos(inB))])
    r.getCell(2).numFmt = COUNT_FORMAT
    r.getCell(3).numFmt = currencyNumberFormat('PHP')
  }

  summary.addRow([])
  const banks = [...new Set(rows.map((r) => r.bank ?? '(NO BANK)'))].sort()
  const bankHead = summary.addRow([])
  ;['BANK', ...AGING_BUCKETS.map((b) => AGING_LABELS[b])].forEach((h, i) => styleHeaderCell(bankHead.getCell(i + 1), h, i === 0 ? 'left' : 'right'))
  for (const bank of banks) {
    const r = summary.addRow([bank, ...AGING_BUCKETS.map((b) =>
      asNumber(phpCentavos(byBucket.get(b)!.filter((x) => (x.bank ?? '(NO BANK)') === bank))))])
    for (let i = 2; i <= AGING_BUCKETS.length + 1; i++) r.getCell(i).numFmt = currencyNumberFormat('PHP')
  }
  summary.getColumn(1).width = 28
  for (let i = 2; i <= AGING_BUCKETS.length + 1; i++) summary.getColumn(i).width = 18

  for (const b of AGING_BUCKETS) {
    const inB = byBucket.get(b)!
    if (inB.length === 0) continue
    const sheet = wb.addWorksheet(AGING_LABELS[b])
    const h = sheet.addRow([])
    AGING_HEADERS.forEach((label, i) => styleHeaderCell(h.getCell(i + 1), label, label === 'AMOUNT' || label === 'DAYS PAST DUE' ? 'right' : 'left'))
    const sorted = [...inB].sort((x, y) => (y.daysPastDue ?? -Infinity) - (x.daysPastDue ?? -Infinity))
    for (const r of sorted) {
      const line = sheet.addRow([
        r.checkNumber, r.cvNumber ?? '', r.apvNumbers.join(', '), r.poNumbers.join(', '), r.payee ?? '',
        r.company, r.bank ?? '', r.checkDate ?? '', r.dueDate ?? '', r.daysPastDue ?? '', AGING_LABELS[r.bucket],
        r.currency, r.amount === null ? '' : asNumber(amountToCentavos(r.amount) ?? ZERO),
      ])
      line.getCell(13).numFmt = currencyNumberFormat(r.currency)
    }
    AGING_HEADERS.forEach((label, i) => { sheet.getColumn(i + 1).width = Math.max(12, label.length + 4) })
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}
```

Run: `node node_modules/vitest/vitest.mjs run tests/export/aging-workbook.test.ts`
Expected: PASS (`Number(30n) / 100` is exactly `0.3`).

- [ ] **Step 3: Write the failing route test**

`tests/export/aging-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { resetDb } from '../helpers/db'
import { makeCheck } from '../helpers/factory'
import { SUMMARY_SHEET } from '@/lib/export/aging-workbook'

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string; role: string } | null,
  dbTouches: 0,
}))

vi.mock('@/lib/auth', () => ({ getSessionUser: async () => state.user }))

vi.mock('@/lib/db', async () => {
  const { testDb } = await import('../helpers/db')
  return {
    prisma: new Proxy(testDb, {
      get(target, prop, receiver) {
        state.dbTouches += 1
        return Reflect.get(target, prop, receiver)
      },
    }),
  }
})

const SIGNED_IN = { id: 'u1', email: 'finance@rcl.test', name: 'Paolo Parcon', role: 'FINANCE_USER' }

async function get() {
  const { GET } = await import('@/app/api/export/aging/route')
  return GET(new Request('http://localhost/api/export/aging'))
}

beforeEach(async () => {
  await resetDb()
  state.user = null
  state.dbTouches = 0
})

describe('GET /api/export/aging', () => {
  it('answers 401 and touches no data when nobody is signed in', async () => {
    const res = await get()
    expect(res.status).toBe(401)
    expect(state.dbTouches).toBe(0)
  })

  it('returns the workbook of SIGNED checks', async () => {
    state.user = SIGNED_IN
    await makeCheck({ status: 'SIGNED', checkNumber: '6000000001' })
    await makeCheck({ status: 'RELEASED', checkNumber: '6000000002' })
    const res = await get()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="AGING \d{4}-\d{2}-\d{2}\.xlsx"$/)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()))
    expect(wb.getWorksheet(SUMMARY_SHEET)).toBeDefined()
    const sheet = wb.getWorksheet('NO DUE DATE')!
    expect(sheet.rowCount).toBe(2)
    expect(sheet.getRow(2).getCell(1).value).toBe('6000000001')
  })
})
```

Run: `node node_modules/vitest/vitest.mjs run tests/export/aging-route.test.ts`
Expected: FAIL, cannot resolve the route.

- [ ] **Step 4: Implement the route**

`app/api/export/aging/route.ts`:

```ts
import { getSessionUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { loadAgingRows } from '@/lib/aging/query'
import { buildAgingWorkbook, agingFilename } from '@/lib/export/aging-workbook'

/**
 * EXPORT AGING: every SIGNED check, aged (spec 2026-10-15). Authenticates on
 * its first line and answers 401, not a redirect — `middleware.ts` runs on
 * Vercel and not locally, and a download that redirects arrives as a login
 * page saved under an .xlsx name.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export async function GET(_request: Request): Promise<Response> {
  const user = await getSessionUser()
  if (!user) {
    return new Response('UNAUTHORISED', {
      status: 401,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const now = new Date()
  const { rows } = await loadAgingRows(prisma, now)
  const workbook = await buildAgingWorkbook({ rows, generatedAt: now, generatedBy: user.name })

  return new Response(new Uint8Array(workbook), {
    status: 200,
    headers: {
      'content-type': XLSX_MIME,
      'content-disposition': `attachment; filename="${agingFilename(now)}"`,
      'cache-control': 'no-store, no-cache, must-revalidate',
    },
  })
}
```

Run: `node node_modules/vitest/vitest.mjs run tests/export/aging-workbook.test.ts tests/export/aging-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `node node_modules/typescript/bin/tsc --noEmit`. Expected: no errors.

```bash
git add lib/export/aging-workbook.ts app/api/export/aging/route.ts tests/export/aging-workbook.test.ts tests/export/aging-route.test.ts
git commit -m "feat(aging): Excel export - SUMMARY by bucket and bank, one sheet per bucket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Verify in the browser, document, hand over

**Files:**
- Modify: `CLAUDE.md`
- Temporarily modify, then revert: `../Check Monitoring/.claude/launch.json`

- [ ] **Step 1: Run every test file this feature touched**

```bash
node node_modules/prisma/build/index.js generate
node node_modules/vitest/vitest.mjs run tests/schema.test.ts tests/integrations/acumatica-bill-refs.test.ts tests/sync/bill-refs.test.ts tests/sync/cron-route.test.ts tests/aging tests/module-nav.test.ts tests/export/aging-workbook.test.ts tests/export/aging-route.test.ts tests/actions/bulk-actions.test.ts
```

Expected: all PASS. `bulk-actions` is included because `/aging` relies on `bulkReadyForReleaseAction` unchanged.

- [ ] **Step 2: Type-check and build**

```bash
node node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build
```

Expected: no type errors; the build succeeds.

- [ ] **Step 3: Browser check against the TEST database**

Point the main checkout's `.claude/launch.json` dev entry at `node ../cm-aging/scripts/dev-test-db.mjs` (per the shared-checkout memory), then `preview_start`. Seed a few SIGNED checks with APVs and `AcumaticaBillTerms` rows across buckets in the TEST database (a short `tsx` snippet against `DATABASE_URL_TEST`, never `.env`'s `DATABASE_URL`). Then:
1. Open `/aging`. The AGING tab is lit, the strip shows the seeded counts, and OVERDUE is selected.
2. Click a bucket card; the table shows only that bucket. Set a COMPANY filter; the strip's counts drop to match.
3. Tick two checks; the SELECTED bar shows the count and peso total.
4. Set a pickup date, click MARK READY FOR RELEASE and confirm. The result says 2 MARKED, and the rows leave the list after the refresh.
5. Click EXPORT EXCEL; the response is 200 with `AGING <day>.xlsx`.
6. Check `read_console_messages` for errors, then take a screenshot.

Revert the `launch.json` change afterwards.

- [ ] **Step 4: Document**

In `CLAUDE.md`, under "Things that will catch you out", add:

```markdown
**AGING (`/aging`) picks SIGNED checks for release in the Supplier Portal's buckets** (2026-10-15,
spec `2026-10-15-aging-module-design.md`). CURRENT / 1–30 / 31–60 / 61–90 / OVER 90 / NO DUE DATE,
on days past the EARLIEST due date of the bills a check pays (`lib/aging/buckets.ts`; COD, PDC,
dated-check and 100PBD terms never age, as in the portal). The due date and terms come from
`AP-Bills and Adjustments` into `AcumaticaBillTerms` (written by the BILL_REFS read for every
in-scope bill, blank Vendor Ref included, never deleted; `CheckBill.dueDate` only where Acumatica
states none). MARK READY FOR RELEASE calls `bulkReadyForReleaseAction` unchanged — no new write
path. The totals do not match the portal's aging and are not meant to: the portal ages open bill
balances, this ages SIGNED check amounts. Migration `20261015000100_acumatica_bill_terms` must reach
production BEFORE the deploy. **The first fill is `npx tsx scripts/sync.ts <TENANT> --bill-refs
--full` on each tenant, run by the user after the deploy;** until then every check is NO DUE DATE
except those with a `CheckBill` due date.
```

Add `| `lib/aging/` | AGING: `buckets.ts` (the portal's buckets, pure), `query.ts` (SIGNED, aged). `/aging` and `/api/export/aging` sit on it. |` to the Layout table.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: AGING module, AcumaticaBillTerms, first-fill command

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Hand over. Do not deploy.**

Report to the user:
- tests run (with counts), `tsc`, build and the browser check, with the screenshot;
- that it is on `feature/aging`, not merged;
- the production order: `node scripts/migrate.mjs prod --confirm` → deploy from a master worktree → `npx tsx scripts/sync.ts GOLIVE --bill-refs --full` and `… MANUFACTURING --bill-refs --full`, run by the user.
