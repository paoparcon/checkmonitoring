import type { Prisma, PrismaClient, ActorType } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export type AuditInput = {
  checkId?: string
  actorType: ActorType
  userId?: string
  action: string
  details?: Prisma.InputJsonValue
  remarks?: string
}

// The ONLY way audit rows are created. There is deliberately no update or
// delete counterpart: audit history is append-only, and the database revokes
// UPDATE/DELETE for the application role as a second line of defence.
export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.auditLog.create({
    data: {
      checkId: input.checkId,
      actorType: input.actorType,
      userId: input.userId,
      action: input.action,
      details: input.details,
      remarks: input.remarks,
    },
  })
}

/**
 * Several rows in one statement, for a bulk action whose rows are all known
 * before any is written (OTHER PAYMENTS' marking, 2026-11-20). Still append
 * only, and still this module: nothing else creates an audit row.
 */
export async function writeAudits(db: Db, inputs: readonly AuditInput[]): Promise<void> {
  if (inputs.length === 0) return
  await db.auditLog.createMany({
    data: inputs.map((input) => ({
      checkId: input.checkId,
      actorType: input.actorType,
      userId: input.userId,
      action: input.action,
      details: input.details,
      remarks: input.remarks,
    })),
  })
}
