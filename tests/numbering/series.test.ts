import { describe, it, expect } from 'vitest'
import { buildSeries, stagedSeriesNumber, numberShape, strayEnds, PATTERN_MIN_CHEQUES, STRAY_GAP, type SeriesCheque, type SeriesEntry, type SeriesStaged } from '@/lib/numbering/series'

let seq = 0
function c(checkNumber: string, status: SeriesCheque['status'] = 'RELEASED'): SeriesCheque {
  seq += 1
  return { id: `id${String(seq).padStart(4, '0')}`, checkNumber, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP', status, cv: `CV-${checkNumber}` }
}
const shape = (entries: SeriesEntry[]) =>
  entries.map((e) => (e.kind === 'CHECK' ? e.cheque.checkNumber
    : e.kind === 'STAGED' ? `STAGED ${e.number}`
    : `MISSING ${e.from}-${e.to} (${e.count})`))

const st = (statedCheckRef: string, acumaticaRef = `CV-${statedCheckRef}`): SeriesStaged =>
  ({ acumaticaTenant: 'GOLIVE', acumaticaRef, statedCheckRef, checkDate: null, payeeName: null, amount: '1.00', currency: 'PHP' })

describe('buildSeries', () => {
  it('staged rows with the same ref in different tenants both appear, in tenant order', () => {
    const s = buildSeries([c('100'), c('102')], [
      { ...st('101.', 'CV-ST1'), acumaticaTenant: 'MANUFACTURING' },
      { ...st('101.', 'CV-ST1'), acumaticaTenant: 'GOLIVE' },
    ])
    const staged = s.entries.flatMap((e) => (e.kind === 'STAGED' ? [e.staged.acumaticaTenant] : []))
    expect(staged).toEqual(['GOLIVE', 'MANUFACTURING'])
  })

  it('a consecutive run has no MISSING line', () => {
    const s = buildSeries([c('103'), c('101'), c('102')])
    expect(shape(s.entries)).toEqual(['101', '102', '103'])
    expect(s.summary).toMatchObject({ first: '101', last: '103', held: 3, missingNumbers: '0', missingRuns: 0 })
  })

  it('one missing number is one line', () => {
    expect(shape(buildSeries([c('101'), c('103')]).entries)).toEqual(['101', 'MISSING 102-102 (1)', '103'])
  })

  it('a large gap is one line with the exact count, never one row per number', () => {
    const s = buildSeries([c('1791259553'), c('6000354350')])
    expect(shape(s.entries)).toEqual(['1791259553', 'MISSING 1791259554-6000354349 (4209094796)', '6000354350'])
    expect(s.summary.missingNumbers).toBe('4209094796')
    expect(s.summary.missingRuns).toBe(1)
  })

  it('gaps either side of a single check are two lines', () => {
    expect(shape(buildSeries([c('1'), c('5'), c('9')]).entries))
      .toEqual(['1', 'MISSING 2-4 (3)', '5', 'MISSING 6-8 (3)', '9'])
  })

  it('orders numerically, not as text', () => {
    expect(shape(buildSeries([c('1000'), c('999')]).entries)).toEqual(['999', '1000'])
  })

  it('shows both checks on a duplicate number, flagged, counted once as held', () => {
    const s = buildSeries([c('7'), c('7'), c('8')])
    expect(s.entries.filter((e) => e.kind === 'CHECK' && e.duplicate)).toHaveLength(2)
    expect(s.summary).toMatchObject({ held: 2, duplicates: 2, missingNumbers: '0' })
  })

  it('flags 007 and 7 in one account as duplicates, counted once as held', () => {
    const s = buildSeries([c('007'), c('7'), c('8')])
    expect(s.entries.filter((e) => e.kind === 'CHECK' && e.duplicate)).toHaveLength(2)
    expect(s.summary).toMatchObject({ held: 2, duplicates: 2, missingNumbers: '0' })
  })

  it('keeps non-numeric numbers out of the sequence and lists them', () => {
    const s = buildSeries([c('AP-DG001931'), c('5'), c('6')])
    expect(shape(s.entries)).toEqual(['5', '6'])
    expect(s.notNumeric.map((x) => x.checkNumber)).toEqual(['AP-DG001931'])
    expect(s.summary.notNumeric).toBe(1)
  })

  it('counts VOIDED and CANCELLED across every check in the account', () => {
    const s = buildSeries([c('1', 'VOIDED'), c('2', 'CANCELLED'), c('3'), c('X', 'VOIDED')])
    expect(s.summary).toMatchObject({ voided: 2, cancelled: 1 })
  })

  it('keeps a leading-zero width on the MISSING bounds', () => {
    expect(shape(buildSeries([c('0098'), c('0101')]).entries)).toEqual(['0098', 'MISSING 0099-0100 (2)', '0101'])
  })

  it('a single check, and an empty account', () => {
    expect(buildSeries([c('42')]).summary).toMatchObject({ first: '42', last: '42', held: 1, missingRuns: 0 })
    expect(buildSeries([])).toEqual({
      entries: [], notNumeric: [], outOfPattern: [], pattern: null,
      summary: { first: null, last: null, held: 0, voided: 0, cancelled: 0, staged: 0, missingNumbers: '0', missingRuns: 0, notNumeric: 0, duplicates: 0, outOfPattern: 0, noBook: 0 },
    })
  })
})

describe('stagedSeriesNumber', () => {
  it('reads a number that Acumatica re-used with trailing dots', () => {
    expect(stagedSeriesNumber('6000146879.')).toBe('6000146879')
    expect(stagedSeriesNumber('1791361883..')).toBe('1791361883')
    expect(stagedSeriesNumber(' 6000146879. ')).toBe('6000146879')
    expect(stagedSeriesNumber('BPI 6000146879.')).toBe('6000146879')
  })
  it('ignores anything else', () => {
    expect(stagedSeriesNumber('6000146879')).toBeNull()      // no dot: not a re-use
    expect(stagedSeriesNumber('PCF26-00001.')).toBeNull()    // not a number once the dots go
    expect(stagedSeriesNumber('AP-IND000469')).toBeNull()
    expect(stagedSeriesNumber('6000146879.5')).toBeNull()    // a dot inside is not a trailer
    expect(stagedSeriesNumber('.')).toBeNull()
    expect(stagedSeriesNumber(null)).toBeNull()
  })
})

describe('buildSeries with staged re-uses', () => {
  it('a number used only by a staged payment is STAGED, not MISSING', () => {
    const s = buildSeries([c('101'), c('104')], [st('102.')])
    expect(shape(s.entries)).toEqual(['101', 'STAGED 102', 'MISSING 103-103 (1)', '104'])
    expect(s.summary).toMatchObject({ held: 2, staged: 1, missingNumbers: '1', missingRuns: 1 })
  })

  it('a check and its dotted re-use: the check row first, never a duplicate', () => {
    const s = buildSeries([c('7')], [st('7.'), st('7..', 'CV-second')])
    expect(shape(s.entries)).toEqual(['7', 'STAGED 7', 'STAGED 7'])
    expect(s.summary).toMatchObject({ held: 1, staged: 2, duplicates: 0, missingNumbers: '0' })
    expect(s.entries[0]).toMatchObject({ kind: 'CHECK', duplicate: false })
  })

  it('a staged number extends the range', () => {
    const s = buildSeries([c('5')], [st('9.')])
    expect(shape(s.entries)).toEqual(['5', 'MISSING 6-8 (3)', 'STAGED 9'])
    expect(s.summary).toMatchObject({ first: '5', last: '9' })
  })

  it('an account with only staged numbers still has a series', () => {
    const s = buildSeries([], [st('20.'), st('22.')])
    expect(shape(s.entries)).toEqual(['STAGED 20', 'MISSING 21-21 (1)', 'STAGED 22'])
    expect(s.summary).toMatchObject({ first: '20', last: '22', held: 0, staged: 2 })
  })

  it('a staged row that does not qualify is ignored entirely', () => {
    const s = buildSeries([c('1'), c('3')], [st('PCF26-00001.'), st('2')])
    expect(shape(s.entries)).toEqual(['1', 'MISSING 2-2 (1)', '3'])
    expect(s.summary.staged).toBe(0)
  })
})

describe('OUT OF PATTERN (spec §F)', () => {
  const run = (from: number, count: number) => Array.from({ length: count }, (_, i) => c(String(from + i)))
  const sixty = () => run(6000100000, 25)

  it('numberShape strips leading zeros and keeps the first two digits', () => {
    expect(numberShape('0000179241')).toEqual({ digits: 6, lead: '17' })
    expect(numberShape('6000354350')).toEqual({ digits: 10, lead: '60' })
    expect(numberShape('0000')).toEqual({ digits: 0, lead: '' })
  })

  it('below PATTERN_MIN_CHEQUES numeric checks there is no pattern and nothing is out', () => {
    const s = buildSeries([...run(6000100000, PATTERN_MIN_CHEQUES - 2), c('60000')])
    expect(s.pattern).toBeNull()
    expect(s.outOfPattern).toEqual([])
    expect(s.summary.outOfPattern).toBe(0)
    expect(s.summary.first).toBe('60000')
    expect(s.summary.held).toBe(PATTERN_MIN_CHEQUES - 1)
  })

  it('takes a short number and another bank\'s number out of the sequence and the gap count', () => {
    const s = buildSeries([...sixty(), c('60000'), c('1791361374')])
    expect(s.pattern).toEqual({ digits: 10, lead: '60' })
    expect(s.outOfPattern.map((e) => (e.kind === 'CHECK' ? e.cheque.checkNumber : e.kind))).toEqual(['60000', '1791361374'])
    expect(s.summary).toMatchObject({
      outOfPattern: 2, first: '6000100000', last: '6000100024', held: 25, missingNumbers: '0', missingRuns: 0,
    })
    expect(s.entries.some((e) => e.kind === 'MISSING')).toBe(false)
    expect(shape(s.entries).some((x) => x.startsWith('1791') || x === '60000')).toBe(false)
  })

  it('a zero-padded number of the same shape is in pattern and placed by value', () => {
    const s = buildSeries([...run(179200, 25), c('0000179241')])
    expect(s.pattern).toEqual({ digits: 6, lead: '17' })
    expect(s.outOfPattern).toEqual([])
    const texts = shape(s.entries)
    expect(texts.indexOf('0000179241')).toBe(texts.indexOf('179224') + 2)
    expect(texts[texts.indexOf('179224') + 1]).toBe('MISSING 179225-179240 (16)')
  })

  it('a staged line of another shape is out of pattern and not counted as staged', () => {
    const s = buildSeries(sixty(), [st('1791361374.'), st('6000100003.')])
    expect(s.outOfPattern).toHaveLength(1)
    expect(s.outOfPattern[0]).toMatchObject({ kind: 'STAGED', number: '1791361374' })
    expect(s.summary).toMatchObject({ staged: 1, outOfPattern: 1, last: '6000100024' })
  })

  it('an out-of-pattern VOIDED check still counts as voided', () => {
    const s = buildSeries([...sixty(), c('60003162116', 'VOIDED')])
    expect(s.summary).toMatchObject({ voided: 1, outOfPattern: 1, held: 25, last: '6000100024' })
  })

  it('a tie goes to more digits, then the lower lead', () => {
    expect(buildSeries([...run(600010, 12), ...run(6000100000, 12)]).pattern).toEqual({ digits: 10, lead: '60' })
    expect(buildSeries([...run(6000100000, 12), ...run(1791100000, 12)]).pattern).toEqual({ digits: 10, lead: '17' })
  })
})

describe('strayEnds (spec §G3)', () => {
  const run = (from: number, count: number) => Array.from({ length: count }, (_, i) => c(String(from + i)))
  const label = (x: ReturnType<typeof strayEnds>[number]) =>
    `${x.cheque ? x.cheque.checkNumber : `STAGED ${x.staged!.statedCheckRef}`} | ${x.reason}`

  it('STRAY_GAP is 10,000', () => {
    expect(STRAY_GAP.toString()).toBe('10000')
  })

  it('names a first number more than 10,000 below the next, and a last more than 10,000 above the previous', () => {
    const s = buildSeries([c('1719333663'), ...run(1790100000, 5), c('1797334184')])
    expect(strayEnds(s).map(label)).toEqual([
      '1719333663 | STRAY FIRST NUMBER — next is 70766337 higher',
      '1797334184 | STRAY LAST NUMBER — previous is 7234180 lower',
    ])
    expect(strayEnds(s)[0].cheque?.cv).toBe('CV-1719333663')
  })

  it('a gap of exactly 10,000 is not a stray end', () => {
    expect(strayEnds(buildSeries([c('100000'), c('110000'), c('110001')]))).toEqual([])
  })

  it('works inward while it holds, at most 3 from each end', () => {
    const s = buildSeries([c('100'), c('200000'), c('400000'), c('600000'), c('800000'), ...run(1000000, 5)])
    expect(strayEnds(s).map((x) => x.cheque!.checkNumber)).toEqual(['100', '200000', '400000'])
    const t = buildSeries([c('500'), ...run(1000000, 3), c('2000000'), c('3000000')])
    expect(strayEnds(t).map(label)).toEqual([
      '500 | STRAY FIRST NUMBER — next is 999500 higher',
      '3000000 | STRAY LAST NUMBER — previous is 1000000 lower',
      '2000000 | STRAY LAST NUMBER — previous is 999998 lower',
    ])
  })

  it('none when the gaps are small', () => {
    expect(strayEnds(buildSeries([c('1'), c('5000'), c('9000')]))).toEqual([])
    expect(strayEnds(buildSeries([c('42')]))).toEqual([])
    expect(strayEnds(buildSeries([]))).toEqual([])
  })

  it('ignores out-of-pattern numbers: they neither are stray ends nor make one', () => {
    const s = buildSeries([...run(6000100000, 25), c('1791361374'), c('60000')])
    expect(s.outOfPattern).toHaveLength(2)
    expect(strayEnds(s)).toEqual([])
  })

  it('a staged line can be a stray end, and every entry on a stray number is named', () => {
    const s = buildSeries([...run(1000000, 3), c('5000000'), c('5000000')], [st('5000000.', 'CV-ST9')])
    const out = strayEnds(s)
    expect(out.map(label)).toEqual([
      '5000000 | STRAY LAST NUMBER — previous is 3999998 lower',
      '5000000 | STRAY LAST NUMBER — previous is 3999998 lower',
      'STAGED 5000000. | STRAY LAST NUMBER — previous is 3999998 lower',
    ])
    expect(out[2].staged?.acumaticaRef).toBe('CV-ST9')
  })

  it('a two-number series with a wide gap names both ends, each once', () => {
    expect(strayEnds(buildSeries([c('1'), c('100000')])).map(label)).toEqual([
      '1 | STRAY FIRST NUMBER — next is 99999 higher',
      '100000 | STRAY LAST NUMBER — previous is 99999 lower',
    ])
  })
})

describe('NO CHECK BOOK (spec §I): a check with no book is shown where its number falls', () => {
  const nb = (checkNumber: string, cashAccount: string | null = 'PAYROLL'): SeriesCheque => ({ ...c(checkNumber, 'SIGNED'), cashAccount })
  const run = (from: number, count: number) => Array.from({ length: count }, (_, i) => c(String(from + i)))

  it('fills a MISSING number inside the sequence, flagged, and the gap count drops', () => {
    const s = buildSeries([c('100'), c('104')], [], [nb('102')])
    expect(shape(s.entries)).toEqual(['100', 'MISSING 101-101 (1)', '102', 'MISSING 103-103 (1)', '104'])
    expect(s.entries[2]).toMatchObject({ kind: 'CHECK', noBook: true, duplicate: false, cheque: { checkNumber: '102', cashAccount: 'PAYROLL' } })
    expect(s.entries[0]).toMatchObject({ kind: 'CHECK', noBook: false })
    expect(s.summary).toMatchObject({ first: '100', last: '104', held: 2, noBook: 1, missingNumbers: '2', missingRuns: 2 })
  })

  it('never bounds the series: below the first or above the last it is left out, and so is one on the bound itself', () => {
    const s = buildSeries([c('100'), c('104')], [], [nb('99'), nb('105'), nb('100'), nb('104')])
    expect(shape(s.entries)).toEqual(['100', 'MISSING 101-103 (3)', '104'])
    expect(s.summary).toMatchObject({ first: '100', last: '104', held: 2, noBook: 0, duplicates: 0 })
  })

  it('a book with fewer than two numbers in its sequence places nothing', () => {
    expect(buildSeries([c('100')], [], [nb('101')]).summary).toMatchObject({ held: 1, noBook: 0 })
    expect(buildSeries([], [], [nb('101')]).entries).toEqual([])
  })

  it('is left out when its shape breaks the pattern, and never votes on it', () => {
    const sixty = run(6000100000, 25)
    const s = buildSeries([...sixty, c('6000100030')], [], [nb('1791405927'), nb('6000100027')])
    expect(s.pattern).toEqual({ digits: 10, lead: '60' })
    expect(shape(s.entries)).toEqual([...sixty.map((x) => x.checkNumber), 'MISSING 6000100025-6000100026 (2)', '6000100027', 'MISSING 6000100028-6000100029 (2)', '6000100030'])
    expect(s.summary).toMatchObject({ noBook: 1, outOfPattern: 0, held: 26 })
    // Twenty-five PAYROLL numbers of another shape do not turn the pattern.
    const many = Array.from({ length: 25 }, (_, i) => nb(String(1791400000 + i)))
    expect(buildSeries([...sixty, c('6000100030')], [], many).pattern).toEqual({ digits: 10, lead: '60' })
  })

  it('is a DUPLICATE when the book\'s own check holds the same number', () => {
    const s = buildSeries([c('100'), c('102'), c('104')], [], [nb('102')])
    expect(shape(s.entries)).toEqual(['100', 'MISSING 101-101 (1)', '102', '102', 'MISSING 103-103 (1)', '104'])
    expect(s.entries.filter((e) => e.kind === 'CHECK' && e.duplicate)).toHaveLength(2)
    expect(s.summary).toMatchObject({ held: 3, noBook: 1, duplicates: 2 })
  })

  it('is not held, voided or cancelled — those stay the book\'s own', () => {
    const s = buildSeries([c('100'), c('104', 'VOIDED')], [], [nb('101'), { ...nb('102'), status: 'VOIDED' }, { ...nb('103'), status: 'CANCELLED' }])
    expect(shape(s.entries)).toEqual(['100', '101', '102', '103', '104'])
    expect(s.summary).toMatchObject({ held: 2, voided: 1, cancelled: 0, noBook: 3, missingNumbers: '0' })
  })

  it('sits beside a staged re-use of its number and keeps a non-numeric unbooked check out', () => {
    const s = buildSeries([c('100'), c('104')], [st('102.')], [nb('102'), nb('PCF26-00001')])
    expect(shape(s.entries)).toEqual(['100', 'MISSING 101-101 (1)', '102', 'STAGED 102', 'MISSING 103-103 (1)', '104'])
    expect(s.notNumeric).toEqual([])
    expect(s.summary).toMatchObject({ staged: 1, noBook: 1, notNumeric: 0 })
  })

  it('strayEnds reads the placed check like any entry: a no-book check inside a stray gap closes it', () => {
    const far = STRAY_GAP + BigInt(2)
    const s = buildSeries([c('100'), c((BigInt(100) + far).toString())], [], [nb('5000')])
    expect(strayEnds(s)).toEqual([])
  })
})
