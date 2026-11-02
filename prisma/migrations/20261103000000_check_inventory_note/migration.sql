-- Finance's check inventory on NUMBERING (spec
-- 2026-10-01-cheque-numbering-and-cancel-guard-design §H, 2026-11-03).
--
-- One row per (check book, number) that Finance has ticked or remarked on —
-- a number the series shows as MISSING, which no "Check" row holds, so the
-- note cannot hang off a check. "runTo" is set when the note was recorded on
-- a run too long to list number by number and stands for the whole run.
-- Rows are never deleted; the history is on "AuditLog"
-- (action inventory_note_recorded, no checkId).
CREATE TABLE "CheckInventoryNote" (
    "id" TEXT NOT NULL,
    "checkBookId" TEXT NOT NULL,
    "checkNumber" TEXT NOT NULL,
    "runTo" TEXT,
    "ticked" BOOLEAN NOT NULL DEFAULT false,
    "remarks" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckInventoryNote_pkey" PRIMARY KEY ("id")
);

-- One note per number in a book; the page reads a book's notes whole.
CREATE UNIQUE INDEX "CheckInventoryNote_checkBookId_checkNumber_key" ON "CheckInventoryNote"("checkBookId", "checkNumber");

-- RESTRICT, not CASCADE: a book or a user with inventory history stays
-- referenced, as every other record of who recorded what does here.
ALTER TABLE "CheckInventoryNote" ADD CONSTRAINT "CheckInventoryNote_checkBookId_fkey" FOREIGN KEY ("checkBookId") REFERENCES "CheckBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CheckInventoryNote" ADD CONSTRAINT "CheckInventoryNote_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
