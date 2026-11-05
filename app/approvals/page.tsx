import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { AppHeader } from '@/components/AppHeader'
import { EmptyState } from '@/components/EmptyState'
import { Panel } from '@/components/Panel'
import { ApprovalsTable, KIND_LABEL } from '@/components/ApprovalsTable'
import { listPendingRequests, listDecidedRequests } from '@/lib/approvals/queries'
import { loadApprover, canDecide } from '@/lib/approvals/approver'
import { loadSettings } from '@/lib/settings/read'
import { formatManila } from '@/lib/manila-format'
import { formatMoney } from '@/lib/money'

export const dynamic = 'force-dynamic'
// APPROVE SELECTED over every pending request; the decision loop stops at 45 s (2026-11-05).
export const maxDuration = 60

const fmt = (d: Date) => formatManila(d, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * `/approvals` (spec 2026-11-05-availability-approval-design §7). Every
 * Finance user sees what is waiting and who decides; the approver decides.
 * Nothing here moves a check except through `approveAvailabilityRequest`.
 */
export default async function ApprovalsPage() {
  const user = await requireUser()
  const settings = await loadSettings(prisma)
  const [inForce, pending, decided] = await Promise.all([
    loadApprover(prisma, settings), listPendingRequests(prisma), listDecidedRequests(prisma, 50),
  ])
  const decides = canDecide(user, inForce.approver)

  return (
    <main className="space-y-4 px-4 py-5">
      <AppHeader user={user} title="APPROVALS" back={{ href: '/', label: '← DASHBOARD' }} />

      <p className="rounded-lg bg-navy-bg px-4 py-2 text-sm text-navy">
        {inForce.approver
          ? <>Availability changes — MARK READY FOR RELEASE and REVERT TO SIGNED — are approved by <strong>{inForce.approver.name}</strong>{decides ? ' (you)' : ''}. The Supplier Portal is told only on approval.</>
          : <>No approver is set{inForce.invalid ? ' (the person chosen is no longer active)' : ''}: every availability change applies at once.{user.role === 'FINANCE_ADMIN' ? ' Choose one under Administration → Settings.' : ''}{pending.length > 0 && decides ? ' You may decide the requests left waiting.' : ''}</>}
      </p>

      <Panel title="WAITING FOR APPROVAL" aside={<span className="text-sm text-slate-500">{pending.length}</span>} bodyClassName="p-0">
        {pending.length === 0
          ? <div className="px-6 py-8 text-sm text-slate-500">Nothing is waiting.</div>
          : <ApprovalsTable rows={pending} canDecide={decides} />}
      </Panel>

      <Panel title="DECIDED" aside={<span className="text-sm text-slate-500">latest {decided.length}</span>} bodyClassName="p-0">
        {decided.length === 0 ? (
          <EmptyState title="No decisions yet.">Approved and rejected requests are listed here, newest first.</EmptyState>
        ) : (
          <ul className="divide-y divide-hairline">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-3 px-6 py-3 text-sm">
                <div className="min-w-0">
                  <span className={`mr-2 rounded-md px-2 py-0.5 text-[11px] font-semibold ${r.status === 'APPROVED' ? 'bg-success-bg text-success-ink' : 'bg-amber-50 text-amber-900'}`}>{r.status}</span>
                  <span className="font-medium text-navy">{KIND_LABEL[r.kind]}</span>
                  {' · '}
                  <Link href={`/checks/${r.checkId}`} className="font-mono text-navy underline-offset-2 hover:underline">{r.checkNumber ?? '—'}</Link>
                  {' · '}<span className="text-slate-600">{r.payeeName ?? '—'}</span>
                  {r.amount && <span className="ml-2 tabular-nums text-slate-700">{formatMoney(r.amount, r.currency)}</span>}
                  {r.decisionNote && <span className="block text-xs text-slate-500">{r.decisionNote}</span>}
                </div>
                <div className="text-right text-xs text-slate-400">
                  <span>requested by {r.requestedBy}, {fmt(r.requestedAt)}</span>
                  {r.decidedAt && <span className="block">{r.status === 'APPROVED' ? 'approved' : 'rejected'} by {r.decidedBy ?? '—'}, {fmt(r.decidedAt)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </main>
  )
}
