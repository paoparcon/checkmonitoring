/**
 * Read-only: what this system holds for the given check numbers — status,
 * portal columns, vouchers, every portal event and the last audit rows.
 * For looking at a parked event without opening the database. Prints no
 * amounts. Writes nothing. DATABASE_URL is PRODUCTION.
 *
 *   npx tsx scripts/inspect-portal-checks.ts 6000354974 6000354975
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const numbers = process.argv.slice(2).filter((a) => !a.startsWith('--'))

async function main(): Promise<void> {
  if (numbers.length === 0) { console.log('Usage: npx tsx scripts/inspect-portal-checks.ts <check number> [...]'); return }
  const db = new PrismaClient()
  try {
    for (const n of numbers) {
      const checks = await db.check.findMany({
        where: { checkNumber: n },
        select: {
          id: true, checkNumber: true, status: true, eligibility: true, apvNumbers: true,
          portalSyncStatus: true, portalDomain: true, portalTradeId: true,
          releasedAt: true, availablePickupDate: true, orNumber: true, receiptType: true,
          company: { select: { code: true } },
          bills: { select: { apvNumber: true } },
          portalEvents: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, kind: true, status: true, attempts: true, lastError: true, createdAt: true } },
          auditLogs: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 12, select: { createdAt: true, actorType: true, action: true, remarks: true } },
        },
      })
      console.log(`\n===== ${n}: ${checks.length} check(s) =====`)
      for (const c of checks) {
        console.log(`company ${c.company.code}  status ${c.status}  eligibility ${c.eligibility}  portal ${c.portalSyncStatus}/${c.portalDomain ?? '-'}  tradeId ${c.portalTradeId ?? '-'}`)
        console.log(`apvNumbers [${c.apvNumbers.join(', ')}]  bills [${c.bills.map((b) => b.apvNumber).join(', ')}]`)
        console.log(`releasedAt ${c.releasedAt?.toISOString() ?? '-'}  pickup ${c.availablePickupDate?.toISOString().slice(0, 10) ?? '-'}  receipt ${c.orNumber ? `${c.receiptType ?? '?'} on file` : 'none'}`)
        console.log('portal events:')
        for (const e of c.portalEvents) {
          console.log(`  ${e.createdAt.toISOString()}  ${e.kind.padEnd(16)} ${e.status.padEnd(9)} tries ${e.attempts}  ${e.lastError ?? ''}`)
        }
        console.log('last audit rows (newest first):')
        for (const a of c.auditLogs) {
          console.log(`  ${a.createdAt.toISOString()}  ${a.actorType.padEnd(6)} ${a.action.padEnd(34)} ${(a.remarks ?? '').slice(0, 110)}`)
        }
      }
    }
    console.log()
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
