// tests/integrations/portal-client.test.ts
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { buildPortalEventBody, createPortalClient, manilaDay, PortalPayloadError, type CheckForPortal } from '@/lib/integrations/portal/client'

const bank = { bank: { code: 'BPI' } }
const check = (over: Partial<CheckForPortal> = {}): CheckForPortal => ({
  id: 'chk1', checkNumber: '6000353106', apvNumbers: ['AP-1001', 'AP-1002'], eligibility: 'SUPPLIER',
  availablePickupDate: new Date('2026-09-30T00:00:00Z'), releasedAt: null, orNumber: null, orDate: null, releasedBy: null,
  receiptType: null, receiptAmount: null, receiptFile: null,
  cashAccount: bank, checkBook: null,
  bills: [{ apvNumber: 'AP-1001', poNumber: 'PO-77' }, { apvNumber: 'AP-1002', poNumber: null }],
  ...over,
})

describe('manilaDay', () => {
  it('renders the Manila calendar day', () => {
    expect(manilaDay(new Date('2026-09-30T20:00:00Z'))).toBe('2026-10-01')
    expect(manilaDay(new Date('2026-09-30T00:00:00Z'))).toBe('2026-09-30')
  })
})

describe('buildPortalEventBody', () => {
  it('MARK_AVAILABLE carries apvs, positional PO numbers, check number, bank and the pickup date', () => {
    expect(buildPortalEventBody({ id: 'ev1', kind: 'MARK_AVAILABLE' }, check())).toEqual({
      eventId: 'ev1', kind: 'MARK_AVAILABLE', apvs: ['AP-1001', 'AP-1002'], poNumbers: ['PO-77', ''],
      checkNo: '6000353106', bank: 'BPI', availablePickupDate: '2026-09-30',
    })
  })

  it('RELEASED carries the release day and receipt from the check as it stands', () => {
    const body = buildPortalEventBody({ id: 'ev2', kind: 'RELEASED' }, check({
      releasedAt: new Date('2026-10-02T02:00:00Z'), orNumber: 'OR-9', orDate: new Date('2026-10-02T00:00:00Z'),
    }))
    expect(body).toMatchObject({ kind: 'RELEASED', releaseDate: '2026-10-02', orNumber: 'OR-9', orDate: '2026-10-02' })
    expect(body).not.toHaveProperty('availablePickupDate')
  })

  it('RELEASE_REVERSED carries the pickup date; REVERT and CANCELLED carry no dates', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check())).toMatchObject({ availablePickupDate: '2026-09-30' })
    for (const kind of ['REVERT', 'CANCELLED'] as const) {
      const b = buildPortalEventBody({ id: 'e', kind }, check())
      expect(b).not.toHaveProperty('availablePickupDate'); expect(b).not.toHaveProperty('releaseDate')
    }
  })

  it('takes the bank from the check book when there is no cash account, and blank when neither', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null, checkBook: { bank: { code: 'MBTC' } } })).bank).toBe('MBTC')
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ cashAccount: null })).bank).toBe('')
  })

  it('falls back to the bills for APVs when apvNumbers is empty', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ apvNumbers: [] })).apvs).toEqual(['AP-1001', 'AP-1002'])
  })

  it('refuses an INTERNAL check for every kind that would tell a payee something', () => {
    for (const kind of ['MARK_AVAILABLE', 'REVERT', 'RECEIPT'] as const) {
      expect(() => buildPortalEventBody({ id: 'e', kind }, check({ eligibility: 'INTERNAL' }))).toThrow(PortalPayloadError)
    }
  })

  // spec 2026-10-19 (Supplier Portal docs/superpowers/specs/2026-10-19-cm-internal-release-quiet-design.md)
  it('sends RELEASED, RELEASE_REVERSED and CANCELLED for an INTERNAL check, flagged internal', () => {
    const internal = check({ eligibility: 'INTERNAL', releasedAt: new Date('2026-10-05T02:00:00Z') })
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, internal)).toMatchObject({ kind: 'RELEASED', internal: true, releaseDate: '2026-10-05' })
    expect(buildPortalEventBody({ id: 'e', kind: 'CANCELLED' }, internal)).toMatchObject({ kind: 'CANCELLED', internal: true })
    const reversed = buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check({ eligibility: 'INTERNAL', availablePickupDate: null }))
    expect(reversed).toMatchObject({ kind: 'RELEASE_REVERSED', internal: true })
    expect(reversed).not.toHaveProperty('availablePickupDate')
  })

  it('never flags a SUPPLIER check internal', () => {
    expect(buildPortalEventBody({ id: 'e', kind: 'CANCELLED' }, check())).not.toHaveProperty('internal')
  })

  it('MARK_AVAILABLE with no availablePickupDate throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'MARK_AVAILABLE' }, check({ availablePickupDate: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  // User report 2026-10-06: a cheque the register catch-up released has no
  // releasedAt by design (lib/admin/register-releases.ts); the register's
  // stated day is the release day the portal is told.
  it('RELEASED with no releasedAt sends the register stated release date', () => {
    const body = buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, check({
      releasedAt: null, statedReleaseDate: new Date('2026-09-23T00:00:00Z'),
    }))
    expect(body.releaseDate).toBe('2026-09-23')
  })

  it('RELEASED with neither releasedAt nor statedReleaseDate throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, check({ releasedAt: null, statedReleaseDate: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  it('RELEASE_REVERSED with no availablePickupDate throws PortalPayloadError MISSING_DATE', () => {
    try {
      buildPortalEventBody({ id: 'e', kind: 'RELEASE_REVERSED' }, check({ availablePickupDate: null }))
      expect.fail('expected buildPortalEventBody to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('MISSING_DATE')
    }
  })

  it('pre-checks the portal validation: no APVs, more than 50, or no check number and no bank → INVALID_PAYLOAD', () => {
    const code = (c: CheckForPortal) => {
      try { buildPortalEventBody({ id: 'e', kind: 'REVERT' }, c); return null } catch (err) {
        expect(err).toBeInstanceOf(PortalPayloadError)
        return (err as PortalPayloadError).code
      }
    }
    expect(code(check({ apvNumbers: [], bills: [] }))).toBe('INVALID_PAYLOAD')
    const many = Array.from({ length: 51 }, (_, i) => `AP-${i}`)
    expect(code(check({ apvNumbers: many }))).toBe('INVALID_PAYLOAD')
    expect(code(check({ apvNumbers: many.slice(0, 50) }))).toBeNull()
    expect(code(check({ checkNumber: ' ', cashAccount: null }))).toBe('INVALID_PAYLOAD')
    // Either one alone is enough for the portal's "checkNo · BANK" label.
    expect(code(check({ checkNumber: '', cashAccount: bank }))).toBeNull()
    expect(code(check({ cashAccount: null }))).toBeNull()
  })

  it('REVERT and CANCELLED do not throw when both dates are null', () => {
    for (const kind of ['REVERT', 'CANCELLED'] as const) {
      expect(() => buildPortalEventBody({ id: 'e', kind }, check({ availablePickupDate: null, releasedAt: null }))).not.toThrow()
    }
  })

  it('RECEIPT carries type, number, date, amount string, base64 file and releaser', () => {
    const body = buildPortalEventBody({ id: 'r1', kind: 'RECEIPT' }, check({
      releasedAt: new Date('2026-10-02T02:00:00Z'), orNumber: 'OR-9', orDate: new Date('2026-10-02T00:00:00Z'),
      receiptType: 'OR', receiptAmount: new Prisma.Decimal('1000.5'), releasedBy: { name: 'Ana Cruz' },
      receiptFile: { fileName: 'or.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') },
    }))
    expect(body).toMatchObject({ kind: 'RECEIPT', receiptType: 'OR', orNumber: 'OR-9', orDate: '2026-10-02', amount: '1000.50', releasedBy: 'Ana Cruz',
      file: { name: 'or.pdf', contentType: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') } })
  })
  it('RECEIPT without a reference or type is a payload defect', () => {
    expect(() => buildPortalEventBody({ id: 'r', kind: 'RECEIPT' }, check({ orNumber: null })))
      .toThrow(PortalPayloadError)
    // A reference without its type is just as unusable (review 2026-10-02).
    expect(() => buildPortalEventBody({ id: 'r', kind: 'RECEIPT' }, check({ orNumber: 'OR-1', receiptType: null })))
      .toThrow(PortalPayloadError)
  })
  it('RECEIPT with a blank check number is a payload defect (the portal requires checkNo; review 2026-10-02)', () => {
    try {
      buildPortalEventBody({ id: 'r', kind: 'RECEIPT' }, check({ checkNumber: '  ', orNumber: 'OR-1', receiptType: 'OR' }))
      expect.fail('expected a payload defect')
    } catch (err) {
      expect(err).toBeInstanceOf(PortalPayloadError)
      expect((err as PortalPayloadError).code).toBe('INVALID_PAYLOAD')
    }
  })
})

describe('createPortalClient', () => {
  it('POSTs JSON with the bearer to the events route and parses the reply', async () => {
    const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = []
    const client = createPortalClient({
      baseUrl: 'https://portal.test/', token: 'tok',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return { ok: true, status: 200, text: async () => JSON.stringify({ eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] }) }
      },
    })
    const out = await client.deliver(buildPortalEventBody({ id: 'ev1', kind: 'REVERT' }, check()))
    expect(calls[0].url).toBe('https://portal.test/api/integrations/check-monitoring/events')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers.authorization).toBe('Bearer tok')
    expect(JSON.parse(calls[0].init.body).eventId).toBe('ev1')
    expect(out).toEqual({ status: 200, body: { eventId: 'ev1', replay: false, results: [], unmatched: ['AP-1001'] } })
  })

  it('returns the status with a null body when the reply is not JSON', async () => {
    const client = createPortalClient({ baseUrl: 'https://portal.test', token: 'tok',
      fetchImpl: async () => ({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' }) })
    expect(await client.deliver(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check()))).toEqual({ status: 502, body: null })
  })

  it('keeps the portal error text on a 400', async () => {
    const client = createPortalClient({ baseUrl: 'https://portal.test', token: 'tok',
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'apvs must be a non-empty array' }) }) })
    expect(await client.deliver(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check())))
      .toEqual({ status: 400, body: null, error: 'apvs must be a non-empty array' })
  })

  it('passes an abort signal when a timeout is given, and rejects when the request aborts', async () => {
    const seen: { signal?: AbortSignal } = {}
    const client = createPortalClient({ baseUrl: 'https://portal.test', token: 'tok',
      fetchImpl: async (_url, init) => {
        seen.signal = init.signal
        throw new DOMException('This operation was aborted', 'AbortError')
      } })
    await expect(client.deliver(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check()), { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(seen.signal).toBeInstanceOf(AbortSignal)
    expect(seen.signal?.aborted).toBe(false)
  })

  it('RELEASED carries the releaser name when known, omits it otherwise', () => {
    const released = { releasedAt: new Date('2026-10-02T02:00:00Z') }
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, check({ ...released, releasedBy: { name: 'Ana Cruz' } })))
      .toMatchObject({ releasedBy: 'Ana Cruz' })
    expect(buildPortalEventBody({ id: 'e', kind: 'RELEASED' }, check(released))).not.toHaveProperty('releasedBy')
    expect(buildPortalEventBody({ id: 'e', kind: 'REVERT' }, check({ releasedBy: { name: 'Ana Cruz' } }))).not.toHaveProperty('releasedBy')
  })
})
