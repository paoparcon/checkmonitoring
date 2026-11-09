-- MONTHLY BANK RECONCILIATION (spec 2026-11-09-monthly-bank-reconciliation-design.md).
--
-- Additive only: new enums and tables, no existing column changed, no row
-- written. A reconciliation account is a CheckBook, else a CashAccount — the
-- rule `accountWhere` already applies — so no bank-account table is created
-- and none is duplicated. Every foreign key is RESTRICT: a check book, cash
-- account, check or user with reconciliation history stays referenced.
--
-- Must reach production BEFORE the deploy that carries it: /recon reads
-- these tables on every request.

-- CreateEnum
CREATE TYPE "ReconPeriodStatus" AS ENUM ('DRAFT', 'FOR_REVIEW', 'FOR_APPROVAL', 'RECONCILED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ReconBalanceSource" AS ENUM ('OPENING', 'CARRIED_FORWARD');

-- CreateEnum
CREATE TYPE "ReconLineKind" AS ENUM ('CHECK', 'BOOK_ENTRY', 'BANK_CHARGE', 'BANK_CREDIT', 'UNIDENTIFIED_DEBIT', 'UNIDENTIFIED_CREDIT', 'BANK_ERROR');

-- CreateEnum
CREATE TYPE "ReconMatchMethod" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReconBookEntryKind" AS ENUM ('DEPOSIT', 'DISBURSEMENT');

-- CreateEnum
CREATE TYPE "ReconAdjustmentSide" AS ENUM ('BANK', 'BOOK');

-- CreateEnum
CREATE TYPE "ReconDirection" AS ENUM ('ADD', 'LESS');

-- CreateEnum
CREATE TYPE "ReconReopenStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReconOpeningBalance" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "checkBookId" TEXT,
    "cashAccountId" TEXT,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "bankBalance" DECIMAL(18,2) NOT NULL,
    "bookBalance" DECIMAL(18,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "supportingDocument" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconOpeningBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconPeriod" (
    "id" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "checkBookId" TEXT,
    "cashAccountId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "status" "ReconPeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "beginningSource" "ReconBalanceSource" NOT NULL,
    "previousPeriodId" TEXT,
    "beginningBankBalance" DECIMAL(18,2) NOT NULL,
    "beginningBookBalance" DECIMAL(18,2) NOT NULL,
    "statementBeginningBalance" DECIMAL(18,2),
    "statementEndingBalance" DECIMAL(18,2),
    "endingBankBalance" DECIMAL(18,2),
    "endingBookBalance" DECIMAL(18,2),
    "adjustedBankBalance" DECIMAL(18,2),
    "adjustedBookBalance" DECIMAL(18,2),
    "difference" DECIMAL(18,2),
    "totalOutstandingChecks" DECIMAL(18,2),
    "totalDepositsInTransit" DECIMAL(18,2),
    "unidentifiedCount" INTEGER,
    "snapshot" JSONB,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ReconPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconStatementLine" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "lineDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "checkNumber" TEXT,
    "debit" DECIMAL(18,2),
    "credit" DECIMAL(18,2),
    "balance" DECIMAL(18,2),
    "sourceFile" TEXT NOT NULL,
    "sourcePlace" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "kind" "ReconLineKind" NOT NULL,
    "matchMethod" "ReconMatchMethod",
    "checkId" TEXT,
    "bookEntryId" TEXT,
    "remarks" TEXT,
    "resolvedPeriodStart" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconBookEntry" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "kind" "ReconBookEntryKind" NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconBookEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconAdjustment" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "accountKey" TEXT NOT NULL,
    "side" "ReconAdjustmentSide" NOT NULL,
    "direction" "ReconDirection" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "resolvedPeriodStart" TIMESTAMP(3),
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconReopenRequest" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "status" "ReconReopenStatus" NOT NULL DEFAULT 'PENDING',
    "pendingKey" TEXT,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "ReconReopenRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReconOpeningBalance_accountKey_key" ON "ReconOpeningBalance"("accountKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReconOpeningBalance_checkBookId_key" ON "ReconOpeningBalance"("checkBookId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconOpeningBalance_cashAccountId_key" ON "ReconOpeningBalance"("cashAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconPeriod_previousPeriodId_key" ON "ReconPeriod"("previousPeriodId");

-- CreateIndex
CREATE INDEX "ReconPeriod_status_idx" ON "ReconPeriod"("status");

-- CreateIndex
CREATE INDEX "ReconPeriod_periodStart_idx" ON "ReconPeriod"("periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ReconPeriod_accountKey_periodStart_key" ON "ReconPeriod"("accountKey", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "ReconStatementLine_checkId_key" ON "ReconStatementLine"("checkId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconStatementLine_bookEntryId_key" ON "ReconStatementLine"("bookEntryId");

-- CreateIndex
CREATE INDEX "ReconStatementLine_periodId_idx" ON "ReconStatementLine"("periodId");

-- CreateIndex
CREATE INDEX "ReconStatementLine_accountKey_kind_idx" ON "ReconStatementLine"("accountKey", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ReconStatementLine_accountKey_fingerprint_key" ON "ReconStatementLine"("accountKey", "fingerprint");

-- CreateIndex
CREATE INDEX "ReconBookEntry_accountKey_entryDate_idx" ON "ReconBookEntry"("accountKey", "entryDate");

-- CreateIndex
CREATE INDEX "ReconBookEntry_periodId_idx" ON "ReconBookEntry"("periodId");

-- CreateIndex
CREATE INDEX "ReconAdjustment_accountKey_side_idx" ON "ReconAdjustment"("accountKey", "side");

-- CreateIndex
CREATE INDEX "ReconAdjustment_periodId_idx" ON "ReconAdjustment"("periodId");

-- CreateIndex
CREATE INDEX "ReconReopenRequest_status_idx" ON "ReconReopenRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ReconReopenRequest_periodId_pendingKey_key" ON "ReconReopenRequest"("periodId", "pendingKey");

-- AddForeignKey
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_checkBookId_fkey" FOREIGN KEY ("checkBookId") REFERENCES "CheckBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_checkBookId_fkey" FOREIGN KEY ("checkBookId") REFERENCES "CheckBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "CashAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_previousPeriodId_fkey" FOREIGN KEY ("previousPeriodId") REFERENCES "ReconPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_submittedById_fkey" FOREIGN KEY ("submittedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ReconPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "Check"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_bookEntryId_fkey" FOREIGN KEY ("bookEntryId") REFERENCES "ReconBookEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconBookEntry" ADD CONSTRAINT "ReconBookEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ReconPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconBookEntry" ADD CONSTRAINT "ReconBookEntry_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconAdjustment" ADD CONSTRAINT "ReconAdjustment_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ReconPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconAdjustment" ADD CONSTRAINT "ReconAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconAdjustment" ADD CONSTRAINT "ReconAdjustment_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconReopenRequest" ADD CONSTRAINT "ReconReopenRequest_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "ReconPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconReopenRequest" ADD CONSTRAINT "ReconReopenRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconReopenRequest" ADD CONSTRAINT "ReconReopenRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one account kind per row, and `accountKey` is that account's id, so
-- the one unique index on (accountKey, …) serves both kinds.
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_one_account"
  CHECK (("checkBookId" IS NULL) <> ("cashAccountId" IS NULL) AND "accountKey" = COALESCE("checkBookId", "cashAccountId"));
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_one_account"
  CHECK (("checkBookId" IS NULL) <> ("cashAccountId" IS NULL) AND "accountKey" = COALESCE("checkBookId", "cashAccountId"));

-- A statement line is a debit or a credit, never both, never neither; a book
-- entry and an adjustment carry a positive amount (the direction says which way).
ALTER TABLE "ReconStatementLine" ADD CONSTRAINT "ReconStatementLine_one_side"
  CHECK ((COALESCE("debit", 0) > 0) <> (COALESCE("credit", 0) > 0));
ALTER TABLE "ReconBookEntry" ADD CONSTRAINT "ReconBookEntry_positive" CHECK ("amount" > 0);
ALTER TABLE "ReconAdjustment" ADD CONSTRAINT "ReconAdjustment_positive" CHECK ("amount" > 0);

-- Periods are calendar months: the 1st, at midnight.
ALTER TABLE "ReconPeriod" ADD CONSTRAINT "ReconPeriod_month_start"
  CHECK (EXTRACT(DAY FROM "periodStart") = 1 AND "periodStart" = date_trunc('day', "periodStart"));
ALTER TABLE "ReconOpeningBalance" ADD CONSTRAINT "ReconOpeningBalance_month_start"
  CHECK (EXTRACT(DAY FROM "effectiveDate") = 1 AND "effectiveDate" = date_trunc('day', "effectiveDate"));
