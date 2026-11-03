import { FilterForm } from '@/components/FilterForm'
import Link from 'next/link'
import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { EmptyState } from '@/components/EmptyState'
import { AuditTable } from '@/components/AuditTable'
import { listAuditRows, countAuditRows, listAuditActions, listAuditUsers } from '@/lib/audit-query'
import {
  AUDIT_PATH, AUDIT_EXPORT_PATH, AUDIT_PAGE_SIZE,
  parseAuditParams, encodeCursor, auditHref, describeAuditFilters, actionWords, type AuditParams,
} from '@/lib/audit-view'

/**
 * THE AUDIT TRAIL, READ. Until 2026-09-11 it was write-only: 65,269 rows and
 * no screen that could show one except a cheque's own trail.
 *
 * It opens on what PEOPLE did — 4 rows of 65,269 on the day it was built, and
 * every signature, release, reversal and user change from here on. The system's
 * rows are one toggle away, because the day's most important record (the 1,958
 * company restorations of 10 September) is a SYSTEM row.
 *
 * Nothing here writes. `writeAudit` is the only writer and the trigger keeps
 * every row as written.
 */
const FIELD = 'h-10 rounded-lg border border-hairline bg-white px-3 text-sm text-slate-900 focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy'

export default async function AuditPage({ searchParams }: { searchParams: Promise<AuditParams> }) {
  await requireAdmin()
  const params = await searchParams
  const { filters, cursor, raw } = parseAuditParams(params)

  const [page, total, actions, users] = await Promise.all([
    listAuditRows(prisma, filters, cursor),
    countAuditRows(prisma, filters),
    listAuditActions(prisma),
    listAuditUsers(prisma),
  ])

  // A hand-edited URL naming an action or user that does not exist narrows to
  // nothing; the selects simply show it unselected and the count says 0.
  const current: AuditParams = {
    system: filters.system ? '1' : undefined, action: filters.action, user: filters.userId,
    check: filters.checkNumber, from: raw.from, to: raw.to,
  }
  const anyFilter = Boolean(filters.system || filters.action || filters.userId || filters.checkNumber || filters.from || filters.to)
  const last = page.rows[page.rows.length - 1]

  // An admin who narrows by a system-only ACTION (IMPORTED: 26,432 rows) without
  // ticking SYSTEM ROWS gets zero rows because the population excludes it, not
  // because the filters disagree with each other. "Nothing carries these filters
  // together" is false in that case — something does, it is just not a person's
  // row — so say what actually happened instead of a generic non-match.
  const filteredEmptyMessage = !filters.system
    ? "Nothing a person did carries these filters. SYSTEM ROWS is off — most actions in the trail are the system's; tick it to include them."
    : 'Nothing in the trail carries these filters together.'

  return (
    <div className="space-y-6">
      <FilterForm className="flex flex-wrap items-center gap-2 rounded-2xl bg-white p-3 ring-1 ring-hairline">
        <label className="flex h-10 items-center gap-2 rounded-lg border border-hairline bg-white px-3 text-sm">
          <input type="checkbox" name="system" value="1" defaultChecked={filters.system} />
          SYSTEM ROWS
        </label>
        <select name="action" defaultValue={filters.action ?? ''} className={FIELD}>
          <option value="">ANY ACTION</option>
          {actions.map((a) => <option key={a} value={a}>{actionWords(a)}</option>)}
        </select>
        <select name="user" defaultValue={filters.userId ?? ''} className={FIELD}>
          <option value="">ANY USER</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input name="check" defaultValue={filters.checkNumber ?? ''} placeholder="CHECK NUMBER (exact)" className={`${FIELD} w-48`} />
        <input name="from" type="date" defaultValue={raw.from ?? ''} className={FIELD} />
        <input name="to" type="date" defaultValue={raw.to ?? ''} className={FIELD} />
        <button type="submit" className="h-10 rounded-lg bg-navy px-4 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">APPLY</button>
        {anyFilter && <Link href={AUDIT_PATH} className="text-sm text-slate-500 underline underline-offset-2">RESET</Link>}
      </FilterForm>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-slate-600">
            {total.toLocaleString('en-PH')} ROW{total === 1 ? '' : 'S'} · {describeAuditFilters(filters, { user: users.find((u) => u.id === filters.userId)?.name })}
            {cursor ? ' · CONTINUED' : ''}
          </p>
          {/* The CHECK filter goes through the join, and 17,087 rows belong to
              cheques that were later removed. They cannot match a number, and
              a count that quietly excluded them would read as the whole. */}
          {filters.checkNumber && (
            <p className="text-xs font-medium tracking-wide text-slate-500">
              Rows whose check has since been removed cannot match a check number; clear this filter and
              show SYSTEM ROWS to see them.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-slate-500">The file holds this filtered range, newest first.</span>
          <a href={auditHref(current, AUDIT_EXPORT_PATH)} className="rounded-lg bg-navy px-4 py-2 text-sm font-medium tracking-wide text-white transition hover:bg-navy/90">
            EXPORT EXCEL
          </a>
        </div>
      </div>

      {page.rows.length === 0 && !anyFilter ? (
        <EmptyState title="NOBODY HAS DONE ANYTHING YET">
          No signature, release, reversal or user change has been recorded by a person. Tick SYSTEM ROWS to see what the imports and the sync have done.
        </EmptyState>
      ) : (
        <AuditTable
          rows={page.rows}
          actions={actions}
          users={users.map((u) => ({ id: u.id, name: u.name }))}
          values={{
            action: filters.action ?? '', user: filters.userId ?? '', check: filters.checkNumber ?? '',
            from: raw.from ?? '', to: raw.to ?? '',
          }}
          empty={filteredEmptyMessage}
        />
      )}

      <div className="flex items-center justify-between text-sm">
        {cursor
          ? <Link href={auditHref({ ...current })} className="underline underline-offset-2">← NEWEST</Link>
          : <span />}
        {page.hasMore && last && (
          <Link href={auditHref({ ...current, before: encodeCursor({ createdAt: last.createdAt, id: last.id }) })} className="underline underline-offset-2">
            NEXT {AUDIT_PAGE_SIZE} →
          </Link>
        )}
      </div>
    </div>
  )
}
