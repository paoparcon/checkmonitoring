import { describe, it, expect } from 'vitest'
import { markable, markingCards, paymentColumns, paymentValue } from '@/lib/payments-view'
import { paymentRow } from './helpers/payment-row'

describe('markingCards', () => {
  const rows = [
    paymentRow({ id: 'a', amount: '1000.10' }),
    paymentRow({ id: 'b', amount: '2000.20', currency: 'CNY' }),
    paymentRow({ id: 'c', amount: '0.05', marking: 'PROCESSED', display: 'PROCESSED' }),
    paymentRow({ id: 'd', amount: '999.00', voided: true, display: 'CANCELLED' }),
    paymentRow({ id: 'e', amount: null }),
  ]
  it('totals per currency, never mixed, and counts a payment with no amount', () => {
    const { cards } = markingCards(rows)
    const onProcess = cards.find((c) => c.label === 'ON PROCESS')!
    expect(onProcess.count).toBe(3)
    expect(onProcess.totals).toEqual([{ currency: 'CNY', total: '2,000.20', count: 1 }, { currency: 'USD', total: '1,000.10', count: 1 }])
    expect(cards.map((c) => c.label)).toEqual(['ON PROCESS', 'PROCESSED', 'CLEARED', 'CANCELLED'])
  })
  it('counts CANCELLED in ALL and leaves it out of ALL\'s amounts', () => {
    const { all } = markingCards(rows)
    expect(all.count).toBe(5)
    expect(all.totals.find((t) => t.currency === 'USD')!.total).toBe('1,000.15')
  })
})

describe('paymentValue and columns', () => {
  it('filters MARKING on what the reader sees', () => {
    expect(paymentValue(paymentRow({ voided: true, display: 'CANCELLED', marking: 'CLEARED' }), 'marking')).toBe('CANCELLED')
    expect(paymentValue(paymentRow({ company: null }), 'company')).toBe('ST')
    expect(paymentValue(paymentRow(), 'remarks')).toBeNull()
  })
  it('has no comma in a multi column option', () => {
    for (const c of paymentColumns([paymentRow()]).filter((x) => x.multi)) {
      for (const o of c.options ?? []) expect(o.value).not.toContain(',')
    }
  })
})

describe('markable', () => {
  it('submits only ticked payments still on the page and not voided', () => {
    const rows = [paymentRow({ id: 'a' }), paymentRow({ id: 'b', voided: true }), paymentRow({ id: 'c' })]
    expect(markable(rows, new Set(['a', 'b', 'gone'])).map((r) => r.id)).toEqual(['a'])
  })
})
