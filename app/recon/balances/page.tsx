import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { formatMoney } from '@/lib/money'
import { formatManila } from '@/lib/manila-format'
import { listReconAccounts } from '@/lib/recon/monthly/query'
import { monthLabel, monthOf } from '@/lib/recon/monthly/period'
import { periodPath } from '@/lib/recon/monthly/view'
import { AppHeader } from '@/components/AppHeader'
import { Panel } from '@/components/Panel'
import { ReconTabs } from '@/components/recon/ReconTabs'
import { ReconStatusPill } from '@/components/recon/ReconStatusPill'
import { ReconForm, FIELD, LABEL, BUTTON_QUIET } from '@/components/recon/ReconForm'
import { establishBeginningAction, correctBeginningAction, openPeriodAction } from '../actions'
import type { ReconStatus } from '@/lib/recon/monthly/period'

/**
 * BEGINNING BALANCES (spec 2026-11-09 §1). One per bank account — a check
 * book, else a cash account, the accounts this system already holds; nothing
 * here creates a bank account. Established by a Finance Admin with the
 * effective date (the 1st of the first month to reconcile), separate bank and
 * book balances and a reference. A correction needs a reason, is on the audit
 * trail, and is refused once the first month has left DRAFT.
 */
export const dynamic = 'force-dynamic'

export default async function BalancesPage() {
  const user = await requireUser()
  const isAdmin = user.role === 'FINANCE_ADMIN'
  const [accounts, openings, firstPeriods] = await Promise.all([
    listReconAccounts(prisma),
    prisma.reconOpeningBalance.findMany({ include: { createdBy: { select: { name: true } }, updatedBy: { select: { name: true } } } }),
    prisma.reconPeriod.findMany({ where: { beginningSource: 'OPENING' }, select: { id: true, accountKey: true, status: true } }),
  ])
  const openingBy = new Map(openings.map((o) => [o.accountKey, o]))
  const firstBy = new Map(firstPeriods.map((p) => [p.accountKey, p]))
  const without = accounts.filter((a) => !openingBy.has(a.accountKey))
  const when = (d: Date) => formatManila(d, { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="BEGINNING BALANCES" back={{ href: '/', label: '← DASHBOARD' }} />
      <ReconTabs />
      <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
        The balance each bank account&rsquo;s first reconciliation starts from, as at the start of the effective date (the 1st of a month).
        The <strong>bank balance</strong> is the bank statement&rsquo;s balance; the <strong>book balance</strong> is cash per books on the
        same date, with checks counted when they are released (the basis this system records). They are kept separately. After the first
        month is approved, every month begins from the month before — this figure is never used again.
      </p>

      {isAdmin && (
        <Panel title="ESTABLISH A BEGINNING BALANCE">
          {without.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-slate-600">Every bank account has a beginning balance.</p>
          ) : (
            <ReconForm action={establishBeginningAction} label="ESTABLISH" className="flex flex-wrap items-end gap-3 px-6 pb-6">
              <div><label className={LABEL} htmlFor="b-acc">BANK ACCOUNT</label>
                <select id="b-acc" name="accountKey" required className={`${FIELD} mt-1`}>
                  {without.map((a) => <option key={a.accountKey} value={a.accountKey}>{a.code} · {a.bankCode} · {a.kind === 'CHECK_BOOK' ? 'check book' : 'cash account'}</option>)}
                </select></div>
              <div><label className={LABEL} htmlFor="b-date">EFFECTIVE DATE (1ST OF MONTH)</label><input id="b-date" name="effectiveDate" type="date" required className={`${FIELD} mt-1`} /></div>
              <div><label className={LABEL} htmlFor="b-bank">BANK BALANCE</label><input id="b-bank" name="bankBalance" inputMode="decimal" required placeholder="0.00" className={`${FIELD} mt-1 w-40`} /></div>
              <div><label className={LABEL} htmlFor="b-book">BOOK BALANCE</label><input id="b-book" name="bookBalance" inputMode="decimal" required placeholder="0.00" className={`${FIELD} mt-1 w-40`} /></div>
              <div><label className={LABEL} htmlFor="b-cur">CURRENCY</label><input id="b-cur" name="currency" defaultValue="PHP" maxLength={3} className={`${FIELD} mt-1 w-20`} /></div>
              <div><label className={LABEL} htmlFor="b-ref">REFERENCE (REQUIRED)</label><input id="b-ref" name="reference" required placeholder="BPI SOA Sep 2026, GL 1010 TB" className={`${FIELD} mt-1 w-64`} /></div>
              <div><label className={LABEL} htmlFor="b-doc">SUPPORTING DOCUMENT</label><input id="b-doc" name="supportingDocument" placeholder="file name / folder" className={`${FIELD} mt-1 w-56`} /></div>
            </ReconForm>
          )}
        </Panel>
      )}

      <Panel title="ESTABLISHED" aside={<span className="text-xs text-slate-500">{openings.length} of {accounts.length} bank accounts</span>}>
        {openings.length === 0 ? <p className="px-6 pb-6 text-sm text-slate-600">None yet.</p> : (
          <div className="space-y-4 px-6 pb-6">
            {accounts.filter((a) => openingBy.has(a.accountKey)).map((a) => {
              const o = openingBy.get(a.accountKey)!
              const first = firstBy.get(a.accountKey)
              const locked = first !== undefined && first.status !== 'DRAFT'
              return (
                <div key={a.accountKey} className="rounded-xl p-4 ring-1 ring-hairline">
                  <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                    <span className="font-semibold">{a.code}</span>
                    <span className="text-slate-500">{a.bankCode}</span>
                    <span>from <strong>{monthLabel(monthOf(o.effectiveDate))}</strong></span>
                    <span>BANK <strong className="tabular-nums">{formatMoney(o.bankBalance.toFixed(2), o.currency)}</strong></span>
                    <span>BOOK <strong className="tabular-nums">{formatMoney(o.bookBalance.toFixed(2), o.currency)}</strong></span>
                    <span className="text-slate-600">ref. {o.reference}{o.supportingDocument ? ` · doc. ${o.supportingDocument}` : ''}</span>
                    {first ? <Link href={periodPath(first.id)} className="ml-auto inline-flex items-center gap-2 underline underline-offset-2">FIRST MONTH <ReconStatusPill status={first.status as ReconStatus} /></Link>
                      : <ReconForm action={openPeriodAction} hidden={{ accountKey: a.accountKey }} label={`START ${monthLabel(monthOf(o.effectiveDate))}`} buttonClass={`${BUTTON_QUIET} ml-auto`} />}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    Established by {o.createdBy.name}, {when(o.createdAt)}{o.updatedBy ? ` · last corrected by ${o.updatedBy.name}, ${when(o.updatedAt)}` : ''} — every change is on the audit trail.
                  </p>
                  {isAdmin && (locked ? (
                    <p className="mt-2 text-xs text-slate-500">Locked: the first month is past DRAFT. To correct it, return that month to DRAFT, or have it re-opened (a second Finance Admin approves).</p>
                  ) : (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold tracking-wide text-navy">CORRECT THIS BEGINNING BALANCE</summary>
                      <ReconForm action={correctBeginningAction} hidden={{ accountKey: a.accountKey }} label="SAVE CORRECTION" className="mt-2 flex flex-wrap items-end gap-3" resetOnSuccess={false}>
                        <div><label className={LABEL}>BANK BALANCE</label><input name="bankBalance" defaultValue={o.bankBalance.toFixed(2)} required className={`${FIELD} mt-1 w-40`} /></div>
                        <div><label className={LABEL}>BOOK BALANCE</label><input name="bookBalance" defaultValue={o.bookBalance.toFixed(2)} required className={`${FIELD} mt-1 w-40`} /></div>
                        <div><label className={LABEL}>REFERENCE</label><input name="reference" defaultValue={o.reference} required className={`${FIELD} mt-1 w-56`} /></div>
                        <div><label className={LABEL}>SUPPORTING DOCUMENT</label><input name="supportingDocument" defaultValue={o.supportingDocument ?? ''} className={`${FIELD} mt-1 w-48`} /></div>
                        <div><label className={LABEL}>REASON (REQUIRED)</label><input name="reason" required className={`${FIELD} mt-1 w-64`} /></div>
                      </ReconForm>
                    </details>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </Panel>
      {!isAdmin && <p className="text-xs text-slate-500">Only a Finance Admin can establish or correct a beginning balance.</p>}
    </main>
  )
}
