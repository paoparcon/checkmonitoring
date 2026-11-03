import { describe, it, expect } from 'vitest'
import { syncFailureNotices, staleNotices, parkedNotice, readyNotice, safeLink } from '@/lib/notifications/messages'
import type { AutoSignRun } from '@/lib/sync/auto-sign'

const okSign: AutoSignRun = { outcome: 'OK', signed: 0, skipped: 0, enabled: true }

describe('syncFailureNotices', () => {
  it('sends nothing when every read ran or was skipped for a reason that is not a failure', () => {
    expect(syncFailureNotices({
      outcomes: [
        { tenant: 'GOLIVE', outcome: 'RAN' } as never,
        { tenant: 'MANUFACTURING', outcome: 'IN_PROGRESS', message: 'busy' },
      ],
      bills: [{ tenant: 'MANUFACTURING', outcome: 'SKIPPED_PAYMENT_NOT_RUN' }],
      billRefs: [{ tenant: 'GOLIVE', outcome: 'SKIPPED_TIME_BUDGET', syncRunId: null }],
      autoSign: { ...okSign, outcome: 'IDLE' },
    })).toEqual([])
  })

  it('names the tenant and the read for each failure or refusal, to admins, linking /admin/sync', () => {
    const notices = syncFailureNotices({
      outcomes: [
        { tenant: 'GOLIVE', outcome: 'FAILED', message: 'socket hang up' },
        { tenant: 'MANUFACTURING', outcome: 'REFUSED_NO_WATERMARK', syncRunId: 'r1' },
      ],
      bills: [{ tenant: 'GOLIVE', outcome: 'FAILED', message: 'bills down' }],
      billRefs: [{ tenant: 'GOLIVE', outcome: 'REFUSED_NO_WATERMARK', syncRunId: 'r2' }],
      autoSign: { ...okSign, outcome: 'FAILED', error: 'time budget reached' },
    })
    expect(notices.map((n) => [n.kind, n.audience, n.link])).toEqual([
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['SYNC_FAILED', 'ADMINS', '/admin/sync'],
      ['AUTO_SIGN_FAILED', 'ADMINS', '/admin/sync'],
    ])
    expect(notices.map((n) => n.message)).toEqual([
      'Scheduled Acumatica payment read failed for GOLIVE: socket hang up',
      'Scheduled Acumatica payment read refused for MANUFACTURING: no watermark. A first read must be run from a terminal.',
      'Scheduled Acumatica voucher read (BILLS) failed for GOLIVE: bills down',
      'Scheduled Acumatica PO number read (BILL_REFS) refused for GOLIVE: no watermark. A first read must be run from a terminal.',
      'Auto-sign failed: time budget reached',
    ])
    expect(notices.every((n) => n.dedupeKey === undefined)).toBe(true)
  })
})

describe('staleNotices', () => {
  it('one notice per stale tenant, deduplicated on its last read', () => {
    const last = new Date('2026-10-14T04:00:00Z')
    const notices = staleNotices({
      tenants: [
        { tenant: 'GOLIVE', lastReadAt: last, hoursAgo: 40, stale: true },
        { tenant: 'MANUFACTURING', lastReadAt: null, hoursAgo: null, stale: true },
        { tenant: 'OTHER', lastReadAt: new Date(), hoursAgo: 1, stale: false },
      ],
      warn: true,
      oldestHours: 40,
    })
    expect(notices).toEqual([
      { kind: 'SYNC_STALE', audience: 'ADMINS', link: '/admin/sync', dedupeKey: `stale:GOLIVE:${last.toISOString()}`,
        message: 'No successful Acumatica read for GOLIVE in 40 hours.' },
      { kind: 'SYNC_STALE', audience: 'ADMINS', link: '/admin/sync', dedupeKey: 'stale:MANUFACTURING:never',
        message: 'Acumatica has never been read successfully for MANUFACTURING.' },
    ])
  })
})

describe('parkedNotice', () => {
  it('names the event kind, the check and the error, deduplicated on the event', () => {
    expect(parkedNotice({ eventId: 'e1', kind: 'MARK_AVAILABLE', checkId: 'c1', checkNumber: '6000354012', error: 'portal rejected the payload (400)' }))
      .toEqual({
        kind: 'PORTAL_PARKED', audience: 'ADMINS', link: '/admin/portal', dedupeKey: 'parked:e1', checkId: 'c1',
        message: 'Portal event MARK_AVAILABLE for check 6000354012 parked: portal rejected the payload (400)',
      })
  })

  it('says so when the check is gone, and carries no checkId', () => {
    const n = parkedNotice({ eventId: 'e2', kind: 'RELEASED', checkId: null, checkNumber: null, error: 'check no longer exists' })
    expect(n.message).toBe('Portal event RELEASED for a check no longer held parked: check no longer exists')
    expect(n.checkId).toBeUndefined()
  })
})

describe('readyNotice', () => {
  it('is null when nothing moved', () => {
    expect(readyNotice({ actorName: 'Ana', checks: [] })).toBeNull()
  })

  it('names the one check and its amount', () => {
    expect(readyNotice({ actorName: 'Ana', checks: [{ checkNumber: '6000354012', amount: '12500.00', currency: 'PHP' }] }))
      .toEqual({
        kind: 'READY_FOR_RELEASE', audience: 'FINANCE', link: '/?status=READY_FOR_RELEASE',
        message: 'Ana marked check 6000354012 READY FOR RELEASE: ₱12,500.00',
      })
  })

  it('counts a batch and totals it per currency without a float', () => {
    const n = readyNotice({ actorName: 'Ana', checks: [
      { checkNumber: '1', amount: '0.10', currency: 'PHP' },
      { checkNumber: '2', amount: '0.20', currency: 'PHP' },
      { checkNumber: '3', amount: '5.00', currency: 'USD' },
    ] })
    expect(n?.message).toBe('Ana marked 3 checks READY FOR RELEASE: ₱0.30, $5.00')
  })
})

describe('safeLink', () => {
  it('keeps an in-app path and refuses anything that could leave the site', () => {
    expect(safeLink('/admin/sync')).toBe('/admin/sync')
    expect(safeLink('/?status=READY_FOR_RELEASE')).toBe('/?status=READY_FOR_RELEASE')
    for (const bad of [null, '', 'https://evil.test', '//evil.test', '/\\evil.test', 'admin/sync']) {
      expect(safeLink(bad)).toBeNull()
    }
  })
})
