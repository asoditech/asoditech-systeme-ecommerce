-- Final refinements (2026-10-12): per-user sidebar favorites + WhatsApp alert
-- mutes, and the tenant opt-in « paiement confirmé par la boutique ».
--
-- Additive only: three new columns with defaults; every existing row keeps
-- today's behavior (no favorites, no muted alert, automatic payment OFF).
-- "users" and "business_settings" are existing tenant-scoped tables already
-- covered by their RLS policies and by the runtime role's privileges — no new
-- table, no new grant.

-- AlterTable
ALTER TABLE "users" ADD COLUMN "whatsappMutedAlerts" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "users" ADD COLUMN "navFavorites" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN "autoPaymentFromStore" BOOLEAN NOT NULL DEFAULT false;
