-- OTHER PAYMENTS (2026-11-20, user: payments to foreign suppliers and other
-- forms - DP at sight, Letter of Credit, Manager's check, Telegraphic).
--
-- "OtherPayment": one Acumatica payment document whose method is not a check
-- here, keyed by its own reference (the CV number) within a tenant. Not a
-- "Check" on purpose: no check number, no signature, no release, no portal.
-- The Acumatica columns are the sync's; "marking" and what follows are typed
-- by Finance. Rows are never deleted.
CREATE TYPE "PaymentMarking" AS ENUM ('ON_PROCESS', 'PROCESSED', 'CLEARED');

CREATE TABLE "OtherPayment" (
    "id" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "referenceNbr" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "docType" TEXT,
    "acumaticaStatus" TEXT,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "paymentDate" TIMESTAMP(3),
    "paymentRef" TEXT,
    "amount" DECIMAL(18,2),
    "currency" TEXT,
    "vendorCode" TEXT,
    "payeeName" TEXT,
    "description" TEXT,
    "cashAccount" TEXT,
    "branch" TEXT,
    "companyCode" TEXT,
    "lastModifiedOn" TIMESTAMP(3),
    "marking" "PaymentMarking" NOT NULL DEFAULT 'ON_PROCESS',
    "markedById" TEXT,
    "markedAt" TIMESTAMP(3),
    "processedDate" TIMESTAMP(3),
    "clearedDate" TIMESTAMP(3),
    "bankReference" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OtherPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OtherPayment_tenant_referenceNbr_key" ON "OtherPayment"("tenant", "referenceNbr");
CREATE INDEX "OtherPayment_method_idx" ON "OtherPayment"("method");
CREATE INDEX "OtherPayment_marking_idx" ON "OtherPayment"("marking");

ALTER TABLE "OtherPayment" ADD CONSTRAINT "OtherPayment_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
