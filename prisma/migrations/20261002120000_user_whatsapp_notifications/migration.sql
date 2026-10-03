-- WhatsApp critical notifications V1 (docs/adr/0058).
-- Additive, nullable columns only: no backfill, every existing user stays opted out.
ALTER TABLE "users"
  ADD COLUMN "whatsappPhone" TEXT,
  ADD COLUMN "whatsappVerifiedAt" TIMESTAMP(3),
  ADD COLUMN "whatsappOptInAt" TIMESTAMP(3),
  ADD COLUMN "whatsappVerification" JSONB,
  ADD COLUMN "whatsappDeliveryFailureNotifiedAt" TIMESTAMP(3);
