/**
 * Cheques CANCELLED here only because the retired register's CANCELLED sheet
 * said so, while Acumatica holds them live. Lists them; puts the NAMED ones
 * back to SIGNED with the bills the 2026-10-29 detach took off them.
 *
 *   npx tsx scripts/reinstate-register-cancelled.ts                              # dry run: lists every candidate
 *   npx tsx scripts/reinstate-register-cancelled.ts --apply --check 1791363258   # snapshot, then reinstate that one (repeat --check)
 *   npx tsx scripts/reinstate-register-cancelled.ts --apply --all                # every candidate — only on an explicit ruling
 *
 * Status only; no pickup date, no portal event. The ready-list upload does the
 * rest under the admin who confirms it. Prints no amounts. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { findRegisterCancelled, reinstateRegisterCancelled } from '../lib/admin/register-cancelled'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ALL = argv.includes('--all')
const NAMED = argv.flatMap((a, i) => (a === '--check' && argv[i + 1] ? [argv[i + 1]] : []))

const chosenRuled = (rows: { ruling: string | null }[]) => rows.filter((r) => r.ruling !== null)

async function main(): Promise<void> {
  const db = new PrismaClient()
  try {
    const rows = await findRegisterCancelled(db)
    console.log(`\nCANCELLED by the register only, live in Acumatica: ${rows.length}`)
    console.table(rows.map((r) => ({
      cheque: r.checkNumber, company: r.companyCode, payee: r.payeeName ?? '', payment: r.acumaticaPaymentId ?? '',
      acumatica: r.acumaticaStatus ?? '', date: r.checkDate ?? '', row: r.registerRow ?? '',
      bills: r.detachedVouchers.join(', ') || r.vouchersNow.join(', ') || '(none)', checkBills: r.detachedBills, ruling: r.ruling ?? '',
    })))
    const ruled = chosenRuled(rows)
    if (ruled.length > 0) console.log(`\n${ruled.length} carry a ruling to stay CANCELLED; --check names one only on a new ruling.`)
    const chosen = ALL ? rows : rows.filter((r) => NAMED.includes(r.checkNumber))
    for (const n of NAMED) if (!rows.some((r) => r.checkNumber === n)) console.log(`  ${n}: not a candidate — nothing done`)
    if (!APPLY) { console.log(`\nDRY RUN — nothing written. Name cheques with --check <number> and add --apply.\n`); return }
    if (chosen.length === 0) { console.log('\nNo cheque named. Nothing written.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `reinstate-register-cancelled-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    const before = await db.check.findMany({ where: { id: { in: chosen.map((c) => c.id) } } })
    await writeFile(snap, JSON.stringify({ takenAt: now.toISOString(), candidates: rows, chosen: chosen.map((c) => c.checkNumber), before }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)

    const out = await reinstateRegisterCancelled(db, chosen, { now, instruction: `User instruction ${now.toISOString().slice(0, 10)}: reinstate ${chosen.map((c) => c.checkNumber).join(', ')}.` })
    for (const o of out) console.log(`  ${o.checkNumber}: ${o.ok ? 'CANCELLED -> SIGNED' : `NOT CHANGED — ${o.reason}`}`)
    console.log(`\nDONE  reinstated ${out.filter((o) => o.ok).length} of ${chosen.length}; candidates left: ${(await findRegisterCancelled(db)).length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
