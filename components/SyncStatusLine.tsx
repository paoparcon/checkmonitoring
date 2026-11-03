import Link from 'next/link'
import type { Staleness } from '@/lib/sync/staleness'

const TENANT_LABEL: Readonly<Record<string, string>> = {
  GOLIVE: 'GO-LIVE',
  MANUFACTURING: 'MANUFACTURING',
}

/**
 * Manila, stated. Every other timestamp on the dashboard calls
 * `toLocaleString('en-PH', …)` with no zone and renders in the SERVER's zone —
 * which on Vercel is UTC, eight hours behind the office. For a line whose one
 * job is "how old is this", eight hours is the difference between fine and
 * stale, so the zone is named.
 */
const fmt = (d: Date) =>
  d.toLocaleString('en-PH', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila',
  })

/**
 * When Acumatica was last read, and — past the threshold — that it has not been.
 *
 * Since the register was retired, the sync is the only way a cheque arrives.
 * This line is what makes a sync nobody ran visible: on the once-a-day plan
 * the cron is the mechanism and this is the check on it. Shown to everyone,
 * and since 2026-10-15 every Finance user has SYNC NOW beneath it.
 */
export function SyncStatusLine({ staleness }: { staleness: Staleness }) {
  const parts = staleness.tenants.map(
    (t) => `${TENANT_LABEL[t.tenant] ?? t.tenant} ${t.lastReadAt ? fmt(t.lastReadAt) : 'never'}`,
  )

  if (!staleness.warn) {
    return (
      <p className="text-xs font-medium tracking-wide text-slate-500">
        ACUMATICA LAST READ · {parts.join(' · ')}
      </p>
    )
  }

  const neverRead = staleness.tenants.filter((t) => t.lastReadAt === null)
  const headline = neverRead.length
    ? `ACUMATICA HAS NEVER BEEN READ FOR ${neverRead.map((t) => TENANT_LABEL[t.tenant] ?? t.tenant).join(' AND ')}`
    : `ACUMATICA NOT READ FOR ${staleness.oldestHours} HOURS`

  return (
    <div className="rounded-xl bg-warning-bg px-4 py-3 text-sm text-warning-ink ring-1 ring-warning-ink/20">
      <p className="font-semibold tracking-wide">{headline}</p>
      {/*
       * NOT "cheques since then are not on this board" — `lastSuccess` requires
       * `errors = 0`, but `runSync` deliberately tolerates a bad row rather than
       * aborting a 37,000-row run over one of them. A run that read 500 rows
       * with one failure leaves `lastSuccess` frozen at the run before it, so
       * that sentence would say cheques were missing when they were in fact
       * read — erring loud is the right call, but only when what is said is
       * true. Say the weaker, honest thing instead: the last CLEAN read is old,
       * so something MAY be missing, and the detail lives on /admin/sync.
       */}
      <p className="mt-1">
        Acumatica has not been read cleanly since then, so checks generated since may be missing —{' '}
        <Link href="/admin/sync" className="underline underline-offset-2">/admin/sync</Link> shows
        what the last attempt reported. {parts.join(' · ')}.{' '}
        Press SYNC NOW below.
      </p>
    </div>
  )
}
