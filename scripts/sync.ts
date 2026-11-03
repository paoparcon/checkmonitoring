/**
 * Run an Acumatica sync from a machine, not from the browser.
 *
 * WHY THIS EXISTS. The SYNC NOW button calls the same `runSync`, but inside a
 * Vercel serverless request — and a first FULL sync of the GO-LIVE tenant reads
 * 41,998 rows. Vercel kills the function at its timeout, so on 2026-09-04 that
 * button got about 12,500 rows in, wrote 12,570 cheques, and was terminated. A
 * platform kill runs no `catch`, so the `SyncRun` row sat with `finishedAt`
 * null and the button spun forever.
 *
 * The rows already written are committed and correct — the sync is idempotent,
 * exactly like the register import — so the fix is to finish it from here,
 * where nothing imposes a request timeout.
 *
 * Once a tenant has a watermark, INCREMENTAL runs are small (a day's payments,
 * not 42,000) and the button is fine. This script is for the first run, and for
 * any catch-up after a long outage.
 *
 * Usage:
 *   npx.cmd tsx scripts/sync.ts GOLIVE --dry-run
 *   npx.cmd tsx scripts/sync.ts GOLIVE
 *   npx.cmd tsx scripts/sync.ts MANUFACTURING
 *   npx.cmd tsx scripts/sync.ts GOLIVE --full     # ignore the watermark
 *
 * THE VOUCHER READ (`--bills`). Acumatica's AP-PAYMENTS-WITH-BILLS, appended
 * to each cheque's `apvNumbers` (lib/sync/bills.ts) — add-only, never status.
 * The cron runs it incrementally once a tenant has a BILLS watermark; the FIRST
 * read, and any `--full` re-read (which links vouchers to cheques that arrived
 * after an earlier run passed them as "not held here"), is this script's job.
 * Before writing it snapshots every Acumatica cheque's `apvNumbers` to
 * snapshots/bills-<tenant>-<timestamp>.json.
 *
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bills --dry-run   # read the feed, write nothing
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bills             # snapshot, then link
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bills --full      # ignore the BILLS watermark
 *
 * THE PO READ (`--bill-refs`). Acumatica's AP-Bills and Adjustments, mirrored
 * into AcumaticaBill and AcumaticaBillTerms (due date and terms, AGING) (lib/sync/bill-refs.ts): each Bill dated 2024 or later whose VendorRef
 * names a real PO, keyed by APV; a bill whose ref no longer does is deleted from AcumaticaBill only; AcumaticaBillTerms rows are never deleted.
 * Reference data — no Check column, no audit row per bill. The cron runs it
 * incrementally once a tenant has a BILL_REFS watermark; the FIRST read, and
 * any `--full` re-read, is this script's job. Before writing it snapshots the
 * whole AcumaticaBill and AcumaticaBillTerms tables to snapshots/bill-refs-<tenant>-<timestamp>.json.
 *
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs --dry-run   # read the feed, write nothing
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs             # snapshot, then mirror
 *   npx.cmd tsx scripts/sync.ts GOLIVE --bill-refs --full      # ignore the BILL_REFS watermark
 */

import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createAcumaticaClient, PAYMENTS_FEED, PAYMENT_FIELDS } from '../lib/integrations/acumatica/client'
import { runSync, lastSyncWatermark } from '../lib/sync/run'
import { refreshOutOfScope } from '../lib/sync/out-of-scope'
import { runBillsSync, lastBillsWatermark } from '../lib/sync/bills'
import {
  BILLS_FEED, BILL_FEED_COLUMNS, billFeedSelect, billsInScopeFilter, billsSinceFilter,
} from '../lib/integrations/acumatica/bills'
import { runBillRefsSync, lastBillRefsWatermark } from '../lib/sync/bill-refs'
import {
  BILL_REFS_FEED, BILL_REF_COLUMNS, billRefsSelect, billRefsInScopeFilter, billRefsSinceFilter, mapBillRef, type BillRef,
} from '../lib/integrations/acumatica/bill-refs'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'

const TENANTS: Record<AcumaticaTenant, string> = {
  GOLIVE: 'ACUMATICA_ODATA_URL',
  MANUFACTURING: 'ACUMATICA_ODATA_URL_MFG',
}

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const FORCE_FULL = args.includes('--full')
const BILLS = args.includes('--bills')
const BILL_REFS = args.includes('--bill-refs')
const tenant = args.find((a) => !a.startsWith('--')) as AcumaticaTenant | undefined

const db = new PrismaClient()

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set.`)
  return v
}

async function main() {
  if (!tenant || !(tenant in TENANTS)) {
    throw new Error(`Name a tenant: ${Object.keys(TENANTS).join(' or ')}`)
  }
  if (BILLS && BILL_REFS) throw new Error('One read per run: --bills or --bill-refs, not both.')
  if (BILL_REFS) return billRefs(tenant)
  if (BILLS) return bills(tenant)

  const watermark = FORCE_FULL ? null : await lastSyncWatermark(db, tenant)
  const before = await db.check.count()

  console.log(`\nTENANT      ${tenant}`)
  console.log(`MODE        ${watermark ? `INCREMENTAL since ${watermark.toISOString()}` : 'FULL (no watermark)'}`)
  console.log(`CHEQUES     ${before.toLocaleString()} before this run`)

  if (!watermark) {
    console.log(
      `\n  NOTE: a full sync CREATES a cheque for every Acumatica payment not already held.\n` +
      `  On GO-LIVE that is roughly 28,000 records beyond the workbook register. This is a\n` +
      `  decision about what this system contains, not a refresh. Use --dry-run first.`,
    )
  }

  if (DRY) {
    // Read the feed but write nothing, so the size of the job is known before
    // committing to it. `runSync` has no dry mode of its own — deliberately, so
    // that nothing can half-write — hence the separate read here.
    const client = createAcumaticaClient({
      baseUrl: env(TENANTS[tenant]),
      user: env('ACUMATICA_ODATA_USER'),
      password: env('ACUMATICA_ODATA_PASSWORD'),
    })
    const rows = await client.fetchAll(PAYMENTS_FEED, {
      select: PAYMENT_FIELDS,
      pageSize: 2000,
      ...(watermark ? { filter: `LastModifiedOn ge datetime'${watermark.toISOString().slice(0, 19)}'` } : {}),
    })
    console.log(`\nDRY RUN — the feed returns ${rows.length.toLocaleString()} rows. Nothing was written.\n`)
    if (!watermark) {
      const oos = await refreshOutOfScope(db, { client, tenant, now: new Date(), apply: false })
      console.log(`  LIVE cheques held here whose payment left the 2026 CHK feed: ${oos.candidates.length}`)
      for (const c of oos.candidates) console.log(`    ${c.checkNumber} (${c.ref}, ${c.status})`)
      console.log(`  A FULL run re-reads each by its reference and follows Acumatica (status untouched).\n`)
    }
    return
  }

  // CLAUDE.md: snapshot before any bulk write to production. A FULL run
  // rewrites every in-scope cheque's source fields (full check 2026-10-06:
  // 102 amounts the register had overwritten).
  if (!watermark) {
    const snapAt = new Date()
    const rowsBefore = await db.check.findMany({
      where: { acumaticaTenant: tenant },
      select: {
        id: true, checkNumber: true, acumaticaPaymentId: true, cvNumber: true, amount: true, isIncomplete: true,
        status: true, isCheque: true, companyId: true, checkBookId: true, cashAccountId: true, payeeName: true,
        checkDate: true, acumaticaStatus: true, acumaticaDocType: true, lastModifiedOn: true, voidedAt: true,
      },
    })
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `payments-full-${tenant}-${snapAt.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify({ takenAt: snapAt.toISOString(), tenant, rows: rowsBefore }, null, 2))
    console.log(`SNAPSHOT    ${snap} (${rowsBefore.length.toLocaleString()} cheques)`)
  }

  const started = Date.now()
  const res = await runSync(db, {
    client: createAcumaticaClient({
      baseUrl: env(TENANTS[tenant]),
      user: env('ACUMATICA_ODATA_USER'),
      password: env('ACUMATICA_ODATA_PASSWORD'),
    }),
    tenant,
    since: watermark,
    now: new Date(),
    trigger: 'MANUAL',
  })

  const after = await db.check.count()
  console.log(`\nRESULT  (${((Date.now() - started) / 60000).toFixed(1)} min)`)
  console.log(`  fetched                       ${res.fetched.toLocaleString()}`)
  console.log(`  skipped (not payments)        ${res.skipped.toLocaleString()}`)
  console.log(`  void pairs folded             ${res.collapsed.toLocaleString()}`)
  console.log(`  imported                      ${res.imported.toLocaleString()}`)
  console.log(`  updated                       ${res.updated.toLocaleString()}`)
  console.log(`  staged                        ${res.staged.toLocaleString()}`)
  console.log(`  errors                        ${res.errors.toLocaleString()}`)
  console.log(`  staged rows promoted          ${res.promoted.toLocaleString()}`)
  console.log(`  ─────────────────────────────────────`)
  // The invariant that makes "nothing was silently dropped" checkable.
  const accounted = res.skipped + res.collapsed + res.imported + res.updated + res.staged + res.errors
  console.log(`  accounted for                 ${accounted.toLocaleString()} of ${res.fetched.toLocaleString()}` +
    (accounted === res.fetched ? '  ✓' : '  <-- MISMATCH, investigate'))
  console.log(`\n  cheques ${before.toLocaleString()} -> ${after.toLocaleString()}`)
  console.log(`  next watermark                ${res.watermark ? res.watermark.toISOString() : '(unchanged)'}\n`)

  // A FULL run also re-reads, by reference, every LIVE cheque whose payment has
  // left the scoped feed (lib/sync/out-of-scope.ts) — the feed cannot return it.
  if (!watermark) {
    const oos = await refreshOutOfScope(db, { client: clientFor(tenant), tenant, now: new Date(), apply: true })
    console.log(`OUT OF SCOPE  ${oos.candidates.length} live cheque(s) whose payment left the 2026 CHK feed`)
    for (const c of oos.candidates) console.log(`    ${c.checkNumber} (${c.ref}, ${c.status})`)
    console.log(`  re-read and updated ${oos.updated.length}; staged ${oos.staged.length}${oos.staged.length ? ' (' + oos.staged.join(', ') + ')' : ''}; voided ${oos.voided.length}; not in Acumatica ${oos.gone.length}${oos.gone.length ? ': ' + oos.gone.join(', ') : ''}`)
    for (const e of oos.errors) console.log(`  ERROR ${e.ref}: ${e.message}`)
    console.log('')
  }
}

function clientFor(t: AcumaticaTenant) {
  return createAcumaticaClient({
    baseUrl: env(TENANTS[t]),
    user: env('ACUMATICA_ODATA_USER'),
    password: env('ACUMATICA_ODATA_PASSWORD'),
  })
}

/** The voucher read: `--bills`. Never status; add-only; snapshot first. */
async function bills(t: AcumaticaTenant) {
  const watermark = FORCE_FULL ? null : await lastBillsWatermark(db, t)

  console.log(`\nTENANT      ${t}`)
  console.log(`FEED        ${BILLS_FEED}`)
  console.log(`MODE        ${watermark ? `BILLS since ${watermark.toISOString()}` : 'BILLS, every application in scope (no watermark)'}`)

  if (DRY) {
    // The same filter runBillsSync uses, so the count is the job's size.
    const rows = await clientFor(t).fetchAll(BILLS_FEED, {
      select: billFeedSelect(t),
      filter: watermark ? billsSinceFilter(t, watermark) : billsInScopeFilter(t),
      orderby: `${BILL_FEED_COLUMNS[t].date} asc`,
      pageSize: 2000,
    })
    console.log(`\nDRY RUN — the feed returns ${rows.length.toLocaleString()} rows. Nothing was written.\n`)
    return
  }

  // CLAUDE.md: snapshot before any bulk write to production. Every cheque the
  // join can touch — those carrying an Acumatica payment reference.
  const now = new Date()
  const before = await db.check.findMany({
    where: { acumaticaPaymentId: { not: null } },
    select: { id: true, checkNumber: true, apvNumbers: true },
  })
  await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
  const snap = join(
    process.cwd(), 'snapshots', `bills-${t}-${now.toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), tenant: t, rows: before }, null, 2))
  console.log(`SNAPSHOT    ${snap} (${before.length.toLocaleString()} cheques)`)

  const started = Date.now()
  const res = await runBillsSync(db, { client: clientFor(t), tenant: t, since: watermark, now, trigger: 'MANUAL' })

  console.log(`\nRESULT  (${((Date.now() - started) / 60000).toFixed(1)} min)`)
  console.log(`  fetched                       ${res.fetched.toLocaleString()}`)
  console.log(`  ignored (not CHK -> Bill)     ${res.ignored.toLocaleString()}`)
  console.log(`  vouchers added                ${res.vouchersAdded.toLocaleString()}`)
  console.log(`  cheques changed               ${res.chequesChanged.toLocaleString()}`)
  console.log(`  payments not held here        ${res.notHeld.toLocaleString()}`)
  console.log(`  cheque cancelled/voided here  ${res.cancelledHere.toLocaleString()} (not linked)`)
  console.log(`  no-APV checks looked up       ${res.lookedUp.toLocaleString()} (${res.linkedByLookup.toLocaleString()} linked)`)
  console.log(`  errors                        ${res.errors.toLocaleString()}`)
  console.log(`  next watermark                ${res.watermark ? res.watermark.toISOString() : '(unchanged)'}\n`)
  // A failed cheque write holds the watermark (lib/sync/bills.ts) so its
  // vouchers are read again; on a first read that means none is recorded yet.
  if (res.errors > 0) {
    console.log(
      `  WATERMARK HELD: ${res.errors} cheque write(s) failed (named in the run message on /admin/sync).\n` +
      `  Re-run this command until errors is 0. Until a BILLS watermark exists the scheduled run\n` +
      `  records a refusal for ${t} instead of reading vouchers.\n`,
    )
  }
}

/** The PO read: `--bill-refs`. Reference data; snapshot first. */
async function billRefs(t: AcumaticaTenant) {
  const watermark = FORCE_FULL ? null : await lastBillRefsWatermark(db, t)

  console.log(`\nTENANT      ${t}`)
  console.log(`FEED        ${BILL_REFS_FEED}`)
  console.log(`MODE        ${watermark ? `BILL_REFS since ${watermark.toISOString()}` : 'BILL_REFS, every bill dated 2024 or later (no watermark)'}`)

  if (DRY) {
    // The same filter runBillRefsSync uses, so the count is the job's size.
    const rows = await clientFor(t).fetchAll(BILL_REFS_FEED, {
      select: billRefsSelect(),
      filter: watermark ? billRefsSinceFilter(watermark) : billRefsInScopeFilter(),
      orderby: `${BILL_REF_COLUMNS.lastModified} asc`,
      pageSize: 2000,
    })
    const inScope = rows.map((r) => mapBillRef(r)).filter((r): r is BillRef => r !== null)
    const withPo = inScope.filter((b) => b.poNumbers.length > 0).length
    const withDue = inScope.filter((b) => b.dueDate !== null).length
    console.log(
      `\nDRY RUN — the feed returns ${rows.length.toLocaleString()} rows: ${inScope.length.toLocaleString()} ` +
      `bills dated 2024 or later, ${withPo.toLocaleString()} naming a PO, ${withDue.toLocaleString()} with a due date. Nothing was written.\n`,
    )
    return
  }

  // CLAUDE.md: snapshot before any bulk write to production. The whole table:
  // a run can rewrite or delete any row of this tenant's.
  const now = new Date()
  const before = await db.acumaticaBill.findMany({ orderBy: { apvNumber: 'asc' } })
  const termsBefore = await db.acumaticaBillTerms.findMany({ orderBy: { apvNumber: 'asc' } })
  await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
  const snap = join(
    process.cwd(), 'snapshots', `bill-refs-${t}-${now.toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), tenant: t, rows: before, terms: termsBefore }, null, 2))
  console.log(`SNAPSHOT    ${snap} (${before.length.toLocaleString()} bills, ${termsBefore.length.toLocaleString()} terms)`)

  const started = Date.now()
  const res = await runBillRefsSync(db, { client: clientFor(t), tenant: t, since: watermark, now, trigger: 'MANUAL' })

  console.log(`\nRESULT  (${((Date.now() - started) / 60000).toFixed(1)} min)`)
  console.log(`  fetched                       ${res.fetched.toLocaleString()}`)
  console.log(`  ignored (not a 2024+ Bill)    ${res.ignored.toLocaleString()}`)
  console.log(`  bills naming a PO             ${res.withPo.toLocaleString()}`)
  console.log(`  rows written                  ${res.upserted.toLocaleString()}`)
  console.log(`  rows deleted (PO gone)        ${res.deleted.toLocaleString()}`)
  console.log(`  ref but no PO                 ${res.noPo.toLocaleString()}`)
  console.log(`  terms rows written            ${res.termsWritten.toLocaleString()}`)
  console.log(`  errors                        ${res.errors.toLocaleString()}`)
  console.log(`  next watermark                ${res.watermark ? res.watermark.toISOString() : '(unchanged)'}\n`)
  if (res.errors > 0) {
    console.log(
      `  WATERMARK HELD: ${res.errors} write batch(es) failed (named in the run message on /admin/sync).\n` +
      `  Re-run this command until errors is 0. Until a BILL_REFS watermark exists the scheduled run\n` +
      `  records a refusal for ${t} instead of reading POs.\n`,
    )
  }
}

main()
  .catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
  .finally(() => db.$disconnect())
