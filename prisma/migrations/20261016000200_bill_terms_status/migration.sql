-- AGING (user ruling 2026-10-16): each AP bill's Acumatica Status, so a check whose
-- bills are all Closed (paid) leaves AGING, as the Supplier Portal's aging does.
ALTER TABLE "AcumaticaBillTerms" ADD COLUMN "status" TEXT;
