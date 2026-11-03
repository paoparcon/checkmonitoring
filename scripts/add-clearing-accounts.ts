// scripts/add-clearing-accounts.ts
/**
 * Add Acumatica's PAYROLL clearing account (BPI cash account) and the
 * MBT-S-9048 check book (MBTC), then link the checks Acumatica files under them
 * (user ruling 2026-10-16).
 *
 *   npx.cmd tsx scripts/add-clearing-accounts.ts GOLIVE            # dry run
 *   npx.cmd tsx scripts/add-clearing-accounts.ts GOLIVE --apply    # create rows, snapshot, link; one audit row each
 *   (likewise MANUFACTURING)
 *
 * Reads Acumatica (read-only). Writes cashAccountId / checkBookId only, never
 * status. Prints counts only. DATABASE_URL is PRODUCTION.
 */
import 'dotenv/config'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { createClientForTenant } from '../lib/integrations/acumatica/from-env'
import type { AcumaticaTenant } from '../lib/integrations/acumatica/companies'
import { planCheckBookBackfill, applyCheckBookBackfill } from '../lib/admin/check-books'
import {
  CLEARING_CASH_ACCOUNT, EXTRA_CHECK_BOOK, ensureClearingReferenceRows, planCashAccountLink, applyCashAccountLink,
} from '../lib/admin/clearing-accounts'

const args = process.argv.slice(2)
const tenant = args.find((a) => !a.startsWith('--')) as AcumaticaTenant | undefined
const APPLY = args.includes('--apply')

function byStatus(rows: readonly { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1
  return out
}

async function main(): Promise<void> {
  if (tenant !== 'GOLIVE' && tenant !== 'MANUFACTURING') throw new Error('Name a tenant: GOLIVE or MANUFACTURING')
  const db = new PrismaClient()
  try {
    const client = createClientForTenant(tenant)
    if (APPLY) {
      const created = await ensureClearingReferenceRows(db)
      console.log(`reference rows created: ${created.length ? created.join(', ') : 'none (already present)'}`)
    }
    const links = await planCashAccountLink(db, client, tenant, CLEARING_CASH_ACCOUNT.code)
    console.log(`\nTENANT ${tenant}`)
    console.log(`${CLEARING_CASH_ACCOUNT.code}: would link ${links.length}`, byStatus(links))
    // The book's checks go through the existing check-book backfill, which can
    // only see the book once it exists — so on a dry run it is counted as "not a book".
    const books = await planCheckBookBackfill(db, client, tenant)
    const bookRows = books.candidates.filter((c) => c.checkBookCode === EXTRA_CHECK_BOOK.code)
    console.log(`${EXTRA_CHECK_BOOK.code}: would set ${APPLY ? bookRows.length : books.notABook[EXTRA_CHECK_BOOK.code] ?? 0}`)
    if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return }
    if (links.length + bookRows.length === 0) { console.log('\nNothing to link.\n'); return }

    const now = new Date()
    await mkdir(join(process.cwd(), 'snapshots'), { recursive: true })
    const snap = join(process.cwd(), 'snapshots', `clearing-accounts-${tenant}-${now.toISOString().replace(/[:.]/g, '-')}.json`)
    // Every row was selected with no account and no book, so both priors are null by construction.
    await writeFile(snap, JSON.stringify({
      takenAt: now.toISOString(), tenant,
      cashAccount: { code: CLEARING_CASH_ACCOUNT.code, links, priorCashAccountId: null, priorCheckBookId: null },
      checkBook: { code: EXTRA_CHECK_BOOK.code, candidates: bookRows, priorCheckBookId: null },
    }, null, 2))
    console.log(`\nSnapshot written: ${snap}`)
    const linked = await applyCashAccountLink(db, CLEARING_CASH_ACCOUNT.code, links)
    console.log(`DONE  ${CLEARING_CASH_ACCOUNT.code} linked ${linked} of ${links.length}`)
    const set = await applyCheckBookBackfill(db, bookRows)
    console.log(`DONE  ${EXTRA_CHECK_BOOK.code} set ${set} of ${bookRows.length}\n`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((e) => { console.error(`\n${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1 })
