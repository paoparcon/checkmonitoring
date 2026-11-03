-- AGING (spec 2026-10-15): each AP bill's due date and terms, mirrored from
-- Acumatica by the BILL_REFS read. Reference data; no FK to "Check".
CREATE TABLE "AcumaticaBillTerms" (
    "apvNumber" TEXT NOT NULL,
    "tenant" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "termsCode" TEXT,
    "lastModifiedOn" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AcumaticaBillTerms_pkey" PRIMARY KEY ("apvNumber")
);
