-- Notifications become one row per recipient (spec 2026-10-16-notifications-design.md).
-- The table has never been written by any code path (git log -S and grep,
-- 2026-10-16), so it is cleared first: adding the required "userId" to a table
-- with rows in it would fail.
DELETE FROM "Notification";

-- AlterTable
ALTER TABLE "Notification" DROP COLUMN "type",
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL,
ADD COLUMN     "link" TEXT,
ADD COLUMN     "userId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

