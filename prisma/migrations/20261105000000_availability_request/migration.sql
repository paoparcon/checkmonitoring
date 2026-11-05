-- Availability changes are approved by one person (spec
-- 2026-11-05-availability-approval-design.md).
--
-- A Finance user's MARK READY FOR RELEASE or REVERT TO SIGNED becomes a row
-- here when an approver is set in `approval.availabilityApprover` and the actor
-- is not that approver. The check does not move while the row is PENDING;
-- approval applies the domain action as the approver. Rows are never deleted.
CREATE TYPE "AvailabilityRequestKind" AS ENUM ('MAKE_AVAILABLE', 'WITHDRAW');
CREATE TYPE "AvailabilityRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "AvailabilityRequest" (
    "id" TEXT NOT NULL,
    "checkId" TEXT NOT NULL,
    "kind" "AvailabilityRequestKind" NOT NULL,
    "status" "AvailabilityRequestStatus" NOT NULL DEFAULT 'PENDING',
    "pendingKey" TEXT,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "availablePickupDate" TIMESTAMP(3),
    "reason" TEXT,
    "source" JSONB,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "AvailabilityRequest_pkey" PRIMARY KEY ("id")
);

-- At most ONE pending request per check: "pendingKey" is 'PENDING' while open
-- and null once decided, and Postgres treats nulls as distinct. (A partial
-- unique index would say the same, but Prisma cannot declare one and the next
-- generated migration would drop it.)
CREATE UNIQUE INDEX "AvailabilityRequest_checkId_pendingKey_key" ON "AvailabilityRequest"("checkId", "pendingKey");
CREATE INDEX "AvailabilityRequest_status_requestedAt_idx" ON "AvailabilityRequest"("status", "requestedAt");
CREATE INDEX "AvailabilityRequest_requestedById_idx" ON "AvailabilityRequest"("requestedById");

-- RESTRICT: a check or a user with approval history stays referenced, as
-- every other record of who did what does here (rule 6).
ALTER TABLE "AvailabilityRequest" ADD CONSTRAINT "AvailabilityRequest_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AvailabilityRequest" ADD CONSTRAINT "AvailabilityRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AvailabilityRequest" ADD CONSTRAINT "AvailabilityRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
