-- « Suivi » module — a NEW centralised tracking view alongside the
-- existing delivery module. See docs/adr/0033-tracking-module.md.
--
-- Additive only: five nullable columns on `shipments`, populated solely by
-- the new /livraison/suivi refresh flow (adapter FETCH_TRACKING). The
-- existing delivery, status-sync, cost, invoice and report paths do not
-- read or write any of them.

ALTER TABLE "shipments" ADD COLUMN "trackingEvents" JSONB;
ALTER TABLE "shipments" ADD COLUMN "courierName" TEXT;
ALTER TABLE "shipments" ADD COLUMN "courierPhone" TEXT;
ALTER TABLE "shipments" ADD COLUMN "lastTrackingSyncAt" TIMESTAMP(3);
ALTER TABLE "shipments" ADD COLUMN "trackingSyncError" TEXT;
