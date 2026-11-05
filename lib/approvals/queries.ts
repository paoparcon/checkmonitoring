import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

const include = {
  check: { select: { id: true, checkNumber: true, payeeName: true, amount: true, currency: true, status: true, company: { select: { code: true } } } },
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} satisfies Prisma.AvailabilityRequestInclude

export type RequestRow = Prisma.AvailabilityRequestGetPayload<{ include: typeof include }>

/** The checks a request names, serialisable for a client component (Decimal → string). */
export type RequestView = {
  id: string
  kind: 'MAKE_AVAILABLE' | 'WITHDRAW'
  status: 'PENDING' | 'APPROVED' | 'REJECTED'
  checkId: string
  checkNumber: string | null
  payeeName: string | null
  amount: string | null
  currency: string
  company: string
  /** The check's status NOW, so a stale request shows as such before APPROVE refuses it. */
  checkStatus: string
  pickupDay: string | null
  reason: string | null
  requestedBy: string
  requestedAt: Date
  decidedBy: string | null
  decidedAt: Date | null
  decisionNote: string | null
  fromUpload: string | null
}

export function toRequestView(r: RequestRow): RequestView {
  const source = r.source as { file?: string } | null
  return {
    id: r.id, kind: r.kind, status: r.status,
    checkId: r.check.id, checkNumber: r.check.checkNumber, payeeName: r.check.payeeName,
    amount: r.check.amount?.toFixed(2) ?? null, currency: r.check.currency, company: r.check.company.code,
    checkStatus: r.check.status,
    pickupDay: r.availablePickupDate?.toISOString().slice(0, 10) ?? null, reason: r.reason,
    requestedBy: r.requestedBy.name, requestedAt: r.requestedAt,
    decidedBy: r.decidedBy?.name ?? null, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
    fromUpload: source?.file ?? null,
  }
}

/** Every open request, oldest first — the order they should be decided in. */
export async function listPendingRequests(db: Db): Promise<RequestView[]> {
  const rows = await db.availabilityRequest.findMany({ where: { status: 'PENDING' }, include, orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }] })
  return rows.map(toRequestView)
}

/** The latest decisions, newest first. */
export async function listDecidedRequests(db: Db, limit = 50): Promise<RequestView[]> {
  const rows = await db.availabilityRequest.findMany({
    where: { status: { not: 'PENDING' } }, include, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], take: limit,
  })
  return rows.map(toRequestView)
}

export async function countPendingRequests(db: Db): Promise<number> {
  return db.availabilityRequest.count({ where: { status: 'PENDING' } })
}

/** The one open request on a check, if any (the schema allows at most one). */
export async function pendingRequestFor(db: Db, checkId: string): Promise<RequestView | null> {
  const row = await db.availabilityRequest.findFirst({ where: { checkId, status: 'PENDING' }, include })
  return row ? toRequestView(row) : null
}
