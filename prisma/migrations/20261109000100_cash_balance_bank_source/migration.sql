-- The CASH sheet states the BANK balance, not the book balance (user ruling
-- 2026-11-09: "those are bank balance"). The upload therefore writes
-- "bankBalance" / "bankRecordedById" / "bankRecordedAt" and its source cell,
-- and Finance types "bookBalance" / "depositsInTransit" ("bookRecordedById" /
-- "bookRecordedAt"). Every column already exists under those names except the
-- source cell, which was created as "bookSource". No row exists in production
-- (the table had not been deployed), so nothing is moved.
ALTER TABLE "CashBalance" RENAME COLUMN "bookSource" TO "bankSource";
