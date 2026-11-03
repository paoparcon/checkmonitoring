import { isIsoDay } from '@/lib/domain/details'
import { parseRangeNeedle, rangeNeedle, shiftDay } from './match'
import type { RangeOp } from './types'

/**
 * How a column's needle is written into the URL parameters a server page
 * already parses (spec 2026-10-13 §3, §5). Nothing new is invented on the
 * server: a day range is the page's inclusive From/To, an amount range its
 * Min/Max, so the operators offered are only those that map onto them.
 * Typed text passes through untouched — the server's parser decides whether it
 * can be read, and refuses if not.
 */

export type Binding =
  | { kind: 'text'; param: string }
  | { kind: 'enum'; param: string }
  | { kind: 'range'; from: string; to: string; unit: 'day' | 'amount' }

/** "Does Not Equal" has no From/To; strict bounds on amounts have no Min/Max. */
export const SERVER_DAY_OPS: readonly RangeOp[] = ['eq', 'gt', 'ge', 'lt', 'le', 'between']
export const SERVER_AMOUNT_OPS: readonly RangeOp[] = ['eq', 'ge', 'le', 'between']

export function bindingParams(b: Binding): string[] {
  return b.kind === 'range' ? [b.from, b.to] : [b.param]
}

export function needleToParams(b: Binding, needle: string): Record<string, string> {
  const n = needle.trim()
  if (b.kind === 'text') return { [b.param]: n }
  if (b.kind === 'enum') return { [b.param]: n.replace(/^=/, '') }
  if (!n) return { [b.from]: '', [b.to]: '' }
  const r = parseRangeNeedle(n)
  const offered = b.unit === 'day' ? SERVER_DAY_OPS : SERVER_AMOUNT_OPS
  // A needle the parameters cannot express — unreadable, an operator the menu
  // never offers here, or a single-bound operator without exactly one bound —
  // is written whole into From for the server to refuse. Clearing both would
  // widen the list to every check, which reads as a filter applied.
  if (!r || !offered.includes(r.op) || (r.op !== 'between' && (!r.a || r.b))) return { [b.from]: n, [b.to]: '' }
  let from = ''
  let to = ''
  // Only a real ISO day is shifted; anything else passes through for the server to refuse.
  const next = (d: string, by: number) => (b.unit === 'day' && isIsoDay(d) ? shiftDay(d, by) : d)
  switch (r.op) {
    case 'eq': from = r.a; to = r.a; break
    case 'ge': from = r.a; break
    case 'le': to = r.a; break
    case 'gt': from = next(r.a, 1); break
    case 'lt': to = next(r.a, -1); break
    case 'between': from = r.a; to = r.b; break
  }
  return { [b.from]: from, [b.to]: to }
}

export function paramsToNeedle(b: Binding, values: Readonly<Record<string, string>>): string {
  if (b.kind === 'text') return values[b.param]?.trim() ?? ''
  if (b.kind === 'enum') {
    const v = values[b.param]?.trim() ?? ''
    return v ? `=${v}` : ''
  }
  const from = values[b.from]?.trim() ?? ''
  const to = values[b.to]?.trim() ?? ''
  if (from && to) return from === to ? rangeNeedle('eq', from) : rangeNeedle('between', from, to)
  if (from) return rangeNeedle('ge', from)
  if (to) return rangeNeedle('le', to)
  return ''
}

/** The server's refusal of any of this binding's parameters. */
export function bindingError(b: Binding, errors: Readonly<Record<string, string>>): string | undefined {
  return bindingParams(b).map((p) => errors[p]).find(Boolean)
}
