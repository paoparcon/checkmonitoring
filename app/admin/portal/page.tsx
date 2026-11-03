import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getPortalOverview } from '@/lib/admin/portal-overview'
import { PortalActionButton } from '@/components/PortalRetryButton'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { instantValue } from '@/lib/table-kit/match'
import { deliverPortalNowAction, retryPortalEventAction } from './actions'

const fmt = (d: Date) => d.toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export default async function AdminPortalPage() {
  await requireAdmin()
  const o = await getPortalOverview(prisma)
  const distinct = (vals: string[]) => [...new Set(vals)].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'check', label: 'CHECK', kind: 'text', locked: true },
    { key: 'payee', label: 'PAYEE', kind: 'text' },
    { key: 'kind', label: 'EVENT', kind: 'enum', options: distinct(o.attention.map((r) => r.kind)) },
    { key: 'status', label: 'STATUS', kind: 'enum', options: distinct(o.attention.map((r) => r.status)) },
    { key: 'tries', label: 'TRIES', kind: 'amount' },
    { key: 'lastError', label: 'LAST ERROR', kind: 'text', className: 'max-w-md truncate' },
    { key: 'next', label: 'NEXT', kind: 'date' },
    { key: 'retry', label: '', kind: 'text', noSort: true, noFilter: true, locked: true },
  ]
  const rows: KitRow[] = o.attention.map((r) => ({
    key: r.id,
    values: {
      check: r.checkNumber, payee: r.payeeName, kind: r.kind, status: r.status, tries: String(r.attempts),
      lastError: r.lastError, next: r.status === 'FAILED' ? instantValue(r.nextAttemptAt) : null,
    },
    cells: {
      check: <a className="underline" href={`/checks/${r.checkId}`}>{r.checkNumber}</a>,
      payee: r.payeeName ?? '—',
      kind: r.kind,
      status: r.status,
      tries: r.attempts,
      lastError: <span title={r.lastError ?? ''}>{r.lastError ?? '—'}</span>,
      next: r.status === 'FAILED' ? fmt(r.nextAttemptAt) : '—',
      retry: (
        <PortalActionButton label="RETRY" pending="…" action={async () => {
          'use server'
          const f = new FormData(); f.set('eventId', r.id)
          return retryPortalEventAction(f)
        }} />
      ),
    },
  }))
  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">SUPPLIER PORTAL · OUTBOX</h2>
          <PortalActionButton label="DELIVER NOW" pending="DELIVERING…" action={deliverPortalNowAction} />
        </div>
        <p className="mt-2 text-sm text-slate-700">
          {o.counts.PENDING} pending · {o.counts.IN_FLIGHT} in flight · {o.counts.FAILED} retrying · {o.counts.PARKED} parked · {o.closed.delivered} delivered · {o.closed.superseded} superseded · {o.closed.stale} closed as stale · {o.closed.unmatchable} closed as unmatchable
        </p>
      </section>
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">NEEDS ATTENTION</h2>
        {o.attention.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing is parked or retrying.</p>
        ) : (
          <div className="mt-3">
            <KitTable
              tableId="portal-attention" columns={columns} rows={rows} frameClassName="" cellClassName="py-2 pr-4"
              capped={o.attention.length >= 200}
            />
          </div>
        )}
      </section>
    </div>
  )
}
