import { describe, it, expect } from 'vitest'
import { bindingError, needleToParams, paramsToNeedle, type Binding } from '@/lib/table-kit/url-binding'
import { parseColumnFilters } from '@/lib/column-filters'

const text: Binding = { kind: 'text', param: 'f.payee' }
const enm: Binding = { kind: 'enum', param: 'company' }
const day: Binding = { kind: 'range', from: 'f.checkDateFrom', to: 'f.checkDateTo', unit: 'day' }
const amt: Binding = { kind: 'range', from: 'f.amountMin', to: 'f.amountMax', unit: 'amount' }

describe('needleToParams', () => {
  it('text and enum write one parameter, blank removes it', () => {
    expect(needleToParams(text, ' acme ')).toEqual({ 'f.payee': 'acme' })
    expect(needleToParams(text, '')).toEqual({ 'f.payee': '' })
    expect(needleToParams(enm, '=ck123')).toEqual({ company: 'ck123' })
  })

  it('maps each day operator onto inclusive From/To', () => {
    expect(needleToParams(day, '~eq:2026-10-05')).toEqual({ 'f.checkDateFrom': '2026-10-05', 'f.checkDateTo': '2026-10-05' })
    expect(needleToParams(day, '~ge:2026-10-05')).toEqual({ 'f.checkDateFrom': '2026-10-05', 'f.checkDateTo': '' })
    expect(needleToParams(day, '~le:2026-10-05')).toEqual({ 'f.checkDateFrom': '', 'f.checkDateTo': '2026-10-05' })
    expect(needleToParams(day, '~gt:2026-10-31')).toEqual({ 'f.checkDateFrom': '2026-11-01', 'f.checkDateTo': '' })
    expect(needleToParams(day, '~lt:2026-03-01')).toEqual({ 'f.checkDateFrom': '', 'f.checkDateTo': '2026-02-28' })
    expect(needleToParams(day, '~between:2026-10-01:2026-10-13')).toEqual({ 'f.checkDateFrom': '2026-10-01', 'f.checkDateTo': '2026-10-13' })
    expect(needleToParams(day, '')).toEqual({ 'f.checkDateFrom': '', 'f.checkDateTo': '' })
  })

  it('maps amount operators onto Min/Max and passes the typed text through for the server to judge', () => {
    expect(needleToParams(amt, '~eq:1,250.50')).toEqual({ 'f.amountMin': '1,250.50', 'f.amountMax': '1,250.50' })
    expect(needleToParams(amt, '~between:100:12x')).toEqual({ 'f.amountMin': '100', 'f.amountMax': '12x' })
  })

  it('passes an unreadable day under gt through untouched, without throwing', () => {
    expect(needleToParams(day, '~gt:abc')).toEqual({ 'f.checkDateFrom': 'abc', 'f.checkDateTo': '' })
  })

  it('passes an impossible day under lt through untouched rather than rolling it to another day', () => {
    expect(needleToParams(day, '~lt:2026-02-30')).toEqual({ 'f.checkDateFrom': '', 'f.checkDateTo': '2026-02-30' })
  })

  // Review follow-up: these used to clear both parameters, i.e. widen the list
  // to every check while the chip said a filter was set.
  it('refuses, never widens, a needle the parameters cannot express', () => {
    const refused = [
      [day, '~ne:2026-10-05'],
      [amt, '~ne:100'],
      [amt, '~gt:100'],
      [amt, '~lt:100'],
      [day, '~ge:'],
      [amt, '~eq::5'],
      [day, '~ge:2026-10-01:2026-10-13'],
      [day, 'oct'],
    ] as const
    for (const [b, n] of refused) {
      const params = needleToParams(b, n)
      expect(params[b.kind === 'range' ? b.from : '']).toBe(n)
      const parsed = parseColumnFilters((name) => params[name], { statusApplies: false })
      expect(Object.keys(parsed.errors), n).not.toHaveLength(0)
    }
  })
})

describe('paramsToNeedle', () => {
  it('reads From/To back as the operator that produced them', () => {
    expect(paramsToNeedle(day, { 'f.checkDateFrom': '2026-10-05', 'f.checkDateTo': '2026-10-05' })).toBe('~eq:2026-10-05')
    expect(paramsToNeedle(day, { 'f.checkDateFrom': '2026-10-05' })).toBe('~ge:2026-10-05')
    expect(paramsToNeedle(day, { 'f.checkDateTo': '2026-10-05' })).toBe('~le:2026-10-05')
    expect(paramsToNeedle(day, { 'f.checkDateFrom': '2026-10-01', 'f.checkDateTo': '2026-10-13' })).toBe('~between:2026-10-01:2026-10-13')
    expect(paramsToNeedle(day, {})).toBe('')
    expect(paramsToNeedle(text, { 'f.payee': 'acme' })).toBe('acme')
    expect(paramsToNeedle(enm, { company: 'ck123' })).toBe('=ck123')
  })

  it('round-trips', () => {
    for (const n of ['~eq:2026-10-05', '~ge:2026-10-05', '~le:2026-10-05', '~between:2026-10-01:2026-10-13']) {
      expect(paramsToNeedle(day, needleToParams(day, n))).toBe(n)
    }
  })

  it('names the server refusal of either parameter', () => {
    expect(bindingError(amt, { 'f.amountMax': 'NOT AN AMOUNT' })).toBe('NOT AN AMOUNT')
    expect(bindingError(text, { 'f.amountMax': 'NOT AN AMOUNT' })).toBeUndefined()
  })
})
