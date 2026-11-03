/**
 * The check list push from a terminal (spec 2026-11-03-check-list-in-portal-
 * design): every cheque changed since the last push — or, with --full, every
 * cheque this system holds — sent to the Supplier Portal's `cm_check` table in
 * batches of 500. Status is never touched; no audit row per cheque; the run is
 * recorded as a PORTAL_CHECKS row on SyncRun. DATABASE_URL is PRODUCTION and
 * PORTAL_BASE_URL / PORTAL_TOKEN name the portal.
 *
 *   npx tsx scripts/push-checks-to-portal.ts --dry-run          # count what an incremental push would send
 *   npx tsx scripts/push-checks-to-portal.ts                    # send the changes since the last push
 *   npx tsx scripts/push-checks-to-portal.ts --full             # send every cheque (the first load)
 *   npx tsx scripts/push-checks-to-portal.ts --full --dry-run   # count every cheque
 *
 * Prints counts and check numbers, never amounts. A run that stops on a failed
 * batch keeps its watermark at the last batch sent; run it again to continue.
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { createPortalClientFromEnv } from '../lib/integrations/portal/from-env'
import { PORTAL_CHECKS_OVERLAP_MINUTES, lastPortalChecksWatermark, runPortalChecksPush } from '../lib/sync/portal-checks'

const argv = process.argv.slice(2)
const full = argv.includes('--full')
const dryRun = argv.includes('--dry-run')
const db = new PrismaClient()

async function main(): Promise<void> {
  const since = full ? null : await lastPortalChecksWatermark(db)
  const from = since ? new Date(since.getTime() - PORTAL_CHECKS_OVERLAP_MINUTES * 60_000) : null
  const where = from ? { updatedAt: { gt: from } } : {}
  const count = await db.check.count({ where })
  console.log(`${full ? 'FULL push' : since ? `changes since ${since.toISOString()} (read back ${PORTAL_CHECKS_OVERLAP_MINUTES} min)` : 'no watermark yet: every cheque'}: ${count} cheque(s) to send`)
  if (dryRun) {
    const sample = await db.check.findMany({ where, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 10, select: { checkNumber: true, status: true, updatedAt: true } })
    for (const c of sample) console.log(`  ${c.checkNumber}  ${c.status}  changed ${c.updatedAt.toISOString()}`)
    if (count > sample.length) console.log(`  … and ${count - sample.length} more`)
    console.log('dry run: nothing sent')
    return
  }
  const client = createPortalClientFromEnv()
  const started = Date.now()
  const r = await runPortalChecksPush(db, { client, now: new Date(), trigger: 'MANUAL', full })
  console.log(`sent ${r.pushed} cheque(s) in ${r.batches} batch(es), ${r.errors} error(s), ${Math.round((Date.now() - started) / 1000)} s${r.remaining ? ' — NOT finished; run again to continue' : ''}`)
  if (r.message) console.log(r.message)
  if (r.errors) process.exitCode = 1
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 }).finally(() => db.$disconnect())
