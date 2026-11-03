/**
 * Merge a check book into the one it is an alias of (lib/check-book-alias.ts).
 *
 *   npx tsx scripts/merge-check-book.ts MBT-S-9048 MBT-A-9048           # dry run: what would move
 *   npx tsx scripts/merge-check-book.ts MBT-S-9048 MBT-A-9048 --apply   # snapshot, then move
 *
 * Status is never touched; one `check_book_merged` audit row per check; the
 * emptied book is deleted (`check_book_retired`). Snapshot in snapshots/ first.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { planCheckBookMerge, applyCheckBookMerge, snapshotOf } from '../lib/admin/merge-check-book'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const APPLY = process.argv.includes('--apply')

async function main(): Promise<void> {
  const [fromCode, toCode] = args
  if (!fromCode || !toCode) throw new Error('usage: merge-check-book.ts <FROM> <TO> [--apply]')
  const db = new PrismaClient()
  try {
    const plan = await planCheckBookMerge(db, fromCode, toCode)
    console.log(`\n${plan.from.code} → ${plan.to.code}: ${plan.checks.length} check(s), ${plan.notes.length} inventory note(s)`)
    for (const c of plan.checks) console.log(`  ${c.checkNumber.padEnd(14)} ${c.status.padEnd(18)} ${c.company.padEnd(6)} ${c.acumaticaPaymentId ?? ''}`)
    for (const n of plan.notes) console.log(`  note ${n.checkNumber}${n.runTo ? `–${n.runTo}` : ''}${n.clash ? '  (stays: the target already has one)' : ''}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `merge-check-book-${fromCode}-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(snap, JSON.stringify(snapshotOf(plan, now), null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const r = await applyCheckBookMerge(db, plan)
    console.log(`\nDONE  moved ${r.moved} of ${plan.checks.length} check(s); notes moved ${r.notesMoved}, left ${r.notesLeft}; book ${r.bookDeleted ? 'deleted' : 'kept (still referenced)'}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
