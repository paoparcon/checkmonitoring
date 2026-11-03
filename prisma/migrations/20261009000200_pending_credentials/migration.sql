-- Re-registration of an existing inactive account (spec 2026-10-09, final review): the
-- typed name and password are held aside until an admin approves. `name` is read live
-- wherever a check says who signed or released it, so an anonymous /signup submission
-- must not be able to change it; and the row's own passwordHash must survive a reject so
-- REACTIVATE restores the genuine account.
ALTER TABLE "User" ADD COLUMN "pendingName" TEXT;
ALTER TABLE "User" ADD COLUMN "pendingPasswordHash" TEXT;
