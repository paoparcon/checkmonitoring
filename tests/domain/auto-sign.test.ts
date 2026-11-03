import { describe, it, expect } from 'vitest'
import { autoSignRunDay, isDueForAutoSign, signingCutoff, type AutoSignFacts } from '@/lib/domain/auto-sign'

// Monday 12 Oct 2026 and Tuesday 13 Oct 2026, Manila (UTC+8).
const mondayStart = new Date('2026-10-11T16:00:00Z')   // Mon 00:00 Manila
const mondayNoon = new Date('2026-10-12T04:00:00Z')    // Mon 12:00 Manila
const tuesdayStart = new Date('2026-10-12T16:00:00Z')  // Tue 00:00 Manila
const tuesdayNoon = new Date('2026-10-13T04:00:00Z')   // Tue 12:00 Manila
const wednesdayStart = new Date('2026-10-13T16:00:00Z') // Wed 00:00 Manila

const pending = (o: Partial<AutoSignFacts> = {}): AutoSignFacts => ({
  status: 'SIGNATURE_PENDING', acumaticaPaymentId: 'BPI-000123', isCheque: true,
  acumaticaStatus: 'Balanced', createdAt: new Date('2026-10-08T02:00:00Z'), reverted: false, ...o,
})

describe('autoSignRunDay', () => {
  it('is the Manila calendar day, not UTC', () => {
    expect(autoSignRunDay(new Date(mondayStart.getTime() - 1))).toBeNull()   // Sun 23:59:59.999 Manila
    expect(autoSignRunDay(mondayStart)).toBe('MONDAY')                       // Mon 00:00 Manila = Sun 16:00 UTC
    expect(autoSignRunDay(mondayNoon)).toBe('MONDAY')
    expect(autoSignRunDay(new Date(tuesdayStart.getTime() - 1))).toBe('MONDAY')
    expect(autoSignRunDay(tuesdayStart)).toBe('TUESDAY')
    expect(autoSignRunDay(new Date(wednesdayStart.getTime() - 1))).toBe('TUESDAY')
    expect(autoSignRunDay(wednesdayStart)).toBeNull()
  })

  it('is null Wednesday to Sunday', () => {
    for (const iso of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z', '2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z']) {
      expect(autoSignRunDay(new Date(iso)), iso).toBeNull()
    }
  })
})

describe('signingCutoff', () => {
  it('is 00:00 Manila on now’s day', () => {
    expect(signingCutoff(mondayNoon)).toEqual(mondayStart)
    expect(signingCutoff(mondayStart)).toEqual(mondayStart)
    expect(signingCutoff(tuesdayNoon)).toEqual(tuesdayStart)
    expect(signingCutoff(new Date(wednesdayStart.getTime() - 1))).toEqual(tuesdayStart)
  })
})

describe('isDueForAutoSign', () => {
  it('Monday’s run signs a check first read up to Sunday 23:59:59.999 Manila, not Monday’s own', () => {
    expect(isDueForAutoSign(pending({ createdAt: new Date(mondayStart.getTime() - 1) }), mondayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), mondayNoon, true)).toBe(false)
  })

  it('Tuesday’s run signs a check first read up to Monday 23:59:59.999 Manila, not Tuesday’s own', () => {
    expect(isDueForAutoSign(pending({ createdAt: mondayStart }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: new Date(tuesdayStart.getTime() - 1) }), tuesdayNoon, true)).toBe(true)
    expect(isDueForAutoSign(pending({ createdAt: tuesdayStart }), tuesdayNoon, true)).toBe(false)
  })

  it('signs the old backlog on both days', () => {
    const backlog = pending({ createdAt: new Date('2026-09-29T02:00:00Z') })
    expect(isDueForAutoSign(backlog, mondayNoon, true)).toBe(true)
    expect(isDueForAutoSign(backlog, tuesdayNoon, true)).toBe(true)
  })

  it('signs nothing Wednesday to Sunday', () => {
    for (const iso of ['2026-10-14T04:00:00Z', '2026-10-15T04:00:00Z', '2026-10-16T04:00:00Z', '2026-10-17T04:00:00Z', '2026-10-18T04:00:00Z']) {
      expect(isDueForAutoSign(pending(), new Date(iso), true), iso).toBe(false)
    }
  })

  it('signs nothing when switched off', () => {
    expect(isDueForAutoSign(pending(), mondayNoon, false)).toBe(false)
  })

  it('never re-signs a check someone reverted', () => {
    expect(isDueForAutoSign(pending({ reverted: true }), mondayNoon, true)).toBe(false)
  })

  it('accepts a null Acumatica status', () => {
    expect(isDueForAutoSign(pending({ acumaticaStatus: null }), mondayNoon, true)).toBe(true)
  })

  it('refuses other statuses, register-only, non-checks and Voided', () => {
    for (const status of ['GENERATED', 'SIGNED', 'READY_FOR_RELEASE', 'RELEASED', 'CANCELLED', 'VOIDED']) {
      expect(isDueForAutoSign(pending({ status }), mondayNoon, true), status).toBe(false)
    }
    expect(isDueForAutoSign(pending({ acumaticaPaymentId: null }), mondayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ isCheque: false }), mondayNoon, true)).toBe(false)
    expect(isDueForAutoSign(pending({ acumaticaStatus: 'Voided' }), mondayNoon, true)).toBe(false)
  })
})
