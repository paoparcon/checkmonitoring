import { listChecks, toTableRow } from '@/lib/queries'
import { compareCheckNumbers } from '@/lib/transmittal'
import { ageCheck, type AgingBucket, type BillTerms } from '@/lib/aging/buckets'

type Db = Parameters<typeof listChecks>[0]

/** Above this the page says it is short. SIGNED + READY FOR RELEASE is ~1,600 (measured 2026-10). */
export const AGING_LIMIT = 25_000

/** Acumatica's `Status` for a paid bill (the Supplier Portal's PAID_STATUS). */
export const CLOSED = 'Closed'

export type AgingRow = {
  id: string
  checkNumber: string
  cvNumber: string | null
  apvNumbers: string[]
  poNumbers: string[]
  payee: string | null
  company: string
  /** The check book, else the register label (`accountWhere`'s rule). */
  bank: string | null
  checkDate: string | null
  dueDate: string | null
  daysPastDue: number | null
  bucket: AgingBucket
  /** Decimal string, rule 8. */
  amount: string | null
  currency: string
  /** READY_FOR_RELEASE rows are already available: shown and counted, never selectable. */
  status: 'SIGNED' | 'READY_FOR_RELEASE'
}

const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/**
 * THE POPULATION (spec 2026-10-15; READY_FOR_RELEASE added 2026-10-16): SIGNED
 * and READY_FOR_RELEASE, a real check, an amount. Only the SIGNED ones may move
 * to READY FOR RELEASE (the picker refuses to select the others); the rest are
 * listed so Finance sees the whole aged picture. Each is aged by its bills: per
 * APV, Acumatica's due date and terms (`AcumaticaBillTerms`), and only when
 * Acumatica states no date, the approval workbook's (`CheckBill`).
 */
export async function loadAgingRows(db: Db, now: Date): Promise<{ rows: AgingRow[]; truncated: boolean }> {
  const listed = await listChecks(
    db, { statusIn: ['SIGNED', 'READY_FOR_RELEASE'], incomplete: false }, AGING_LIMIT, { key: 'checkNumber', dir: 'asc' },
  )
  // Measured before the isCheque filter: listChecks takes AGING_LIMIT rows in
  // the database, so the limit was hit by what the database returned, not by
  // what survives the filter.
  const truncated = listed.length >= AGING_LIMIT
  const tabled = listed.filter((c) => c.isCheque).map((c) => ({ c, table: toTableRow(c) }))

  const apvs = [...new Set(tabled.flatMap(({ table }) => table.apvNumbers))]
  const terms = apvs.length === 0 ? [] : await db.acumaticaBillTerms.findMany({
    where: { apvNumber: { in: apvs } },
    select: { apvNumber: true, dueDate: true, termsCode: true, status: true },
  })
  const byApv = new Map(terms.map((t) => [t.apvNumber, t]))

  // Paid in Acumatica, so not aged (user ruling 2026-10-16: "those closed in
  // acumatica should be closed to your aging"). The Supplier Portal's aging
  // drops a Closed bill the same way (its `settled`), so the two screens agree.
  // A check leaves only when EVERY APV it pays is Closed: one open bill keeps
  // the check, at its full amount, as before. A check with no APV, or an APV
  // Acumatica has not told us about, stays.
  const allClosed = (apvNumbers: readonly string[]) =>
    apvNumbers.length > 0 && apvNumbers.every((apv) => byApv.get(apv)?.status === CLOSED)

  const rows = tabled.filter(({ table }) => !allClosed(table.apvNumbers)).map(({ c, table }): AgingRow => {
    const bills: BillTerms[] = table.apvNumbers.map((apv) => {
      const acu = byApv.get(apv)
      const local = c.bills.find((b) => b.apvNumber === apv)
      return acu?.dueDate
        ? { dueDate: acu.dueDate, termsCode: acu.termsCode }
        : { dueDate: local?.dueDate ?? null, termsCode: acu?.termsCode ?? local?.termsCode ?? null }
    })
    const aging = ageCheck(bills, now)
    return {
      id: c.id,
      checkNumber: c.checkNumber,
      cvNumber: c.cvNumber,
      apvNumbers: table.apvNumbers,
      poNumbers: table.poNumbers,
      payee: table.payeeName,
      company: table.companyCode,
      bank: table.cashAccountCode,
      checkDate: ymd(table.checkDate),
      dueDate: ymd(aging.dueDate),
      daysPastDue: aging.daysPastDue,
      bucket: aging.bucket,
      amount: table.amount,
      currency: table.currency,
      status: c.status === 'READY_FOR_RELEASE' ? 'READY_FOR_RELEASE' : 'SIGNED',
    }
  })
  rows.sort((a, b) => compareCheckNumbers(a.checkNumber, b.checkNumber))
  return { rows, truncated }
}
