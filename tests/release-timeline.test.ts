import { describe, it, expect } from 'vitest'
import { buildCheckProgress, buildReleaseTimeline, type TimelineSummary } from '@/lib/release-timeline'
import { cardHref, type DashboardSelection } from '@/lib/dashboard-view'

/**
 * Pure. The workflow timeline is five counts and five links, so it is decided
 * here and tested without rendering anything — the same reasoning that put the
 * card arithmetic in lib/dashboard-view.ts.
 */

const NOTHING: DashboardSelection = { status: null, showAll: false, incomplete: false, live: false, base: {} }

// Production, 2026-09-06, as the brief states it: 242 pending signature,
// 1,034 signed, 80 ready, 9,545 released.
const SUMMARY: TimelineSummary = {
  generated: 12,
  signaturePending: 230,
  signed: 1034,
  readyForRelease: 74,
  scheduled: 6,
  released: 9545,
  cleared: 0,
}

describe('buildReleaseTimeline', () => {
  it('walks the ladder in order, so a reader sees where checks are stuck', () => {
    expect(buildReleaseTimeline(SUMMARY, NOTHING).map((n) => n.label))
      .toEqual(['GENERATED', 'PENDING', 'SIGNED', 'READY', 'RELEASED', 'CLEARED'])
  })

  it('takes every count from the summary rather than from a query of its own', () => {
    const counts = Object.fromEntries(
      buildReleaseTimeline(SUMMARY, NOTHING).map((n) => [n.id, n.count]),
    )
    expect(counts).toEqual({
      GENERATED: 12,
      SIGNATURE_PENDING: 230,
      SIGNED: 1034,
      // READY folds SCHEDULED in, exactly as the card and the view do: to
      // Finance the cheque is available and waiting to be handed over.
      READY_FOR_RELEASE: 80,
      RELEASED: 9545,
      CLEARED: 0,
    })
  })

  /**
   * The number on a node has to be the number of rows its link opens.
   *
   * This is why GENERATED is a node of its own rather than folded into PENDING
   * the way the summary card folds it: `viewStatusFilter` gives
   * `?status=SIGNATURE_PENDING` exactly the SIGNATURE_PENDING rows, so a node
   * reading 242 over a table of 230 would be a bug report waiting to happen.
   */
  it('splits GENERATED from PENDING so each node counts precisely what its link opens', () => {
    const nodes = buildReleaseTimeline(SUMMARY, NOTHING)
    const generated = nodes[0]
    const pending = nodes[1]
    expect(generated.count + pending.count).toBe(242)
    expect(generated.href).toBe('/?status=GENERATED')
    expect(pending.href).toBe('/?status=SIGNATURE_PENDING')
  })

  it('links each node exactly where the matching card links, filters and all', () => {
    const narrowed: DashboardSelection = {
      status: 'SIGNED', showAll: false, incomplete: true, live: false,
      base: { q: 'ACME', company: 'c1' },
    }
    for (const node of buildReleaseTimeline(SUMMARY, narrowed)) {
      expect(node.href, node.id).toBe(cardHref(node.id, narrowed))
    }
  })

  it('lights the node the table is currently showing', () => {
    const onSigned: DashboardSelection = { ...NOTHING, status: 'SIGNED' }
    const lit = buildReleaseTimeline(SUMMARY, onSigned).filter((n) => n.selected)
    expect(lit.map((n) => n.id)).toEqual(['SIGNED'])
  })

  it('lights READY while the table is showing a SCHEDULED check', () => {
    const onReady: DashboardSelection = { ...NOTHING, status: 'READY_FOR_RELEASE' }
    const lit = buildReleaseTimeline(SUMMARY, onReady).filter((n) => n.selected)
    expect(lit.map((n) => n.id)).toEqual(['READY_FOR_RELEASE'])
  })

  it('lights nothing on the default NEEDS ACTION view', () => {
    expect(buildReleaseTimeline(SUMMARY, NOTHING).every((n) => !n.selected)).toBe(true)
  })

  it('turns a lit node off again, rather than stranding the reader in a view', () => {
    const onSigned: DashboardSelection = { ...NOTHING, status: 'SIGNED' }
    const signed = buildReleaseTimeline(SUMMARY, onSigned).find((n) => n.id === 'SIGNED')
    expect(signed?.href).toBe('/?scope=live')
  })
})

/**
 * The same ladder, walked for ONE cheque, on the check detail page.
 *
 * Pure for the same reason the counted timeline is: five rungs and a position
 * is a decision, not a rendering, so it is decided here and tested without
 * rendering anything.
 */
describe('buildCheckProgress', () => {
  it('walks the same five rungs, in the same order, as the dashboard timeline', () => {
    expect(buildCheckProgress('SIGNED').steps.map((s) => s.label))
      .toEqual(buildReleaseTimeline(SUMMARY, NOTHING).map((n) => n.label))
  })

  it('marks the rungs behind the check DONE and the ones ahead UPCOMING', () => {
    const { steps, current } = buildCheckProgress('SIGNED')
    expect(current).toBe('SIGNED')
    expect(steps.map((s) => s.state)).toEqual(['DONE', 'DONE', 'CURRENT', 'UPCOMING', 'UPCOMING', 'UPCOMING'])
  })

  it('starts a freshly generated check on the first rung with nothing behind it', () => {
    expect(buildCheckProgress('GENERATED').steps.map((s) => s.state))
      .toEqual(['CURRENT', 'UPCOMING', 'UPCOMING', 'UPCOMING', 'UPCOMING', 'UPCOMING'])
  })

  it('leaves only the bank clearing ahead of a released check', () => {
    const { steps, current } = buildCheckProgress('RELEASED')
    expect(current).toBe('RELEASED')
    expect(steps.filter((s) => s.state === 'UPCOMING').map((s) => s.id)).toEqual(['CLEARED'])
  })

  it('leaves nothing ahead of a cleared check', () => {
    const { steps, current } = buildCheckProgress('CLEARED')
    expect(current).toBe('CLEARED')
    expect(steps.every((s) => s.state !== 'UPCOMING')).toBe(true)
  })

  /**
   * The fold the card, the view and the counted timeline all apply: a portal
   * pickup booking is the same rung with a date on it, not a sixth rung.
   */
  it('folds SCHEDULED into READY, exactly as the card and the view do', () => {
    expect(buildCheckProgress('SCHEDULED')).toEqual(buildCheckProgress('READY_FOR_RELEASE'))
    expect(buildCheckProgress('SCHEDULED').current).toBe('READY_FOR_RELEASE')
  })

  /**
   * A cancelled cheque stopped somewhere and nothing records where. Drawing it
   * as having reached a particular rung would be an invention; this states the
   * stop and walks none of the ladder.
   */
  it.each(['CANCELLED', 'VOIDED'] as const)('puts %s beside the ladder, not on it', (status) => {
    const progress = buildCheckProgress(status)
    expect(progress.stopped).toBe(status)
    expect(progress.current).toBeNull()
    expect(progress.steps.every((s) => s.state === 'UPCOMING')).toBe(true)
  })

  it('says a live check has not stopped', () => {
    expect(buildCheckProgress('READY_FOR_RELEASE').stopped).toBeNull()
  })

  /**
   * A status arrives here as a stored string — the same reason
   * `statusPillClass` takes one. An unreadable one draws an unwalked ladder,
   * never a confident wrong position.
   */
  it('renders an unrecognised status as no position at all rather than guessing one', () => {
    const progress = buildCheckProgress('NOT_A_STATUS')
    expect(progress.current).toBeNull()
    expect(progress.stopped).toBeNull()
    expect(progress.steps.every((s) => s.state === 'UPCOMING')).toBe(true)
  })
})
