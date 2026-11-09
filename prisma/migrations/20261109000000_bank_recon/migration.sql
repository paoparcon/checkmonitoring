-- BANK RECON (2026-11-09, user: "we will integrate bank recon").
--
-- "CashLedgerAccount": one line of Finance's CASH schedule (a bank account or
-- a cash fund), keyed by the account number's digits. "CashBalance": that
-- account on one day - the book balance the CASH sheet states, and the bank's
-- figures (statement balance, deposits in transit) Finance types. Outstanding
-- checks are computed, never stored. Rows are never deleted.
CREATE TABLE "CashLedgerAccount" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "companyLabel" TEXT,
    "glAccount" TEXT,
    "description" TEXT,
    "accountNumber" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashLedgerAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CashBalance" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "asOf" DATE NOT NULL,
    "bookBalance" DECIMAL(18,2),
    "bookSource" TEXT,
    "bookRecordedById" TEXT,
    "bookRecordedAt" TIMESTAMP(3),
    "bankBalance" DECIMAL(18,2),
    "depositsInTransit" DECIMAL(18,2),
    "note" TEXT,
    "bankRecordedById" TEXT,
    "bankRecordedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CashBalance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CashLedgerAccount_key_key" ON "CashLedgerAccount"("key");
CREATE UNIQUE INDEX "CashBalance_accountId_asOf_key" ON "CashBalance"("accountId", "asOf");
CREATE INDEX "CashBalance_asOf_idx" ON "CashBalance"("asOf");

-- RESTRICT: a user who recorded a figure stays referenced (rule 6).
ALTER TABLE "CashBalance" ADD CONSTRAINT "CashBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CashLedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashBalance" ADD CONSTRAINT "CashBalance_bookRecordedById_fkey" FOREIGN KEY ("bookRecordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashBalance" ADD CONSTRAINT "CashBalance_bankRecordedById_fkey" FOREIGN KEY ("bankRecordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
