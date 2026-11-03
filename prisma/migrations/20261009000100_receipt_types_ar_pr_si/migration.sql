-- The supplier's paper is not always an OR or a CR (client, 2026-10-09: "include
-- in the option AR/PR/SI"): an Acknowledgement Receipt, a Provisional Receipt or
-- a Sales Invoice can stand in. Three more values on the stored type; nothing
-- is rewritten and no existing row changes.
--
-- Postgres cannot drop an enum value, so this is forward-fix only: older code
-- must not run once a row carries one of these.
ALTER TYPE "ReceiptType" ADD VALUE IF NOT EXISTS 'AR';
ALTER TYPE "ReceiptType" ADD VALUE IF NOT EXISTS 'PR';
ALTER TYPE "ReceiptType" ADD VALUE IF NOT EXISTS 'SI';
