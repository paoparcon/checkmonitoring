import { describe, it, expect } from 'vitest'
import {
  DISPLAY_MARKINGS, checkMarkingRequest, displayMarking, isMarking, planMarking, type MarkingState,
} from '@/lib/payments/marking'

const TODAY = '2026-11-20'
const state = (o: Partial<MarkingState> = {}): MarkingState => ({
  marking: 'ON_PROCESS', voided: false, processedDate: null, clearedDate: null, bankReference: null, remarks: null, ...o,
})
const req = (o: Partial<{ marking: 'ON_PROCESS' | 'PROCESSED' | 'CLEARED'; date: string; bankReference: string; remarks: string }> = {}) => ({
  marking: 'PROCESSED' as const, date: '', bankReference: '', remarks: '', ...o,
})

describe('displayMarking', () => {
  it('reads CANCELLED for a voided payment whatever its marking', () => {
    expect(displayMarking({ marking: 'CLEARED', voided: true })).toBe('CANCELLED')
    expect(displayMarking({ marking: 'ON_PROCESS', voided: false })).toBe('ON PROCESS')
    expect([...DISPLAY_MARKINGS]).toEqual(['ON PROCESS', 'PROCESSED', 'CLEARED', 'CANCELLED'])
  })
  it('knows a marking from a display word', () => {
    expect(isMarking('PROCESSED')).toBe(true)
    expect(isMarking('CANCELLED')).toBe(false)
  })
})

describe('checkMarkingRequest', () => {
  it('accepts PROCESSED with or without a day', () => {
    expect(checkMarkingRequest({ marking: 'PROCESSED', date: '' }, TODAY).ok).toBe(true)
    expect(checkMarkingRequest({ marking: 'PROCESSED', date: TODAY }, TODAY).ok).toBe(true)
  })
  it.each([
    ['an unknown marking', { marking: 'CANCELLED', date: '' }, 'UNKNOWN_MARKING'],
    ['a malformed day', { marking: 'PROCESSED', date: '20/11/2026' }, 'INVALID_DATE'],
    ['a day that does not exist', { marking: 'PROCESSED', date: '2026-02-30' }, 'INVALID_DATE'],
    ['a future day', { marking: 'PROCESSED', date: '2026-11-21' }, 'FUTURE_DATE'],
    ['CLEARED with no day', { marking: 'CLEARED', date: '' }, 'CLEARED_DATE_REQUIRED'],
    ['a day on ON PROCESS', { marking: 'ON_PROCESS', date: TODAY }, 'DATE_NOT_USED'],
  ])('refuses %s', (_n, r, code) => {
    const v = checkMarkingRequest(r, TODAY)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe(code)
  })
})

describe('planMarking', () => {
  it('moves forward and records the day against its own stage', () => {
    const v = planMarking(state(), req({ date: '2026-11-18', bankReference: ' SWIFT-1 ' }))
    expect(v).toEqual({ ok: true, change: { marking: 'PROCESSED', processedDate: '2026-11-18', clearedDate: null, bankReference: 'SWIFT-1', remarks: null } })
  })

  it('CLEARED keeps the processed day already on record', () => {
    const v = planMarking(state({ marking: 'PROCESSED', processedDate: '2026-11-10' }), req({ marking: 'CLEARED', date: '2026-11-19' }))
    expect(v.ok && v.change).toMatchObject({ marking: 'CLEARED', processedDate: '2026-11-10', clearedDate: '2026-11-19' })
  })

  it('allows ON PROCESS straight to CLEARED', () => {
    const v = planMarking(state(), req({ marking: 'CLEARED', date: '2026-11-19' }))
    expect(v.ok && v.change).toMatchObject({ marking: 'CLEARED', processedDate: null, clearedDate: '2026-11-19' })
  })

  it('refuses a move back without a remark, and drops the later stage dates with one', () => {
    const from = state({ marking: 'CLEARED', processedDate: '2026-11-10', clearedDate: '2026-11-12', bankReference: 'REF' })
    const refused = planMarking(from, req({ marking: 'PROCESSED' }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.code).toBe('REMARKS_REQUIRED')
    const back = planMarking(from, req({ marking: 'PROCESSED', remarks: 'bank reversed the debit' }))
    expect(back.ok && back.change).toEqual({ marking: 'PROCESSED', processedDate: '2026-11-10', clearedDate: null, bankReference: 'REF', remarks: 'bank reversed the debit' })
    const toStart = planMarking(from, req({ marking: 'ON_PROCESS', remarks: 'never sent' }))
    expect(toStart.ok && toStart.change).toMatchObject({ marking: 'ON_PROCESS', processedDate: null, clearedDate: null })
  })

  it('never wipes a reference or remark with a blank box', () => {
    const v = planMarking(state({ marking: 'PROCESSED', bankReference: 'REF', remarks: 'note' }), req({ marking: 'CLEARED', date: '2026-11-19' }))
    expect(v.ok && v.change).toMatchObject({ bankReference: 'REF', remarks: 'note' })
  })

  it('reports no change when nothing would be written', () => {
    expect(planMarking(state({ marking: 'PROCESSED', processedDate: '2026-11-10' }), req())).toEqual({ ok: true, change: null })
  })

  it('refuses a payment Acumatica voided', () => {
    const v = planMarking(state({ voided: true }), req())
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.code).toBe('VOIDED_IN_ACUMATICA')
  })
})
