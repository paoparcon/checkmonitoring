'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { RequestView } from '@/lib/approvals/queries'
import { formatMoney } from '@/lib/money'
import { ApprovalDecision } from './ApprovalDecision'

const fmt = (d: Date) =>
  new Date(d).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export const KIND_LABEL = { MAKE_AVAILABLE: 'READY FOR RELEASE', WITHDRAW: 'REVERT TO SIGNED' } as const
const EXPECTED = { MAKE_AVAILABLE: ['SIGNED'], WITHDRAW: ['READY_FOR_RELEASE', 'SCHEDULED'] } as const

/** The open requests, with APPROVE / REJECT per row and over the ticked rows for the approver. */
export function ApprovalsTable({ rows, canDecide }: { rows: RequestView[]; canDecide: boolean }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const ids = rows.filter((r) => selected.has(r.id)).map((r) => r.id)
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id))

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-[11px] font-semibold tracking-widest text-slate-400">
            <tr>
              {canDecide && (
                <th className="px-3 py-2">
                  <input type="checkbox" checked={all} aria-label="Select every request"
                    onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} />
                </th>
              )}
              <th className="px-3 py-2">REQUEST</th>
              <th className="px-3 py-2">CHECK</th>
              <th className="px-3 py-2">PAYEE</th>
              <th className="px-3 py-2 text-right">AMOUNT</th>
              <th className="px-3 py-2">NOW</th>
              <th className="px-3 py-2">DETAIL</th>
              <th className="px-3 py-2">REQUESTED</th>
              {canDecide && <th className="px-3 py-2">DECIDE</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((r) => {
              const stale = !(EXPECTED[r.kind] as readonly string[]).includes(r.checkStatus)
              return (
                <tr key={r.id} className={stale ? 'bg-amber-50/60' : ''}>
                  {canDecide && (
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.checkNumber ?? r.id}`} />
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium text-navy">{KIND_LABEL[r.kind]}</td>
                  <td className="px-3 py-2">
                    <Link href={`/checks/${r.checkId}`} className="font-mono text-navy underline-offset-2 hover:underline">{r.checkNumber ?? '—'}</Link>
                    <span className="ml-2 text-xs text-slate-400">{r.company}</span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{r.payeeName ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.amount ? formatMoney(r.amount, r.currency) : '—'}</td>
                  <td className="px-3 py-2">
                    <span className={stale ? 'font-medium text-amber-800' : 'text-slate-600'}>{r.checkStatus.replace(/_/g, ' ')}</span>
                    {stale && <span className="block text-[11px] text-amber-800">moved since the request — reject it</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {r.kind === 'MAKE_AVAILABLE' ? `Pickup ${r.pickupDay ?? '—'}` : r.reason}
                    {r.fromUpload && <span className="block text-[11px] text-slate-400">from {r.fromUpload}</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-600">{r.requestedBy}<span className="block text-[11px] text-slate-400">{fmt(r.requestedAt)}</span></td>
                  {canDecide && <td className="px-3 py-2"><ApprovalDecision requestIds={[r.id]} compact /></td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {canDecide && ids.length > 0 && (
        <div className="sticky bottom-0 z-10 rounded-2xl bg-white p-4 shadow-lg ring-1 ring-slate-300">
          <p className="mb-2 text-sm font-semibold tracking-wide text-slate-900">{ids.length} SELECTED</p>
          <ApprovalDecision requestIds={ids} onDone={() => setSelected(new Set())} />
        </div>
      )}
    </div>
  )
}
