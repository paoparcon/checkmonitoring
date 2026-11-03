import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testDb, resetDb } from '../helpers/db'
import {
  runSync, lastSyncWatermark, SYNC_OVERLAP_MINUTES,
  SyncInProgressError, SYNC_IN_PROGRESS_MINUTES, type SyncTrigger,
} from '@/lib/sync/run'
import {
  PAYMENTS_FEED, PAYMENT_FIELDS,
  type AcumaticaClient, type AcumaticaRow, type FetchAllOptions, type PageOptions,
} from '@/lib/integrations/acumatica/client'

const NOW = new Date('2026-09-04T13:32:00+08:00')

beforeEach(resetDb)

// The sync is the path most likely to grow a PortalEvent by accident: it runs
// unattended, on a schedule, over every payment in the ERP. Publishing to a
// supplier is a Finance action, never a consequence of a sync running, so this
// is asserted after EVERY test in the file rather than in one test a later
// author could forget to extend. The single sanctioned exception (spec
// 2026-09-26-check-monitoring-integration §2.1): an Acumatica void of a
// portal-routed cheque goes through voidCheck, which queues CANCELLED so the
// portal stops showing a cheque the ERP says is gone. Nothing else may queue.
afterEach(async () => {
  expect(await testDb.portalEvent.count({ where: { kind: { not: 'CANCELLED' } } })).toBe(0)
})

// ---------------------------------------------------------------------------
// A feed that never touches the network.
// ---------------------------------------------------------------------------

type FeedCall = { feed: string; opts: FetchAllOptions | undefined }

/**
 * Honours `$filter` rather than ignoring it. That is the whole point: the
 * watermark tests below are only meaningful if narrowing the window actually
 * hides rows, so removing the 120-minute overlap makes a row genuinely
 * unreachable instead of merely changing a recorded number.
 *
 * Comparison is lexicographic on Acumatica's own naive `YYYY-MM-DDTHH:MM:SS`
 * strings, which sort chronologically — the same property `map.ts` relies on
 * when it round-trips the watermark back into a literal.
 */
function fakeFeed(rows: readonly AcumaticaRow[], failWith?: Error) {
  const calls: FeedCall[] = []

  /**
   * Every clause is applied, and an unrecognised one still throws.
   *
   * Both halves matter. Applying them is what makes the watermark tests real —
   * narrowing the window has to hide rows, not just change a recorded number.
   * Throwing on anything unrecognised is what caught the scope filters being
   * added on 2026-09-04: a fake that shrugged at a filter it did not understand
   * would have gone on passing while the real feed returned a different set.
   *
   * Clause order in the string is not asserted, only that each is honoured, so
   * the production filter can be rearranged without a spurious failure here.
   */
  function applyFilter(filter: string | undefined): AcumaticaRow[] {
    if (!filter) return [...rows]

    let out = [...rows]
    let rest = filter

    const since = /LastModifiedOn ge datetime'([^']+)'/.exec(rest)
    if (since) {
      out = out.filter((r) => String(r.LastModifiedOn ?? '') >= since[1])
      rest = rest.replace(since[0], '')
    }

    // The scope boundary: cheques dated from 2026 only. See SYNC_FROM_DATE.
    const from = /PaymentDate ge datetime'([^']+)'/.exec(rest)
    if (from) {
      out = out.filter((r) => String(r.PaymentDate ?? '') >= from[1])
      rest = rest.replace(from[0], '')
    }

    // One method, or a parenthesised `or` of several — the shape the feed
    // accepts (measured 2026-10-23: CHK-or-CASH answered 943 = 942 + 1 rows).
    const methods = /[(]?PaymentMethod eq '([^']+)'(?: or PaymentMethod eq '([^']+)')*[)]?/.exec(rest)
    if (methods) {
      const allowed = [...methods[0].matchAll(/eq '([^']+)'/g)].map((m) => m[1])
      out = out.filter((r) => allowed.includes(String(r.PaymentMethod ?? '').trim()))
      rest = rest.replace(methods[0], '')
    }

    const leftover = rest.replace(/\band\b/g, '').trim()
    if (leftover !== '') {
      throw new Error(`the fake feed does not understand the filter clause: ${leftover}`)
    }
    return out
  }

  const client: AcumaticaClient = {
    async fetchAll(feed: string, opts?: FetchAllOptions): Promise<AcumaticaRow[]> {
      calls.push({ feed, opts })
      if (failWith) throw failWith
      return applyFilter(opts?.filter)
    },
    async fetchPage(_feed: string, _opts?: PageOptions): Promise<AcumaticaRow[]> {
      throw new Error('runSync must page through fetchAll, not fetchPage')
    },
  }
  return { client, calls }
}

/**
 * One raw row of the `AP-Checks and Payments` generic inquiry, in the shapes the
 * live instance actually returns (measured 2026-09-04 over 400 rows):
 * `PaymentAmount`, `PaymentDate` and `LastModifiedOn` are STRINGS, and `Branch`
 * is space-padded. The padding is load-bearing in this fixture — it is the only
 * thing proving company resolution still works through `orNull`'s trim.
 *
 * Overrides are keyed to `PAYMENT_FIELDS`, so a misspelt field name is a compile
 * error rather than a silently ignored key.
 */
type PaymentField = (typeof PAYMENT_FIELDS)[number]
function feedRow(overrides: Partial<Record<PaymentField, unknown>> = {}): AcumaticaRow {
  return {
    Type: 'Payment',
    ReferenceNbr: 'CV-ST-004112',
    Vendor: 'V0001',
    VendorName: 'HENKEL PHILIPPINES INC.',
    Status: 'Balanced',
    PaymentDate: '2026-01-19T00:00:00',
    Description: 'PAYMENT FOR JAN BILLING',
    PaymentRef: '6000319079',
    PaymentAmount: '197715.42',
    Balance: '0.00',
    Currency: 'PHP',
    CashAccount: 'BPI STK',
    // CHK, not CHECK. Measured 2026-09-04 over 1,987 live rows: CHK 1947,
    // DEBIT ADV 35, CASH 5. The fixture said CHECK for as long as `isCheque`
    // ignored the field; now that PaymentMethod decides whether Finance is
    // offered a SIGN button, the literal is load-bearing.
    PaymentMethod: 'CHK',
    Branch: 'ST        ',
    LastModifiedOn: '2026-09-04T10:00:00',
    ...overrides,
  }
}

async function seedCompany(code: string, name: string) {
  return testDb.company.create({
    data: { code, name, legalNames: [name.toUpperCase()] },
  })
}

/** Go-Live `ST` is Starkson Packaging; MANUFACTURING `ST` is Starkson Paper and Plastic. */
async function seedBothTenantsST() {
  await seedCompany('STK', 'Starkson Packaging Inc.')
  await seedCompany('STPP', 'Starkson Paper and Plastic Inc.')
}

const sync = (
  rows: readonly AcumaticaRow[],
  opts: {
    tenant?: 'GOLIVE' | 'MANUFACTURING'
    since?: Date | null
    now?: Date
    trigger?: SyncTrigger
    inProgressMinutes?: number
  } = {},
) => {
  const { client, calls } = fakeFeed(rows)
  return {
    calls,
    result: runSync(testDb, {
      client,
      tenant: opts.tenant ?? 'GOLIVE',
      since: opts.since ?? null,
      now: opts.now ?? NOW,
      trigger: opts.trigger ?? 'MANUAL',
      inProgressMinutes: opts.inProgressMinutes,
    }),
  }
}

// ---------------------------------------------------------------------------

describe('runSync — the run record', () => {
  it('records a SyncRun with imported, updated, errors and finishedAt', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.imported).toBe(1)
    expect(run.updated).toBe(0)
    expect(run.errors).toBe(0)
    expect(run.finishedAt).not.toBeNull()
    expect(run.startedAt).toEqual(NOW)
  })

  it('records who started it', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()], { trigger: 'SCHEDULED' }).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.trigger).toBe('SCHEDULED')
  })

  /**
   * Measured 2026-09-10: `finishedAt = startedAt` on every completed run in
   * production, because `finish` wrote the instant the run was STARTED with.
   * No run had ever had a duration. `startedAt` is still the caller's clock —
   * that is what lets these tests pin it — so the only honest `finishedAt` is
   * the real one.
   */
  it('finishes after it starts', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.startedAt).toEqual(NOW)
    expect(run.finishedAt!.getTime()).toBeGreaterThan(run.startedAt.getTime())
  })

  it('records which tenant it ran against, because branch codes mean different companies in each', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow()], { tenant: 'MANUFACTURING' }).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.tenant).toBe('MANUFACTURING')
  })

  it('counts a re-read of the same payment as updated, not imported', async () => {
    await seedBothTenantsST()
    await sync([feedRow()]).result
    const second = await sync([feedRow({ PaymentAmount: '197715.43' })]).result

    expect(second.imported).toBe(0)
    expect(second.updated).toBe(1)
    // Duplicate prevention lives in upsertCheck and nowhere else; the sync adds
    // no second dedup path, so one cheque is still one row.
    expect(await testDb.check.count()).toBe(1)
  })

  it('calls the payments feed by name, asking only for the fields it publishes', async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()])
    await run.result
    expect(run.calls).toHaveLength(1)
    expect(run.calls[0].feed).toBe(PAYMENTS_FEED)
    expect(run.calls[0].opts?.select).toEqual(PAYMENT_FIELDS)
    // `fetchAll` pages with `$skip`, and `$skip` over an unordered result set can
    // shift a row between pages and lose it entirely. The order is the guarantee
    // that paging sees every row once.
    expect(run.calls[0].opts?.orderby).toBe('LastModifiedOn asc')
  })

  it('records the mode: FULL with no watermark to start from, INCREMENTAL with one', async () => {
    await seedBothTenantsST()
    const full = await sync([feedRow()], { since: null }).result
    expect(full.mode).toBe('FULL')

    const incremental = await sync([feedRow()], { since: new Date('2026-09-01T00:00:00Z') }).result
    expect(incremental.mode).toBe('INCREMENTAL')

    const modes = await testDb.syncRun.findMany({ orderBy: { id: 'asc' }, select: { mode: true } })
    expect(modes.map((m) => m.mode).sort()).toEqual(['FULL', 'INCREMENTAL'])
  })

  it('accounts for every row the feed returned', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow(),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-ST-004113' }),
      // Not a cheque document. Skipped, not an error.
      feedRow({ Type: 'Debit Adj.', PaymentRef: '6000319081' }),
      // CHANGED 2026-09-04: a payment with no usable cheque number is now
      // STAGED, not counted as an error. It used to be unstageable — a feed row
      // has no sheet or row number, which was the only key `StagedCheck` had —
      // so 80 real cheques a run at a time were reported as failures and left
      // nowhere. Finance ruled they are staged like the register's numberless
      // rows so a human can supply the number.
      feedRow({ PaymentRef: '', ReferenceNbr: 'CV-ST-004114' }),
    ]).result

    expect(result.fetched).toBe(4)
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(2)
    expect(result.updated).toBe(0)
    expect(result.staged).toBe(1)
    expect(result.errors).toBe(0)
    // The invariant that makes "nothing is silently dropped" checkable. It now
    // includes `collapsed` — the reversal half of a voided pair, which is
    // deliberately not written — so a row can still never simply vanish.
    expect(
      result.skipped + result.collapsed + result.imported +
      result.updated + result.staged + result.errors,
    ).toBe(result.fetched)
  })
})

describe('runSync — the incremental window', () => {
  it("asks Acumatica for rows since the watermark, in the literal form it accepts", async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()], { since: new Date('2026-09-03T20:00:00Z') })
    await run.result

    // Measured against the live instance, 2026-09-04: this OData v3 literal is
    // the ONLY accepted form. A bare `2026-09-03T20:00:00`, a trailing `Z` and
    // `datetimeoffset'...'` each returned HTTP 500.
    // The watermark clause, AND the scope clauses added 2026-09-04. Asserted in
    // full rather than by substring: a filter that silently lost the scope half
    // would fetch 41,998 rows instead of 11,417 and re-import the AP history
    // that was deliberately trimmed out of production.
    expect(run.calls[0].opts?.filter).toBe(
      "LastModifiedOn ge datetime'2026-09-03T20:00:00' and " +
      "PaymentDate ge datetime'2026-01-01T00:00:00' and (PaymentMethod eq 'CHK' or PaymentMethod eq 'CASH')",
    )
  })

  it('still scopes a full run — 2026 checks only, never the whole feed', async () => {
    await seedBothTenantsST()
    const run = sync([feedRow()], { since: null })
    await run.result
    // Was 'no filter at all' until 2026-09-04. An unfiltered full run reads
    // 41,998 rows, creates a cheque for every AP payment Acumatica ever held,
    // and cannot finish inside a serverless request — it did exactly that, and
    // 12,530 out-of-scope records had to be deleted afterwards.
    expect(run.calls[0].opts?.filter).toBe(
      "PaymentDate ge datetime'2026-01-01T00:00:00' and (PaymentMethod eq 'CHK' or PaymentMethod eq 'CASH')",
    )
  })

  it('the overlap is 120 minutes', () => {
    expect(SYNC_OVERLAP_MINUTES).toBe(120)
  })

  it('sets the watermark to the maximum LastModifiedOn seen MINUS the overlap', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ PaymentRef: '6000319079', LastModifiedOn: '2026-09-04T09:30:00' }),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2', LastModifiedOn: '2026-09-04T10:00:00' }),
    ]).result

    expect(result.watermark).toEqual(new Date('2026-09-04T08:00:00Z'))
    // Stated separately and deliberately: the maximum itself is the wrong
    // answer, and a change that drops the overlap must fail here.
    expect(result.watermark).not.toEqual(new Date('2026-09-04T10:00:00Z'))

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toEqual(new Date('2026-09-04T08:00:00Z'))
  })

  it('picks up a row committed DURING the previous run, which the overlap exists for', async () => {
    await seedBothTenantsST()

    // Run one observes a maximum of 10:00. A row was committed while it was
    // running and carries 09:00 — below that maximum, and never returned to
    // run one because it was not committed when the feed was read.
    const first = await sync([
      feedRow({ PaymentRef: '6000319079', LastModifiedOn: '2026-09-04T09:30:00' }),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2', LastModifiedOn: '2026-09-04T10:00:00' }),
    ]).result

    const lateRow = feedRow({
      PaymentRef: '6000319081', ReferenceNbr: 'CV-3', LastModifiedOn: '2026-09-04T09:00:00',
    })

    // The fake feed honours the filter, so if the watermark were the bare
    // maximum the late row would simply not come back and this run would import
    // nothing. That row is a real payment; losing it is losing money.
    const second = await sync([lateRow], { since: first.watermark }).result
    expect(second.imported).toBe(1)
    expect(await testDb.check.findFirst({ where: { checkNumber: '6000319081' } })).not.toBeNull()
  })

  it('leaves the previous watermark standing when it took responsibility for no rows', async () => {
    await seedBothTenantsST()
    const result = await sync([feedRow({ Type: 'Debit Adj.' })]).result
    expect(result.watermark).toBeNull()

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.watermark).toBeNull()
  })

  it('reads back the last watermark for a tenant, and never the other tenant’s', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ LastModifiedOn: '2026-09-04T10:00:00' })], { tenant: 'GOLIVE' }).result
    await sync([feedRow({ LastModifiedOn: '2026-09-04T18:00:00' })], { tenant: 'MANUFACTURING' }).result

    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-04T08:00:00Z'))
    expect(await lastSyncWatermark(testDb, 'MANUFACTURING')).toEqual(new Date('2026-09-04T16:00:00Z'))
    // Nothing has ever run for a tenant with no runs.
    await testDb.syncRun.deleteMany({ where: { tenant: 'GOLIVE' } })
    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toBeNull()
  })

  it('ignores a newer BILLS row, whose watermark is on a different feed', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ LastModifiedOn: '2026-09-04T10:00:00' })]).result
    await testDb.syncRun.create({
      data: {
        mode: 'BILLS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() + 60_000),
        finishedAt: new Date(NOW.getTime() + 61_000), watermark: new Date('2026-09-30T00:00:00Z'),
      },
    })
    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-04T08:00:00Z'))
  })

  it('ignores a newer BILL_REFS row, whose watermark is on a different feed', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ LastModifiedOn: '2026-09-04T10:00:00' })]).result
    await testDb.syncRun.create({
      data: {
        mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: new Date(NOW.getTime() + 60_000),
        finishedAt: new Date(NOW.getTime() + 61_000), watermark: new Date('2026-09-30T00:00:00Z'),
      },
    })
    expect(await lastSyncWatermark(testDb, 'GOLIVE')).toEqual(new Date('2026-09-04T08:00:00Z'))
  })
})

describe('runSync — one bad row must not cost a 37,000-row sync', () => {
  it('counts a row it cannot write as an error and carries on', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ PaymentRef: '6000319079' }),
      // CHANGED 2026-09-04: these two used to be errors because nothing could
      // key a staged Acumatica row. They are now kept whole and staged — a
      // memo where the cheque number belongs, and a branch that resolves no
      // company. A seeding fault is still an error, because a code no Company
      // row carries is a configuration problem, not a fact about the cheque.
      feedRow({ PaymentRef: '   ', ReferenceNbr: 'CV-2' }),
      feedRow({ PaymentRef: '6000319081', ReferenceNbr: 'CV-3', Branch: 'NOT-A-BRANCH' }),
      // HAMFI(HO) resolves to HAMFI, which is deliberately not seeded here.
      feedRow({ PaymentRef: '6000319083', ReferenceNbr: 'CV-5', Branch: 'HAMFI(HO)' }),
      feedRow({ PaymentRef: '6000319082', ReferenceNbr: 'CV-4' }),
    ]).result

    expect(result.errors).toBe(1)
    expect(result.staged).toBe(2)
    expect(result.imported).toBe(2)
    // The rows AFTER the bad ones are what matters: an abort would lose them.
    expect(await testDb.check.findFirst({ where: { checkNumber: '6000319082' } })).not.toBeNull()
  })

  it('records a run with errors as finished, and says what went wrong without naming a payee', async () => {
    await seedBothTenantsST()
    // HAMFI is not seeded: a company code no Company row carries.
    const result = await sync([feedRow({ Branch: 'HAMFI(HO)' })]).result

    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.errors).toBe(1)
    expect(run.finishedAt).not.toBeNull()
    expect(run.message).toBeTruthy()
    // An error message ends up in a SyncRun row and in logs, so it must be safe
    // to paste into a ticket. Vendor names and amounts are not.
    expect(run.message).not.toContain('HENKEL')
    expect(run.message).not.toContain('197715.42')
  })

  it('does not treat a document type it declines to import as an error', async () => {
    await seedBothTenantsST()
    const result = await sync([
      feedRow({ Type: 'Debit Adj.' }),
      feedRow({ Type: 'Prepayment', PaymentRef: '6000319080' }),
      feedRow({ Type: 'Refund', PaymentRef: '6000319081' }),
    ]).result

    expect(result.skipped).toBe(3)
    expect(result.errors).toBe(0)
    expect(result.imported).toBe(0)
    expect(await testDb.check.count()).toBe(0)
  })

  it('raises a company code that no Company row carries, rather than burying it', async () => {
    // STK is deliberately not seeded: a branch that maps to a code with no
    // Company row is a seeding fault, not a fact about the cheque.
    const result = await sync([feedRow()]).result
    expect(result.errors).toBe(1)
    expect(result.imported).toBe(0)
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.message).toContain('STK')
  })
})

describe('runSync — a run that fails outright', () => {
  it('still writes a SyncRun with finishedAt set, so a hung sync is distinguishable', async () => {
    await seedBothTenantsST()
    const { client } = fakeFeed([], new Error('OData AP-Checks and Payments returned 500'))

    await expect(
      runSync(testDb, { client, tenant: 'GOLIVE', since: null, now: NOW, trigger: 'MANUAL' }),
    ).rejects.toThrow('returned 500')

    const run = await testDb.syncRun.findFirstOrThrow()
    expect(run.finishedAt).not.toBeNull()
    expect(run.tenant).toBe('GOLIVE')
    expect(run.errors).toBe(1)
    expect(run.message).toContain('returned 500')
    // A failed run must not move the watermark forward over rows it never read.
    expect(run.watermark).toBeNull()
  })
})

describe('runSync — two tenants, never inferred', () => {
  it('files the same branch code under a different company in each tenant', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ PaymentRef: '6000319079' })], { tenant: 'GOLIVE' }).result
    await sync([feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-2' })], { tenant: 'MANUFACTURING' }).result

    const golive = await testDb.check.findFirstOrThrow({
      where: { checkNumber: '6000319079' }, include: { company: true },
    })
    const mfg = await testDb.check.findFirstOrThrow({
      where: { checkNumber: '6000319080' }, include: { company: true },
    })
    expect(golive.company.code).toBe('STK')
    expect(mfg.company.code).toBe('STPP')
    expect(golive.acumaticaTenant).toBe('GOLIVE')
    expect(mfg.acumaticaTenant).toBe('MANUFACTURING')
  })
})

describe('runSync — promoting staged rows', () => {
  async function stage(overrides: {
    reason: 'NO_COMPANY' | 'AMBIGUOUS_COMPANY' | 'NO_CHECK_NUMBER'
    checkNumber: string | null
    sourceRow: number
    companyCode?: string | null
    conflictingCompanies?: string[]
  }) {
    return testDb.stagedCheck.create({
      data: {
        // Register rows, which is what promotion is for: Acumatica supplying a
        // company says which company the cheque belongs to.
        source: 'WORKBOOK',
        sourceSheet: 'BPI RELEASED',
        sourceRow: overrides.sourceRow,
        reason: overrides.reason,
        checkNumber: overrides.checkNumber,
        companyCode: overrides.companyCode ?? null,
        conflictingCompanies: overrides.conflictingCompanies ?? [],
        impliedStatus: 'RELEASED',
        amount: '197715.42',
        payeeName: 'HENKEL PHILIPPINES INC.',
      },
    })
  }

  it('promotes a NO_COMPANY row once the sync supplies a company for its check number', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    const result = await sync([feedRow({ PaymentRef: '6000319079' })]).result
    expect(result.promoted).toBe(1)

    const check = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000319079' } })
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBe(check.id)
    // The staging record is the evidence of WHY the cheque was held. Promoting
    // it links it; it never deletes it.
    expect(await testDb.stagedCheck.count()).toBe(1)
    expect(after.reason).toBe('NO_COMPANY')
  })

  it('links to the check of the company the sync supplied, never a sibling company’s same number', async () => {
    await seedBothTenantsST()
    const stpp = await testDb.company.findUniqueOrThrow({ where: { code: 'STPP' } })
    // Starkson Paper and Plastic holds 6000319079 — filed there from the
    // register's cheque book, which is what the 1,865 duplicates were made of.
    const sibling = await testDb.check.create({
      data: { companyId: stpp.id, checkNumber: '6000319079', status: 'RELEASED', eligibility: 'SUPPLIER' },
    })
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    await sync([feedRow({ PaymentRef: '6000319079' })], { tenant: 'GOLIVE' }).result

    const stk = await testDb.company.findUniqueOrThrow({ where: { code: 'STK' } })
    const goliveCheck = await testDb.check.findUniqueOrThrow({
      where: { companyId_checkNumber: { companyId: stk.id, checkNumber: '6000319079' } },
    })
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })

    // The property this test exists for, unchanged: the staged row links to the
    // cheque of the company the SYNC supplied, reached through `upsertCheck`'s
    // keyed resolution and never through a lookup on the cheque number alone.
    expect(after.promotedCheckId).toBe(goliveCheck.id)
    expect(goliveCheck.companyId).toBe(stk.id)

    // CHANGED 2026-09-06, and this half is now the stronger claim. This used to
    // assert the staged row did NOT link to the sibling, on the premise that a
    // sibling company could legitimately hold the same number. The client ruled
    // that premise wrong — a cheque number belongs to one cheque book, so the
    // STPP row and the GOLIVE payment are ONE cheque — and `upsertCheck` now
    // refiles it under the company Acumatica's Branch names instead of storing
    // it a second time. So there is one cheque here, not two, and it is the row
    // that was misfiled rather than a fresh one beside it.
    expect(await testDb.check.count({ where: { checkNumber: '6000319079' } })).toBe(1)
    expect(goliveCheck.id).toBe(sibling.id)
    expect(await testDb.auditLog.count({ where: { action: 'check_company_corrected' } })).toBe(1)
  })

  it('leaves AMBIGUOUS_COMPANY rows untouched — Finance ruled a human settles those', async () => {
    await seedBothTenantsST()
    // 61 rows across 27 cheque numbers, of which 25 are one physical cheque
    // entered twice. Acumatica supplying a company does not say which of the
    // duplicated register rows was right, so promoting one would resolve by
    // accident a question Finance asked to decide (ruling of 2026-09-03).
    const ambiguous = await stage({
      reason: 'AMBIGUOUS_COMPANY', checkNumber: '6000319079', sourceRow: 412,
      companyCode: 'STPP', conflictingCompanies: ['STK', 'STPP'],
    })
    const sibling = await stage({
      reason: 'AMBIGUOUS_COMPANY', checkNumber: '6000319079', sourceRow: 998,
      companyCode: 'STK', conflictingCompanies: ['STK', 'STPP'],
    })

    const result = await sync([feedRow({ PaymentRef: '6000319079' })]).result
    expect(result.promoted).toBe(0)

    for (const id of [ambiguous.id, sibling.id]) {
      const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id } })
      expect(after.promotedCheckId).toBeNull()
    }
  })

  it('leaves a NO_CHECK_NUMBER row untouched, having nothing to match it on', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_CHECK_NUMBER', checkNumber: null, sourceRow: 412 })
    const result = await sync([feedRow()]).result

    expect(result.promoted).toBe(0)
    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).toBeNull()
  })

  it('promotes once — a second sync over the same check re-promotes nothing', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })

    const first = await sync([feedRow()]).result
    const second = await sync([feedRow()]).result

    expect(first.promoted).toBe(1)
    expect(second.promoted).toBe(0)

    const after = await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })
    expect(after.promotedCheckId).not.toBeNull()
    const audits = await testDb.auditLog.count({ where: { action: 'staged_row_promoted' } })
    expect(audits).toBe(1)
  })

  it('records the promotion against the check, so the link is traceable', async () => {
    await seedBothTenantsST()
    const staged = await stage({ reason: 'NO_COMPANY', checkNumber: '6000319079', sourceRow: 412 })
    await sync([feedRow()]).result

    const audit = await testDb.auditLog.findFirstOrThrow({ where: { action: 'staged_row_promoted' } })
    expect(audit.actorType).toBe('SYSTEM')
    expect(audit.userId).toBeNull()
    expect(audit.details).toMatchObject({
      stagedCheckId: staged.id, sourceSheet: 'BPI RELEASED', sourceRow: 412, reason: 'NO_COMPANY',
    })
  })
})

describe('runSync — a voided check must never store its own reversal', () => {
  // A void is TWO feed rows under one PaymentRef: the original (Type Payment,
  // positive, Status Voided) and the reversal (Type Voided Payment, negative).
  // Both map to the same (company, checkNumber), and BOTH carry an identical
  // LastModifiedOn on 62 of the 67 such pairs among 1,836 keyable live cheques — so
  // which one survived a last-write-wins upsert was arbitrary. A cheque could
  // end up holding its own negative reversal as its amount.
  const VOIDED_AT = '2026-09-04T10:00:00'
  const originalRow = (o: Record<string, unknown> = {}) => feedRow({
    Type: 'Payment', Status: 'Voided', PaymentAmount: '88426.95',
    PaymentRef: '6000319079', ReferenceNbr: 'CV-ORIG', LastModifiedOn: VOIDED_AT, ...o,
  })
  const reversalRow = (o: Record<string, unknown> = {}) => feedRow({
    Type: 'Voided Payment', Status: 'Closed', PaymentAmount: '-88426.95',
    // The SAME reference as the original: in the live feed a void's two halves
    // share their ReferenceNbr (CV-A1013045, CV-ST010945; measured 2026-10-06).
    PaymentRef: '6000319079', ReferenceNbr: 'CV-ORIG', LastModifiedOn: VOIDED_AT, ...o,
  })

  it('stores the ORIGINAL positive amount, whichever order the pair arrives in', async () => {
    for (const rows of [[originalRow(), reversalRow()], [reversalRow(), originalRow()]]) {
      await resetDb()
      await seedBothTenantsST()
      const result = await sync(rows).result

      const check = await testDb.check.findFirstOrThrow()
      expect(check.amount?.toString()).toBe('88426.95')
      expect(check.status).toBe('VOIDED')
      // One physical cheque, one row.
      expect(await testDb.check.count()).toBe(1)
      // The reversal is accounted for rather than silently dropped.
      expect(result.collapsed).toBe(1)
      expect(result.imported).toBe(1)
      expect(result.fetched).toBe(2)
    }
  })

  it('reads the amount off the original rather than negating the reversal', async () => {
    await seedBothTenantsST()
    // Deliberately not each other's negation. Nothing may derive one from the
    // other; the original states the cheque's amount and is the row kept.
    await sync([
      originalRow({ PaymentAmount: '88426.95' }),
      reversalRow({ PaymentAmount: '-99999.99' }),
    ]).result

    const check = await testDb.check.findFirstOrThrow()
    expect(check.amount?.toString()).toBe('88426.95')
  })

  it('leaves a lone reversal exactly as the feed sent it', async () => {
    // No pair to collapse, so nothing is inferred. In practice this cannot
    // happen within a run — both rows carry the same LastModifiedOn and so fall
    // in the same incremental window — but inventing the cheque's amount from
    // the negation of its reversal would be inventing a fact about money.
    await seedBothTenantsST()
    const result = await sync([reversalRow()]).result

    expect(result.collapsed).toBe(0)
    expect(result.imported).toBe(1)
    const check = await testDb.check.findFirstOrThrow()
    expect(check.amount?.toString()).toBe('-88426.95')
    expect(check.status).toBe('VOIDED')
  })

  it('collapses the pair without touching an unrelated check of the same number', async () => {
    await seedBothTenantsST()
    const result = await sync([
      originalRow(),
      reversalRow(),
      feedRow({ PaymentRef: '6000319080', ReferenceNbr: 'CV-OTHER', PaymentAmount: '5.00' }),
    ]).result

    expect(result.imported).toBe(2)
    expect(result.collapsed).toBe(1)
    const other = await testDb.check.findFirstOrThrow({ where: { checkNumber: '6000319080' } })
    expect(other.status).not.toBe('VOIDED')
  })

  it('still advances the watermark past the reversal it did not write', async () => {
    // The reversal is a row the feed returned. Excluding its timestamp from the
    // maximum would leave the watermark short and re-read it forever.
    await seedBothTenantsST()
    const result = await sync([
      originalRow({ LastModifiedOn: '2026-09-04T09:00:00' }),
      reversalRow({ LastModifiedOn: VOIDED_AT }),
    ]).result
    expect(result.watermark).toEqual(new Date('2026-09-04T08:00:00Z'))
  })
})

describe('runSync — the two sources must key one check one way', () => {
  it('imports a bank-prefixed PaymentRef under the register’s bare check number', async () => {
    // 90.0% of live rows are bank-prefixed. The register writes the same cheque
    // bare, and the dedup key is (companyId, checkNumber) — so until these
    // matched, one physical cheque was stored twice, once per source.
    await seedBothTenantsST()
    await sync([feedRow({ PaymentRef: 'BPI 6000319079' })]).result

    const check = await testDb.check.findFirstOrThrow()
    expect(check.checkNumber).toBe('6000319079')
  })

  it('does not create a second check for the prefixed and bare forms', async () => {
    await seedBothTenantsST()
    await sync([feedRow({ PaymentRef: '6000319079' })]).result
    const second = await sync([feedRow({ PaymentRef: 'BPI 6000319079' })]).result

    expect(second.imported).toBe(0)
    expect(second.updated).toBe(1)
    expect(await testDb.check.count()).toBe(1)
  })

  it('promotes a staged register row whose bare number the feed writes prefixed', async () => {
    // The consequence that made this critical: a staged row could NEVER be
    // promoted, because the number the sync resolved a company for never
    // matched the number the register had staged.
    await seedBothTenantsST()
    const staged = await testDb.stagedCheck.create({
      data: {
        source: 'WORKBOOK', sourceSheet: 'BPI RELEASED', sourceRow: 412,
        reason: 'NO_COMPANY', checkNumber: '6000319079', conflictingCompanies: [],
        impliedStatus: 'RELEASED',
      },
    })

    const result = await sync([feedRow({ PaymentRef: 'MBTC 6000319079' })]).result
    expect(result.promoted).toBe(1)
    expect((await testDb.stagedCheck.findUniqueOrThrow({ where: { id: staged.id } })).promotedCheckId)
      .not.toBeNull()
  })
})

describe('runSync — a check whose reference is a memo', () => {
  const memoRow = (o: Record<string, unknown> = {}) => feedRow({
    PaymentMethod: 'CHK', PaymentRef: 'Oct interest', ReferenceNbr: 'CV-MEMO', ...o,
  })

  it('stages it whole instead of failing the row', async () => {
    await seedBothTenantsST()
    const result = await sync([memoRow()]).result

    expect(result.staged).toBe(1)
    expect(result.errors).toBe(0)
    expect(await testDb.check.count()).toBe(0)

    const staged = await testDb.stagedCheck.findFirstOrThrow()
    expect(staged.reason).toBe('NO_CHECK_NUMBER')
    expect(staged.source).toBe('ACUMATICA')
    expect(staged.acumaticaRef).toBe('CV-MEMO')
    expect(staged.acumaticaTenant).toBe('GOLIVE')
    expect(staged.statedCheckRef).toBe('Oct interest')
    expect(staged.checkNumber).toBeNull()
    expect(staged.payeeName).toBe('HENKEL PHILIPPINES INC.')
    expect(staged.amount?.toString()).toBe('197715.42')
  })

  it('re-running the sync updates the staged row rather than duplicating it', async () => {
    await seedBothTenantsST()
    await sync([memoRow()]).result
    await sync([memoRow({ PaymentAmount: '200000.00' })]).result

    expect(await testDb.stagedCheck.count()).toBe(1)
    expect((await testDb.stagedCheck.findFirstOrThrow()).amount?.toString()).toBe('200000')
  })

  it('records the staged count on the run, so nobody has to notice it is missing', async () => {
    await seedBothTenantsST()
    const result = await sync([memoRow()]).result
    const run = await testDb.syncRun.findUniqueOrThrow({ where: { id: result.syncRunId } })
    expect(run.staged).toBe(1)
    expect(run.errors).toBe(0)
  })

  it('never even fetches a non-check payment, because the feed filter excludes it', async () => {
    // Was 'imports a non-cheque payment normally' until 2026-09-04. DEBIT ADV
    // and wire (TT) payments have no physical document, so a check monitoring
    // system has no use for them — Finance ruling, after a full sync imported
    // 1,696 of them. They are excluded by the PaymentMethod clause of the
    // feed query, so they are never fetched, never mapped and never written.
    //
    // mapPayment still computes isCheque from the same field plus the
    // China-branch rule. That is not redundant: it is what flags a non-cheque
    // arriving by any other path, and tests/integrations/acumatica-map.test.ts
    // pins it.
    await seedBothTenantsST()
    const run = sync([
      feedRow({ PaymentMethod: 'DEBIT ADV', PaymentRef: 'Oct interest', ReferenceNbr: 'CV-DA' }),
    ])
    const result = await run.result

    expect(result.fetched).toBe(0)
    expect(result.imported).toBe(0)
    expect(await testDb.check.count()).toBe(0)
  })

  it('marks an ordinary CHK payment as a check', async () => {
    await seedBothTenantsST()
    await sync([feedRow()]).result
    expect((await testDb.check.findFirstOrThrow()).isCheque).toBe(true)
  })

  it('fetches a CASH payment and holds it as a check — a check payable to cash is still a check', async () => {
    // User ruling 2026-10-23: every AP voucher is paid by check; CASH is the
    // method for one payable to cash or to be encashed. CV-ST021234
    // (6000354949, BPI-S-8879, 19 Oct) was never fetched under CHK-only and so
    // never reached the portal — the complaint that led here.
    await seedBothTenantsST()
    const run = sync([
      feedRow({ PaymentMethod: 'CASH', PaymentRef: '6000354949', ReferenceNbr: 'CV-ST021234' }),
    ])
    const result = await run.result
    expect(result.fetched).toBe(1)
    expect(result.imported).toBe(1)
    const c = await testDb.check.findFirstOrThrow()
    expect(c.checkNumber).toBe('6000354949')
    expect(c.isCheque).toBe(true)
  })
})

describe('runSync — one run per tenant at a time', () => {
  const minutesBefore = (m: number) => new Date(NOW.getTime() - m * 60_000)

  const unfinished = (tenant: 'GOLIVE' | 'MANUFACTURING', startedAt: Date) =>
    testDb.syncRun.create({
      data: { mode: 'INCREMENTAL', tenant, startedAt, finishedAt: null, trigger: 'MANUAL' },
    })

  it('refuses to start while a run of the same tenant is still going', async () => {
    await seedBothTenantsST()
    await unfinished('GOLIVE', minutesBefore(5))
    await expect(sync([feedRow()]).result).rejects.toBeInstanceOf(SyncInProgressError)
    // Refused BEFORE writing: the refusal leaves no row of its own.
    expect(await testDb.syncRun.count()).toBe(1)
  })

  /**
   * A killed run keeps `finishedAt` null for ever — the 4 September 14:07 row
   * in production is one. Past the window it is a corpse, not a competitor,
   * and must not block every future run.
   */
  it('ignores an unfinished run older than the window', async () => {
    await seedBothTenantsST()
    await unfinished('GOLIVE', minutesBefore(SYNC_IN_PROGRESS_MINUTES + 5))
    const result = await sync([feedRow()]).result
    expect(result.imported).toBe(1)
  })

  it('does not let one tenant block the other', async () => {
    await seedBothTenantsST()
    await unfinished('MANUFACTURING', minutesBefore(5))
    const result = await sync([feedRow()], { tenant: 'GOLIVE' }).result
    expect(result.imported).toBe(1)
  })

  it('is not blocked by an unfinished BILLS run', async () => {
    await seedBothTenantsST()
    await testDb.syncRun.create({
      data: { mode: 'BILLS', tenant: 'GOLIVE', startedAt: minutesBefore(5), finishedAt: null, trigger: 'SCHEDULED' },
    })
    const result = await sync([feedRow()]).result
    expect(result.imported).toBe(1)
  })

  it('is not blocked by an unfinished BILL_REFS run', async () => {
    await seedBothTenantsST()
    await testDb.syncRun.create({
      data: { mode: 'BILL_REFS', tenant: 'GOLIVE', startedAt: minutesBefore(5), finishedAt: null, trigger: 'SCHEDULED' },
    })
    const result = await sync([feedRow()]).result
    expect(result.imported).toBe(1)
  })

  it('takes the in-progress window as a parameter', async () => {
    await seedBothTenantsST()
    await unfinished('GOLIVE', minutesBefore(5))
    const result = await sync([feedRow()], { inProgressMinutes: 2 }).result
    expect(result.imported).toBe(1)
  })
})
