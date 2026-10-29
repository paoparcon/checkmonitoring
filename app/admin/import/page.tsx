import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getStagedSummary } from '@/lib/admin/staged-queue'
import { ImportWorkbookForm } from '@/components/ImportWorkbookForm'
import { ReadyListUploadForm } from '@/components/ReadyListUploadForm'
import { manilaToday } from '@/lib/manila-day'

const n = (v: number) => v.toLocaleString('en-PH')

// The ready-list confirm marks for up to 30 s and then kicks portal delivery
// for 25 s after the response (`uploadReadyListAction`); give the function
// room for both, as the receipt page does for its 25 s kick.
export const maxDuration = 60

export default async function ImportPage() {
  await requireAdmin()
  const staged = await getStagedSummary(prisma)

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">READY FOR RELEASE FROM A LIST</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Upload a list of the checks that are ready for release. Each row names an AP BILL, and a
          CHECK NUMBER if the list has one; the row must find exactly one live check here before it
          is marked READY FOR RELEASE. That is the same mark the button on a check makes: it is recorded under your name
          with the pickup date, and the Supplier Portal is told. Nothing is written until you have
          seen the preview and confirmed it, and nothing is ever demoted by a list.
        </p>
      </section>

      <ReadyListUploadForm defaultPickupDate={manilaToday(new Date())} />

      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">IMPORT A WORKBOOK</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Nothing is written until you have seen the report and confirmed it. Import brings in what
          the workbook knows — amounts, dates, payees, cash accounts. It never changes whether a
          check has been signed, made available, released or cancelled: the register does not know
          those, and neither does Acumatica.
        </p>
        {/* The one-time 12,227-row load is a CLI job with a dry run, not a
            browser upload: it writes rows one at a time inside a single request
            and a timeout half way through leaves a partial import. Harmless —
            re-running finishes it — but worth saying out loud rather than
            leaving somebody to discover. */}
        <p className="mt-2 max-w-3xl text-sm text-slate-500">
          For the one-time historical load of the full register, use{' '}
          <code className="rounded bg-ground px-1.5 py-0.5 ring-1 ring-hairline">npx tsx scripts/import-workbook.ts &lt;path&gt; --dry-run</code>{' '}
          first. It prints the same accounting and writes nothing.
        </p>
      </section>

      {staged.total > 0 && (
        <p className="rounded-xl bg-warning-bg px-4 py-3 text-sm text-warning-ink">
          {n(staged.total)} row(s) are already held for review — {n(staged.live)} of them checks
          still in the release workflow.{' '}
          <Link href="/admin/staged" className="font-medium underline underline-offset-2">
            OPEN THE STAGED QUEUE
          </Link>
        </p>
      )}

      <ImportWorkbookForm />
    </div>
  )
}
