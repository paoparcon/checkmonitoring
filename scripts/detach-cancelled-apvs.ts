/**
 * Detach every CANCELLED or VOIDED cheque from the AP bills it still carries —
 * cheques cancelled before the 2026-10-29 rule that a cancellation cuts the
 * cheque loose from its bills (user ruling: "Once the check is cancelled, it
 * should not be connected to the AP it was applied to"). The bill belongs to
 * the live cheque that pays it now; a dead cheque sharing it is how the
 * portal's bill row was cancelled under a re-issue (6000354974..77, 26 Oct).
 *
 *   npx.cmd tsx scripts/detach-cancelled-apvs.ts           # dry run: counts and lists them
 *   npx.cmd tsx scripts/detach-cancelled-apvs.ts --apply   # snapshot, then detach each
 *
 * Each cheque goes through the domain's own `detachFromBills`; its open
 * CANCELLED portal events are closed unsent; one `apv_detached_on_cancel`
 * audit row carries what was detached, whole. Status is never touched.
 * Nothing is sent to the portal. Prints no amounts. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findAttachedCancelled, detachAttachedCancelled } from '../lib/admin/detach-cancelled-apvs'

const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await findAttachedCancelled(db)
    const by: Record<string, number> = {}
    for (const r of rows) by[r.status] = (by[r.status] ?? 0) + 1
    const openEvents = rows.reduce((n, r) => n + r.openEventIds.length, 0)
    console.log(`\nCANCELLED or VOIDED cheques still connected to an AP bill: ${rows.length}`, by)
    console.log(`  open CANCELLED portal events on them (will be closed unsent): ${openEvents}`)
    for (const r of rows) {
      const apvs = [...new Set([...r.apvNumbers, ...r.billApvs])].sort()
      console.log(`  ${r.checkNumber.padEnd(14)} ${r.status.padEnd(10)} ${apvs.join(', ')}${r.openEventIds.length ? `  (${r.openEventIds.length} open event)` : ''}`)
    }
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to detach.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `detach-cancelled-apvs-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const cheques = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.checkId) } },
      select: { id: true, checkNumber: true, status: true, apvNumbers: true, portalSyncStatus: true, bills: true },
    })
    const events = await db.portalEvent.findMany({ where: { id: { in: rows.flatMap((r) => r.openEventIds) } } })
    await writeFile(snap, JSON.stringify({
      takenAt: now.toISOString(),
      cheques: cheques.map((c) => ({ ...c, bills: c.bills.map((b) => ({ ...b, amount: b.amount.toString() })) })),
      events,
    }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const r = await detachAttachedCancelled(db, rows, now)
    console.log(`\nDONE  detached ${r.detached} of ${rows.length}; CANCELLED events closed unsent: ${r.eventsClosed}`)
    console.log(`  still connected: ${(await findAttachedCancelled(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
