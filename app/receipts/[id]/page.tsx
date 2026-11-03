import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { ReceiptForm } from '@/components/ReceiptForm'
import { AttachReceiptFileForm } from '@/components/AttachReceiptFileForm'
import { RECEIPT_TYPE_LABELS } from '@/lib/domain/receipt'
import { RECEIPT_RECLASSIFIED_ACTION } from '@/lib/admin/repair-cr-receipts'
import { formatManila } from '@/lib/manila-format'

/**
 * SUPPLIER RECEIPT — the add-it-later page.
 *
 * The client made the receipt optional at release: "A cheque can be released
 * with the box empty and the receipt added later." This is the later.
 *
 * It is a route of its own rather than a section of the cheque page because the
 * cheque page was being restyled in another branch while this was written, and
 * a feature that has to wait for a file to be free is a feature that ships
 * without the half that makes it usable. The cheque page should link here —
 * that link is the one piece of wiring this change does not include.
 *
 * Guarded by `requireUser()` in the request path, like every other page. There
 * is no middleware protecting anything in this application (see CLAUDE.md), and
 * a page that forgot this guard would be readable by anyone with the URL.
 */
// The receipt actions on this page kick portal delivery with a 25 s budget
// after the response (review 2026-10-02); give the function room for it.
export const maxDuration = 60

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser()
  const { id } = await params

  const check = await prisma.check.findUnique({
    where: { id },
    include: { company: true, releasedBy: true, receiptFile: { select: { fileName: true, sizeBytes: true } } },
  })
  if (!check) notFound()

  // A receipt the 2026-09-11 repair moved out of the clearing column — the
  // register's own REMARKS cell, reclassified on the client's ruling. Stated,
  // because such a receipt has no date and no recording user, and a reader
  // should know why.
  const fromRegister = await prisma.auditLog.findFirst({
    where: { checkId: check.id, action: RECEIPT_RECLASSIFIED_ACTION },
    select: { id: true },
  })

  // The same two facts `recordReceipt` tests, read here only to decide what to
  // draw. The action re-checks both — a server action is an HTTP endpoint, and
  // not drawing a form hides nothing from it.
  const released = check.status === 'RELEASED' || check.releasedAt !== null
  const recorded = check.orNumber !== null

  const fmtDate = (d: Date | null) =>
    d ? formatManila(d, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-8">
      <AppHeader
        user={user}
        title="SUPPLIER RECEIPT"
        back={{ href: `/checks/${check.id}`, label: '← BACK TO CHECK' }}
      />

      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <p className="text-xs font-semibold tracking-widest text-slate-600">CHECK</p>
        <p className="mt-1 text-lg font-semibold text-slate-900">
          {check.company.code} {check.checkNumber}
        </p>
        <p className="text-sm text-slate-600">{check.payeeName ?? 'No payee recorded'}</p>
        <p className="mt-2 text-xs tracking-wide text-slate-500">
          {check.status.replace(/_/g, ' ')}
          {check.releasedAt && ` · RELEASED ${fmtDate(check.releasedAt)}`}
          {check.releasedBy && ` BY ${check.releasedBy.name.toUpperCase()}`}
        </p>
      </section>

      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-sm font-semibold tracking-wide">
          OFFICIAL OR COLLECTION RECEIPT
        </h2>

        {recorded ? (
          <div className="mt-3 space-y-2">
            <p className="text-sm text-slate-900">
              <span className="font-semibold">{check.orNumber}</span>
              {check.receiptType && (
                <span className="ml-2 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium tracking-wide text-slate-700">
                  {check.receiptType} · {RECEIPT_TYPE_LABELS[check.receiptType]}
                </span>
              )}
            </p>
            <p className="text-sm text-slate-600">RECEIPT DATE {fmtDate(check.orDate)}</p>
            <p className="text-sm text-slate-600">AMOUNT {check.receiptAmount?.toFixed(2) ?? '—'}</p>
            <p className="text-sm text-slate-600">
              FILE {check.receiptFile ? `${check.receiptFile.fileName} (${Math.ceil(check.receiptFile.sizeBytes / 1024)} KB)` : 'Not attached'}
            </p>
            {(check.receiptAmount === null || !check.receiptFile) && (
              <AttachReceiptFileForm checkId={check.id} needsAmount={check.receiptAmount === null} needsFile={!check.receiptFile} />
            )}
            {fromRegister && (
              <p className="text-xs text-slate-500">
                FROM THE REGISTER. This number was typed into the register&rsquo;s REMARKS column and
                reclassified as a Collection Receipt on the client&rsquo;s ruling of 2026-09-11; no
                receipt date was recorded there.
              </p>
            )}
            {/* Stated, so nobody hunts for an edit control that does not exist.
                A recorded receipt is a fact entered against money that has
                already moved; replacing one is not something this page does. */}
            <p className="text-xs text-slate-500">
              A RECORDED RECEIPT IS NOT OVERWRITTEN FROM HERE. If it is wrong, raise it with a
              Finance Admin — the audit trail on the check shows who recorded it and when.
            </p>
          </div>
        ) : released ? (
          <>
            <p className="mt-1 text-sm text-slate-600">
              This check was released without a receipt reference. Record it here when the paper
              reaches you.
            </p>
            <div className="mt-4">
              <ReceiptForm checkId={check.id} />
            </div>
          </>
        ) : (
          // Not an error and not a blank space: a receipt is the paper handed
          // back at collection, so there is genuinely nothing to record yet.
          <p className="mt-2 text-sm text-slate-600">
            THIS CHECK HAS NOT BEEN RELEASED. A supplier’s receipt can only be recorded once the
            check has been handed over — the reference can be entered on the release itself.{' '}
            <Link href={`/checks/${check.id}`} className="underline underline-offset-2">
              Open the check
            </Link>
            .
          </p>
        )}
      </section>
    </main>
  )
}
