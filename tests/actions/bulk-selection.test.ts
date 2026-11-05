import { describe, it, expect } from 'vitest'
import { parseSelection } from '@/lib/bulk'

describe('parseSelection', () => {
  it('keeps the ticked ids in the order they were submitted', () => {
    expect(parseSelection(['a', 'b', 'c'])).toEqual({ ok: true, checkIds: ['a', 'b', 'c'] })
  })

  it('drops blanks and whitespace-only entries', () => {
    expect(parseSelection(['a', '', '   ', 'b'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('trims each id', () => {
    expect(parseSelection([' a ', 'b'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('de-duplicates, so one check is never acted on twice in a batch', () => {
    expect(parseSelection(['a', 'b', 'a'])).toEqual({ ok: true, checkIds: ['a', 'b'] })
  })

  it('refuses an empty selection', () => {
    expect(parseSelection([])).toEqual({
      ok: false,
      message: 'Select at least one check first.',
    })
  })

  it('refuses a selection of nothing but blanks', () => {
    expect(parseSelection(['', '  '])).toEqual({
      ok: false,
      message: 'Select at least one check first.',
    })
  })

  // User ruling 2026-11-05: "dont limit 50 tick at a time. i can select all".
  it('accepts any number of checks — there is no cap', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => `id-${i}`)
    expect(parseSelection(many)).toEqual({ ok: true, checkIds: many })
  })

  it('de-duplicates a large selection too', () => {
    const many = Array.from({ length: 300 }, (_, i) => `id-${i}`)
    expect(parseSelection([...many, 'id-0', 'id-1'])).toEqual({ ok: true, checkIds: many })
  })
})
