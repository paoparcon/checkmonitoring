-- Self-registration with admin approval (spec 2026-10-09-self-registration-design.md).
--
-- `pendingSince` marks an account created or re-opened from /signup that no
-- admin has approved or rejected yet. Pending = inactive AND pendingSince set.
-- An inactive account with it null is deactivated, exactly as before, so no
-- existing row changes meaning.
ALTER TABLE "User" ADD COLUMN "pendingSince" TIMESTAMP(3);

-- The registration throttle's counter. A table for the same reason
-- "LoginAttempt" is one: Vercel is serverless, a module-scope Map is
-- per-instance and starts at zero on every cold start. No FK to "User" —
-- a refused submission names no account.
CREATE TABLE "RegistrationAttempt" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationAttempt_pkey" PRIMARY KEY ("id")
);

-- The throttle read is (ip, createdAt) inside a rolling hour.
CREATE INDEX "RegistrationAttempt_ip_createdAt_idx" ON "RegistrationAttempt"("ip", "createdAt");
-- The retention prune runs on every write; without this it is a sequential scan.
CREATE INDEX "RegistrationAttempt_createdAt_idx" ON "RegistrationAttempt"("createdAt");
