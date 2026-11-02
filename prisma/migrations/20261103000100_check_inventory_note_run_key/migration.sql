-- A note is on one number OR on a run (spec §H, second pass 2026-11-03): the
-- whole-run tick on 174267–174389 and the tick on 174267 itself must be two
-- rows. "runTo" becomes part of the key: '' for a single number, the run's
-- last number for a run. Existing rows: a null "runTo" is a single number.
UPDATE "CheckInventoryNote" SET "runTo" = '' WHERE "runTo" IS NULL;
ALTER TABLE "CheckInventoryNote" ALTER COLUMN "runTo" SET NOT NULL, ALTER COLUMN "runTo" SET DEFAULT '';
DROP INDEX "CheckInventoryNote_checkBookId_checkNumber_key";
CREATE UNIQUE INDEX "CheckInventoryNote_checkBookId_checkNumber_runTo_key" ON "CheckInventoryNote"("checkBookId", "checkNumber", "runTo");
