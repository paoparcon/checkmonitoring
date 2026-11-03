import { Panel } from './Panel'
import { formatManila } from '@/lib/manila-format'

type Row = {
  id: string
  createdAt: Date
  actorType: string
  action: string
  remarks: string | null
  user: { name: string } | null
}

/**
 * WHO DID WHAT TO THIS CHEQUE, IN ORDER.
 *
 * It was a four-column table, which is the wrong shape for it. Two of the four
 * columns were nearly always an em dash, the remarks — the one part a future
 * reader cannot reconstruct — were squeezed into whatever width was left, and
 * a trail of four entries rendered as a table with a header, which reads as
 * data somebody is expected to compare down the column. Nobody compares audit
 * rows down a column; they read them in order, like a sentence.
 *
 * So it is a list with a rail down the side, oldest first, matching the order
 * the page queries in. The action leads, because it is what happened; the
 * person and the time follow it; the remark, when there is one, gets a full
 * line of its own.
 *
 * ── THE DOT ──────────────────────────────────────────────────────────────
 * Filled navy for a person, hollow for SYSTEM. That is the one distinction
 * worth a second channel on this list: "Ronald marked this released" and "the
 * Acumatica sync marked this released" are different facts about the same
 * cheque, and the audit trail is where somebody goes to tell them apart. It is
 * never the only signal — the name column says SYSTEM in words.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The year is in the timestamp deliberately. The register goes back to 2024 and
 * a trail reading "Sep 4, 10:45 AM" tells a reader nothing about which
 * September.
 */
const fmt = (d: Date) =>
  formatManila(d, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })

export function AuditTrail({ rows }: { rows: Row[] }) {
  return (
    <Panel
      title="AUDIT TRAIL"
      aside={
        rows.length > 0 && (
          <span className="text-[11px] font-medium tracking-wide text-slate-400">
            {rows.length.toLocaleString('en-PH')} ENTR{rows.length === 1 ? 'Y' : 'IES'} · OLDEST FIRST
          </span>
        )
      }
    >
      {rows.length === 0 ? (
        // Not an empty table, and not a bare "no rows". Every cheque that came
        // out of the register import has a trail; one with none is a cheque
        // nothing has happened to yet, which is a fact worth stating.
        <p className="rounded-xl bg-ground px-4 py-6 text-center text-sm text-slate-500">
          NOTHING HAS BEEN DONE TO THIS CHECK YET — no signature, no release, no correction.
          Every action taken on it from here will be recorded on this list and can never be edited
          or removed.
        </p>
      ) : (
        <ol className="space-y-0">
          {rows.map((r) => {
            const system = r.actorType === 'SYSTEM'
            return (
              <li
                key={r.id}
                // The rail is a pseudo-element on the item rather than a
                // separate absolutely-positioned line, so it stretches with an
                // entry that carries a long remark and stops at the last one.
                className="relative flex gap-4 pb-6 last:pb-0 before:absolute before:bottom-0 before:left-[7px] before:top-5 before:w-px before:bg-hairline last:before:hidden"
              >
                <span
                  aria-hidden="true"
                  className={`relative z-10 mt-1.5 h-3.5 w-3.5 shrink-0 rounded-full ${
                    system ? 'bg-white ring-2 ring-hairline' : 'bg-navy ring-2 ring-navy-bg'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold tracking-wide text-navy">
                    {r.action.replace(/_/g, ' ').toUpperCase()}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className={system ? 'tracking-wide text-slate-400' : 'font-medium text-slate-600'}>
                      {system ? 'SYSTEM' : r.user?.name ?? 'UNKNOWN USER'}
                    </span>
                    {' · '}
                    <span className="tabular-nums">{fmt(r.createdAt)}</span>
                  </p>
                  {/* Only when there is one. An em dash on its own line is a
                      line of nothing, and this is the column that carries the
                      part of the record nobody can reconstruct later. */}
                  {r.remarks && (
                    <p className="mt-1.5 break-words rounded-lg bg-ground px-3 py-2 text-sm text-slate-700">
                      {r.remarks}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
