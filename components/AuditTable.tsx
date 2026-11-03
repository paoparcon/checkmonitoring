import Link from 'next/link'
import { actionWords } from '@/lib/audit-view'
import type { AuditRow } from '@/lib/audit-query'
import { UrlKitTable } from './table-kit/UrlKitTable'
import type { KitRow } from './table-kit/KitTable'
import { AUDIT_BINDINGS, AUDIT_TABLE_ID, auditColumns } from '@/lib/table-kit/audit'

const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Manila',
  })

/** The JSON, as key/value lines. Nothing is parsed for meaning — least of all an amount. */
function Details({ details }: { details: unknown }) {
  if (details === null || details === undefined) return <span className="text-slate-300">—</span>
  const entries = typeof details === 'object' && !Array.isArray(details)
    ? Object.entries(details as Record<string, unknown>)
    : [['value', details] as const]
  return (
    // A native disclosure: server-rendered, no script, and it keeps a 300-row
    // page readable while leaving every field one click away.
    <details className="text-xs">
      <summary className="cursor-pointer text-slate-500">{entries.length} field{entries.length === 1 ? '' : 's'}</summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {entries.map(([k, v]) => (
          <div key={String(k)} className="contents">
            <dt className="font-mono text-slate-400">{String(k)}</dt>
            <dd className="break-all font-mono text-slate-700">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}


/**
 * The trail, newest first. Filled navy dot for a person, hollow for SYSTEM —
 * the same signal the per-check trail uses, and never the only one: the WHO
 * column says SYSTEM in words. The year is in every timestamp deliberately.
 */
export function AuditTable({
  rows, actions, users, values, empty,
}: {
  rows: readonly AuditRow[]
  actions: readonly string[]
  users: readonly { id: string; name: string }[]
  /** The page's raw parameters: action, user, check, from, to. */
  values: Readonly<Record<string, string>>
  /** Shown in the table body when no row matches. */
  empty?: string
}) {
  const kitRows: KitRow[] = rows.map((r) => {
    const system = r.actorType === 'SYSTEM'
    return {
      key: r.id,
      values: {},
      cells: {
        when: fmt(r.createdAt),
        who: (
          <>
            <span aria-hidden="true" className={`mr-2 inline-block h-2.5 w-2.5 rounded-full align-middle ${system ? 'bg-white ring-2 ring-hairline' : 'bg-navy'}`} />
            {system ? <span className="tracking-wide text-slate-400">SYSTEM</span> : <span className="font-medium">{r.userName ?? 'UNKNOWN USER'}</span>}
          </>
        ),
        action: actionWords(r.action),
        check: r.checkId && r.checkNumber
          ? <Link prefetch={false} href={`/checks/${r.checkId}`} className="underline underline-offset-2">{r.checkNumber}</Link>
          : r.checkNumber
            ? <span className="text-slate-500" title="This check has since been removed; the number is what the row recorded.">{r.checkNumber}</span>
            : r.plannedOutflowId
              // Not a check at all: a planned outflow line (2026-09-12). Saying
              // "(check removed)" here would assert a deletion that never happened.
              ? <Link href="/forecast/planned" className="text-slate-500 underline underline-offset-2">PLANNED OUTFLOW</Link>
              : <span className="text-slate-400">(check removed)</span>,
        remarks: r.remarks ?? <span className="text-slate-300">—</span>,
        details: <Details details={r.details} />,
      },
    }
  })
  return (
    <UrlKitTable
      tableId={AUDIT_TABLE_ID} columns={auditColumns({ actions, users })} rows={kitRows}
      bindings={AUDIT_BINDINGS} values={values} drop={['before']} markOwn={false} empty={empty}
    />
  )
}
