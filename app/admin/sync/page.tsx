import { requireAdmin } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { getSyncOverview, type TenantSync } from '@/lib/admin/sync-overview'
import { getLastAutoSign } from '@/lib/sync/auto-sign'
import { BILLS_MODE } from '@/lib/sync/bills'
import { BILL_REFS_MODE } from '@/lib/sync/modes'
import { EmptyState } from '@/components/EmptyState'
import { SyncNowButton } from '@/components/SyncNowButton'
import { KitTable, type KitRow } from '@/components/table-kit/KitTable'
import type { KitColumn } from '@/lib/table-kit/types'
import { instantValue } from '@/lib/table-kit/match'
import { loadSettings } from '@/lib/settings/read'

// Spec §11's wording: "Last Sync: September 1, 2026 — 10:45 AM".
const fmtDateTime = (d: Date | null) =>
  d
    ? d.toLocaleString('en-PH', {
        month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
      })
    : null

const n = (v: number) => v.toLocaleString('en-PH')

const TENANT_LABEL: Readonly<Record<string, string>> = {
  GOLIVE: 'GO-LIVE',
  MANUFACTURING: 'MANUFACTURING',
}

function Counts({ run }: { run: NonNullable<TenantSync['lastAttempt']> }) {
  // Staged is shown beside imported and updated, never inferred from a
  // shortfall: 80 live cheques carry a memo where their number belongs and land
  // in staging on every single run. They used to be counted as errors, which is
  // why this figure is stated rather than left to be worked out.
  return (
    <p className="text-sm text-slate-700">
      {n(run.imported)} new checks imported, {n(run.updated)} records updated,{' '}
      {n(run.staged)} staged for review, {n(run.errors)} errors
    </p>
  )
}

function TenantCard({
  t, inProgressMinutes, abandonedAfterMinutes,
}: {
  t: TenantSync
  inProgressMinutes: number
  abandonedAfterMinutes: number
}) {
  const lastSuccess = fmtDateTime(t.lastSuccess?.startedAt ?? null)
  const lastAttempt = fmtDateTime(t.lastAttempt?.startedAt ?? null)

  return (
    <section className="space-y-4 rounded-2xl bg-white p-6 ring-1 ring-hairline">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">
          ACUMATICA · {TENANT_LABEL[t.tenant] ?? t.tenant}
        </h2>
        {/* Two different facts, and conflating them is what wasted half an hour
            on 2026-09-04: a run still working looks exactly like one whose
            process was killed, because runSync reports its counts only at the
            end. Past ABANDONED_AFTER_MINUTES the screen stops claiming the run
            is alive — it cannot see the process, and "SYNCING…" over a dead job
            is a statement this system has no basis for. */}
        {t.abandoned ? (
          <span className="rounded-full bg-danger-bg px-2.5 py-1 text-xs font-semibold tracking-wide text-danger-ink">
            RUN ABANDONED
          </span>
        ) : t.inFlight ? (
          <span
            className="rounded-full bg-warning-bg px-2.5 py-1 text-xs font-semibold tracking-wide text-warning-ink"
            title={`A run started and has not reported finishing. SYNC NOW refuses to start another for ${inProgressMinutes} minutes after that; past that it treats the run as dead and will start. Past ${abandonedAfterMinutes} minutes this screen calls it abandoned.`}
          >
            RUN NOT FINISHED
          </span>
        ) : null}
      </div>

      {/* A tenant that has never been read says so. An empty space here would
          be indistinguishable from a tenant that synced cleanly and imported
          nothing, which is the opposite fact. */}
      {t.lastAttempt === null ? (
        <p className="text-sm text-slate-500">This tenant has never been synced.</p>
      ) : t.abandoned ? (
        <div className="space-y-2 rounded-xl bg-danger-bg p-4 ring-1 ring-danger-ink/20">
          <p className="text-sm font-medium text-danger-ink">
            A run started {t.lastAttempt.startedAt.toISOString().slice(0, 16).replace('T', ' ')} and never
            reported finishing.
          </p>
          <p className="text-sm text-danger-ink/90">
            Its process was almost certainly killed. A first full sync reads tens of thousands of rows
            and cannot complete inside a web request — whatever it wrote is committed and correct, but
            it stopped partway. Finish it from a terminal, where nothing imposes a timeout:
          </p>
          <code className="block rounded-lg bg-white/70 px-3 py-2 text-xs text-danger-ink">
            npx.cmd tsx scripts/sync.ts {t.tenant}
          </code>
          <p className="text-xs text-danger-ink/90">
            Re-running is safe: the sync is idempotent, so rows already written are updated rather than
            duplicated.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">LAST SUCCESSFUL SYNC</p>
            <p className="text-lg font-semibold text-navy">
              {lastSuccess ?? 'None — no run has finished without errors.'}
            </p>
            {t.lastSuccess && <Counts run={t.lastSuccess} />}
          </div>

          <div>
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">LAST ATTEMPT</p>
            <p className="text-sm text-slate-900">{lastAttempt}</p>
            <Counts run={t.lastAttempt} />
            {t.inFlight && !t.abandoned && (
              <p className="mt-2 text-xs text-slate-500">
                Started {Math.floor((Date.now() - t.lastAttempt.startedAt.getTime()) / 60_000)} minutes ago
                and not finished. SYNC NOW will refuse until {inProgressMinutes} minutes have
                passed, then treat it as dead and start; the schedule does the same.
              </p>
            )}
            {/* The run's own recorded problem text, truncated by `runSync`. It
                is the difference between "3 errors" and a diagnosis. */}
            {t.lastAttempt.message && (
              <p className="mt-2 rounded-lg bg-warning-bg p-3 text-sm text-warning-ink">
                {t.lastAttempt.message}
              </p>
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold tracking-widest text-slate-400">NEXT RUN READS FROM</p>
            <p className="text-sm text-slate-700">
              {fmtDateTime(t.lastAttempt.watermark) ??
                'the beginning — no watermark has been recorded, so the next run is a full read'}
            </p>
          </div>
        </div>
      )}

      <SyncNowButton tenant={t.tenant} label={TENANT_LABEL[t.tenant] ?? t.tenant} />
    </section>
  )
}

/**
 * A non-payment read reuses the three count columns for different things.
 * `short` is the caption under the mode, in column order; `titles` the
 * per-cell hover text.
 */
const COUNT_CAPTIONS: Partial<Record<string, { short: string; titles: readonly [string, string, string] }>> = {
  [BILLS_MODE]: {
    short: 'vouchers added · checks · not held here',
    titles: ['vouchers added', 'checks changed', 'payments not held here'],
  },
  [BILL_REFS_MODE]: {
    short: 'bills written · deleted · ref but no PO (due dates in MESSAGE)',
    titles: ['bills with a PO written', 'bills deleted (VendorRef no longer names a PO)', 'bills with a VendorRef that names no PO'],
  },
}

export default async function SyncPage() {
  await requireAdmin()

  const settings = await loadSettings(prisma)
  const [overview, recent, lastAutoSign] = await Promise.all([
    getSyncOverview(prisma, new Date(), settings.values['sync.abandonedAfterMinutes']),
    prisma.syncRun.findMany({ orderBy: { startedAt: 'desc' }, take: 25 }),
    getLastAutoSign(prisma),
  ])

  const distinct = (vals: string[]) => [...new Set(vals)].sort().map((v) => ({ value: v, label: v }))
  const columns: KitColumn[] = [
    { key: 'started', label: 'STARTED', kind: 'date', locked: true, className: 'text-slate-600' },
    { key: 'tenant', label: 'TENANT', kind: 'enum', options: distinct(recent.flatMap((r) => (r.tenant ? [r.tenant] : []))) },
    { key: 'mode', label: 'MODE', kind: 'enum', options: distinct(recent.map((r) => r.mode)), className: 'text-slate-600' },
    { key: 'trigger', label: 'TRIGGER', kind: 'enum', options: distinct(recent.map((r) => r.trigger)), className: 'text-slate-600' },
    { key: 'imported', label: 'IMPORTED', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'updated', label: 'UPDATED', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'staged', label: 'STAGED', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'errors', label: 'ERRORS', kind: 'amount', align: 'right', className: 'tabular-nums' },
    { key: 'finished', label: 'FINISHED', kind: 'date', className: 'text-slate-600' },
    { key: 'message', label: 'MESSAGE', kind: 'text', className: 'max-w-md text-slate-600' },
  ]
  const rows: KitRow[] = recent.map((r) => {
    const cap = COUNT_CAPTIONS[r.mode]
    return {
      key: r.id,
      values: {
        started: instantValue(r.startedAt), tenant: r.tenant, mode: r.mode, trigger: r.trigger,
        imported: String(r.imported), updated: String(r.updated), staged: String(r.staged), errors: String(r.errors),
        finished: instantValue(r.finishedAt), message: r.message,
      },
      cells: {
        started: fmtDateTime(r.startedAt),
        // An em dash rather than a blank: a run with no tenant is a run recorded
        // before the column existed, not a rendering fault.
        tenant: r.tenant ?? '—',
        // A BILLS or BILL_REFS row reuses the three count columns for different
        // things; the caption names them in column order.
        mode: (
          <>
            {r.mode}
            {cap && (
              <span className="block whitespace-nowrap text-[11px] text-slate-400">{cap.short}</span>
            )}
          </>
        ),
        trigger: r.trigger,
        imported: <span title={cap?.titles[0]}>{n(r.imported)}</span>,
        updated: <span title={cap?.titles[1]}>{n(r.updated)}</span>,
        staged: <span title={cap?.titles[2]}>{n(r.staged)}</span>,
        errors: <span className={r.errors > 0 ? 'font-semibold text-danger-ink' : 'text-slate-600'}>{n(r.errors)}</span>,
        finished: fmtDateTime(r.finishedAt) ?? 'NOT FINISHED',
        message: r.message ?? '—',
      },
    }
  })

  return (
    <div className="space-y-6">
      {/* One card per tenant, never one pooled figure. `SyncRun.tenant` exists
          because Go-Live `ST` is Starkson Packaging and MANUFACTURING `ST` is
          Starkson Paper and Plastic; a "last sync" across both would be a
          number about nothing. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {overview.tenants.map((t) => (
          <TenantCard
            key={t.tenant} t={t}
            inProgressMinutes={settings.values['sync.inProgressMinutes']}
            abandonedAfterMinutes={settings.values['sync.abandonedAfterMinutes']}
          />
        ))}
      </div>

      {/* Auto-sign is retired (lib/sync/auto-sign.ts, user ruling 2026-10-27):
          every run records DISABLED and signs nothing. The latest row is shown
          so an admin can see the clock is not signing. */}
      <section className="rounded-2xl bg-white p-6 ring-1 ring-hairline">
        <h2 className="text-[11px] font-semibold tracking-widest text-slate-400">LAST AUTO-SIGN</h2>
        {lastAutoSign === null ? (
          <p className="mt-2 text-sm text-slate-600">
            Auto-sign is switched off: signing is manual (SIGN ALL on the SIGNATURE PENDING list). The cron still records a run here.
          </p>
        ) : lastAutoSign.outcome === 'FAILED' ? (
          <div className="mt-2 space-y-2 rounded-xl bg-danger-bg p-4 ring-1 ring-danger-ink/20">
            <p className="text-sm font-medium text-danger-ink">
              {fmtDateTime(lastAutoSign.at)} — FAILED
              {/* Shown here too: a run that hit its time budget mid-backlog may
                  still have signed some cheques before it stopped, and that is
                  worth knowing even though the run did not finish. */}
              {lastAutoSign.signed > 0 && <>: {n(lastAutoSign.signed)} check(s) signed</>}
              {lastAutoSign.skipped > 0 && <>, {n(lastAutoSign.skipped)} skipped because they changed first</>}
            </p>
            {lastAutoSign.error && <p className="text-sm text-danger-ink/90">{lastAutoSign.error}</p>}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {fmtDateTime(lastAutoSign.at)} — {lastAutoSign.outcome}
            {/* A run recorded before the Monday rule (2026-10-01) is described by its own rule. */}
            {lastAutoSign.outcome === 'OK' && (lastAutoSign.legacyDays !== null
              ? <>: {n(lastAutoSign.signed)} check(s) signed after {n(lastAutoSign.legacyDays)} day(s)</>
              : <>: {n(lastAutoSign.signed)} check(s) signed</>)}
            {lastAutoSign.outcome === 'IDLE' && <>: not a Monday or Tuesday — nothing due</>}
            {lastAutoSign.skipped > 0 && <>, {n(lastAutoSign.skipped)} skipped because they changed first</>}
            {lastAutoSign.outcome === 'DISABLED' && <>: switched off — signing is manual since 2026-10-22</>}
          </p>
        )}
      </section>

      {overview.untenantedRuns > 0 && (
        <p className="rounded-xl bg-white px-4 py-3 text-sm leading-relaxed text-slate-600 ring-1 ring-hairline">
          {n(overview.untenantedRuns)} earlier run(s) predate the tenant column and are not
          attributed to either tenant. They are listed below.
        </p>
      )}

      {/* An empty sync log is not an empty table. "Nobody has ever synced" and
          "the log failed to render" look identical once the headers are drawn
          over nothing, and the first of the two is a fact somebody needs to
          act on. */}
      {recent.length === 0 ? (
        <EmptyState title="NO SYNC HAS EVER RUN">
          Nothing has been read from Acumatica on this database yet. Press SYNC NOW on a tenant
          above, or run <code className="rounded bg-ground px-1">scripts/sync.ts</code> from a
          terminal for the first full read — it is far too long for a web request.
        </EmptyState>
      ) : (
        <section className="rounded-2xl bg-white ring-1 ring-hairline">
          <h2 className="px-6 pb-4 pt-6 text-[11px] font-semibold tracking-widest text-slate-400">SYNC LOG</h2>
          <div className="px-4 pb-4">
            <KitTable tableId="sync-runs" frameClassName="overflow-x-auto" columns={columns} rows={rows} capped={recent.length >= 25} />
          </div>
        </section>
      )}
    </div>
  )
}
