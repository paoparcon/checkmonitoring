/**
 * Withdraw, at the Supplier Portal, the cheques it still lists as AVAILABLE
 * that are CANCELLED or VOIDED here — cancelled before voidCheck/cancelCheck
 * learned to send the withdrawal (user ruling 2026-11-19).
 *
 *   npx tsx scripts/withdraw-dead-available.ts           # dry run: lists them
 *   npx tsx scripts/withdraw-dead-available.ts --apply   # snapshot, then queue one REVERT each
 *
 * --apply only QUEUES the events; the next portal delivery (the 12:00 / 18:00
 * cron, any action, or Deliver now on /admin/portal) sends them. The supplier
 * gets the portal's "check pickup reverted" notice. Prints no amounts.
 * DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findDeadAvailable, withdrawDeadAvailable } from '../lib/admin/withdraw-dead-available'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await findDeadAvailable(db)
    console.log(`\nCANCELLED / VOIDED cheques the portal still lists as available: ${rows.length}`)
    console.table(rows.map((r) => ({
      cheque: r.checkNumber, status: r.status, lastTold: r.lastTold,
      at: r.lastToldAt.toLocaleString('en-PH', { timeZone: 'Asia/Manila' }),
      vouchers: [...new Set([...r.detached.apvNumbersDetached, ...r.detached.billsDetached.map((b) => b.apvNumber)])].join(', ') || '(none on record)',
    })))
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to withdraw.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `withdraw-dead-available-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const cheques = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.checkId) } },
      select: { id: true, checkNumber: true, status: true, portalSyncStatus: true, portalDomain: true, portalTradeId: true },
    })
    const events = await db.portalEvent.findMany({ where: { checkId: { in: rows.map((r) => r.checkId) } } })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), rows, cheques, events }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const results = await withdrawDeadAvailable(db, rows, now)
    console.table(results.map((r) => ({
      cheque: r.checkNumber, queued: r.withdrawn.join(', '), leftToAnotherCheque: r.heldByAnother.join(', '), skipped: r.skipped ?? '',
    })))
    console.log(`\nDONE  REVERT queued for ${results.filter((r) => r.withdrawn.length).length} of ${rows.length}`)
    console.log(`  still listed with nothing queued: ${(await findDeadAvailable(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
