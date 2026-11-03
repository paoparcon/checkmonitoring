-- Client, 2026-10-22: "add in the options OTHERS" - any receipt reference that is
-- not an OR, CR, AR, PR or SI. One more value on the stored type; nothing is
-- rewritten and no existing row changes.
--
-- Postgres cannot drop an enum value, so this is forward-fix only: older code
-- must not run once a row carries it.
ALTER TYPE "ReceiptType" ADD VALUE IF NOT EXISTS 'OTHERS';
