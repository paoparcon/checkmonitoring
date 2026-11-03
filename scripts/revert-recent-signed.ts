/**
 * SIGNED -> SIGNATURE_PENDING for every check first read on or after a Manila
 * day (user ruling 2026-10-22: signing is manual from now on).
 *
 *   npx.cmd tsx scripts/revert-recent-signed.ts 2026-10-19                          # dry run: lists them
 *   npx.cmd tsx scripts/revert-recent-signed.ts 2026-10-19 --apply --user <email>   # snapshot, then revert each
 *
 * Status only, through `revertSignature`: one `signature_reverted` row each,
 * no portal event. Prints no amounts. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findRecentSigned, manilaDayStart, revertRecentSigned } from '../lib/admin/revert-recent-signed'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const userAt = args.indexOf('--user')
const USER_EMAIL = userAt >= 0 ? args[userAt + 1] : undefined
const DAY = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
const REASON = 'Signing is manual from 2026-10-22 (user ruling); auto-signed checks returned to pending'

async function main(): Promise<void> {
  if (!DAY) throw new Error('Usage: revert-recent-signed.ts <YYYY-MM-DD> [--apply --user <email>]')
  if (APPLY && !USER_EMAIL) throw new Error('--apply needs --user <email>: the revert is recorded against a person.')
  const db = new PrismaClient()
  try {
    const from = manilaDayStart(DAY)
    const rows = await findRecentSigned(db, from)
    console.log(`\nSIGNED checks first read on or after ${DAY} (Manila): ${rows.length}`)
    console.table(rows.map((r) => ({
      check: r.checkNumber, company: r.companyCode,
      firstRead: r.createdAt.toISOString().slice(0, 16).replace('T', ' ') + 'Z',
      signedBy: r.signedById ? 'a person' : 'auto-sign',
    })))
    const auto = rows.filter((r) => !r.signedById).length
    console.log(`  auto-signed ${auto}, signed by a person ${rows.length - auto}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply --user <email>.\n'); return }
    if (rows.length === 0) { console.log('\nNothing to revert.\n'); return }

    const user = await db.user.findUnique({ where: { email: USER_EMAIL! }, select: { id: true, active: true } })
    if (!user || !user.active) throw new Error(`No active user ${USER_EMAIL}.`)

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `revert-recent-signed-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const checks = await db.check.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
      select: { id: true, checkNumber: true, status: true, signedById: true, signedAt: true, createdAt: true },
    })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), from: from.toISOString(), checks }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await revertRecentSigned(db, rows, { userId: user.id, reason: REASON, now })
    console.log(`\nDONE  reverted ${out.reverted.length} of ${rows.length}`)
    for (const r of out.refused) console.log(`  refused ${r.checkNumber}: ${r.reason}`)
    console.log(`  still SIGNED from ${DAY}: ${(await findRecentSigned(db, from)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
