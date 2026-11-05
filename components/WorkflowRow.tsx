import Link from 'next/link'
import type { ReactNode } from 'react'
import { buildReleaseTimeline, type TimelineSummary } from '@/lib/release-timeline'
import { cardHref, isCardSelected, type DashboardSelection } from '@/lib/dashboard-view'

/**
 * THE STAGES, ONCE EACH (2026-10-07: "this looks redundant", then "it looks
 * boring again").
 *
 * READY FOR RELEASE lives in the hero (components/DashboardHero.tsx). Here:
 * the other stages as cards — GENERATED only when non-zero, PENDING, SIGNED,
 * RELEASED and ALL CHECKS — each linking to its list (`cardHref`, the URLs the
 * old cards used), then a pipeline bar showing what SHARE of the live cheques
 * sits on each rung. The bar carries percentages, never the counts, so no
 * figure on the screen appears twice. Every count is the summary the page
 * already fetched (`buildReleaseTimeline`).
 */
type Tone = { bg: string; ink: string; accent: string; icon: string; bar: string }
const TONE: Record<string, Tone> = {
  GENERATED: { bg: 'bg-white', ink: 'text-slate-700', accent: 'bg-slate-400', icon: 'bg-slate-100 text-slate-600', bar: 'bg-slate-400' },
  SIGNATURE_PENDING: { bg: 'bg-white', ink: 'text-warning-ink', accent: 'bg-amber-400', icon: 'bg-warning-bg text-warning-ink', bar: 'bg-amber-400' },
  SIGNED: { bg: 'bg-white', ink: 'text-sky-ink', accent: 'bg-sky-500', icon: 'bg-sky-bg text-sky-ink', bar: 'bg-sky-500' },
  READY_FOR_RELEASE: { bg: 'bg-white', ink: 'text-success-ink', accent: 'bg-emerald-500', icon: 'bg-success-bg text-success-ink', bar: 'bg-emerald-500' },
  RELEASED: { bg: 'bg-white', ink: 'text-lavender-ink', accent: 'bg-violet-400', icon: 'bg-lavender-bg text-lavender-ink', bar: 'bg-violet-400' },
  CLEARED: { bg: 'bg-white', ink: 'text-mint-ink', accent: 'bg-teal-500', icon: 'bg-mint-bg text-mint-ink', bar: 'bg-teal-500' },
  TOTAL_CHECKS: { bg: 'bg-white', ink: 'text-navy', accent: 'bg-navy', icon: 'bg-navy-bg text-navy', bar: 'bg-navy' },
  CANCELLED: { bg: 'bg-white', ink: 'text-danger-ink', accent: 'bg-rose-400', icon: 'bg-danger-bg text-danger-ink', bar: 'bg-rose-400' },
  STALED: { bg: 'bg-white', ink: 'text-warning-ink', accent: 'bg-orange-400', icon: 'bg-warning-bg text-warning-ink', bar: 'bg-orange-400' },
}

const ICON: Record<string, ReactNode> = {
  GENERATED: <path d="M6 3h7l5 5v13H6zM13 3v5h5" />,
  SIGNATURE_PENDING: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  SIGNED: <path d="M3 17c3-1 4-8 7-8s1 7 4 7 3-5 7-5M3 21h18" />,
  RELEASED: <><path d="M3 7h18v13H3z" /><path d="M3 7l9 6 9-6" /></>,
  CLEARED: <><path d="M3 10l9-6 9 6M5 10v9M19 10v9M9 10v9M15 10v9M3 21h18" /></>,
  CANCELLED: <><circle cx="12" cy="12" r="9" /><path d="M8 8l8 8M16 8l-8 8" /></>,
  STALED: <><path d="M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9" /></>,
  TOTAL_CHECKS: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
}

const NOTE: Record<string, string> = {
  GENERATED: 'Just created in Acumatica',
  SIGNATURE_PENDING: 'Waiting on a signatory',
  SIGNED: 'In hand · tick READY to release',
  RELEASED: 'Handed over · not yet cleared',
  CLEARED: 'Cleared by the bank',
  TOTAL_CHECKS: 'Every status, incl. cancelled & voided',
  CANCELLED: 'Cancelled here, incl. staled',
  STALED: 'Past their presentment life',
}

const LABEL: Record<string, string> = {
  GENERATED: 'GENERATED', SIGNATURE_PENDING: 'PENDING SIGNATURE', SIGNED: 'SIGNED', RELEASED: 'RELEASED',
  CLEARED: 'CLEARED', TOTAL_CHECKS: 'ALL CHECKS', CANCELLED: 'CANCELLED', STALED: 'STALED',
}

function StageCard({ id, count, href, selected }: { id: string; count: number; href: string; selected: boolean }) {
  const t = TONE[id]
  return (
    <Link
      href={href}
      aria-current={selected ? 'true' : undefined}
      className={`group relative overflow-hidden rounded-2xl p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${t.bg} ${
        selected ? 'ring-2 ring-navy' : 'ring-1 ring-hairline'
      }`}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${t.accent}`} />
      <div className="flex items-start justify-between gap-3">
        <span className={`text-[11px] font-semibold tracking-widest ${t.ink}`}>{LABEL[id]}</span>
        <span aria-hidden="true" className={`grid h-9 w-9 place-items-center rounded-xl ${t.icon}`}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            {ICON[id]}
          </svg>
        </span>
      </div>
      <p className={`mt-2 text-4xl font-semibold tabular-nums tracking-tight ${t.ink}`}>{count.toLocaleString('en-PH')}</p>
      <p className="mt-1 text-xs text-slate-500">{NOTE[id]}</p>
      <span aria-hidden="true" className="absolute bottom-4 right-5 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500">→</span>
    </Link>
  )
}

const pct = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10)

export function WorkflowRow({
  summary, total, closed, incomplete, incompleteHref, selection,
}: {
  summary: TimelineSummary
  /** CANCELLED and STALED, the two closed counts Finance asked to see (2026-11-05). A staled cheque is a cancelled one, so STALED is part of CANCELLED. */
  closed: { cancelled: number; stale: number }
  /** ALL CHECKS: every status, the cheque inventory. */
  total: number
  /** Cheques with no recorded amount, left out of every figure here. */
  incomplete: number
  incompleteHref: string
  selection: DashboardSelection
}) {
  const nodes = buildReleaseTimeline(summary, selection)
  const cards = nodes.filter((n) => n.id !== 'READY_FOR_RELEASE' && (n.id !== 'GENERATED' || n.count > 0))
  const cols = cards.length + 1 === 6 ? 'xl:grid-cols-6' : 'xl:grid-cols-5'

  // Where the LIVE cheques are: the rungs before RELEASED, as shares.
  const live = nodes.filter((n) => n.id !== 'RELEASED' && n.id !== 'CLEARED' && n.count > 0)
  const liveTotal = live.reduce((s, n) => s + n.count, 0)

  return (
    <section className="space-y-4">
      <div className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${cols}`}>
        {cards.map((n) => <StageCard key={n.id} id={n.id} count={n.count} href={n.href} selected={n.selected} />)}
        <StageCard
          id="TOTAL_CHECKS" count={total}
          href={cardHref('TOTAL_CHECKS', selection)} selected={isCardSelected('TOTAL_CHECKS', selection)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StageCard
          id="CANCELLED" count={closed.cancelled}
          href={cardHref('CANCELLED', selection)} selected={isCardSelected('CANCELLED', selection)}
        />
        <StageCard
          id="STALED" count={closed.stale}
          href={cardHref('STALED', selection)} selected={isCardSelected('STALED', selection)}
        />
      </div>

      {liveTotal > 0 && (
        <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-hairline">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold tracking-widest text-slate-500">WHERE THE LIVE CHECKS ARE</p>
            <p className="text-[11px] text-slate-400">share of checks not yet released</p>
          </div>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-slate-100" role="img"
            aria-label={live.map((n) => `${n.label} ${pct(n.count, liveTotal)}%`).join(', ')}>
            {live.map((n) => (
              <span key={n.id} className={`${TONE[n.id].bar} h-full`} style={{ width: `${(n.count / liveTotal) * 100}%` }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
            {live.map((n) => (
              <li key={n.id} className="flex items-center gap-2">
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${TONE[n.id].bar}`} />
                {n.id === 'SIGNATURE_PENDING' ? 'Pending' : n.label.charAt(0) + n.label.slice(1).toLowerCase()}
                <span className="font-semibold tabular-nums text-slate-800">{pct(n.count, liveTotal)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {incomplete > 0 && (
        <p className="text-xs font-medium tracking-wide text-slate-500">
          EXCLUDING {incomplete.toLocaleString('en-PH')} CHECK{incomplete === 1 ? '' : 'S'} WITH NO RECORDED AMOUNT — not counted above.{' '}
          <Link href={incompleteHref} className="underline underline-offset-2">Show them</Link>.
        </p>
      )}
    </section>
  )
}
