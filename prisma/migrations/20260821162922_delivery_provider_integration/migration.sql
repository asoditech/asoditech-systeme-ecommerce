-- Phase 22 (delivery provider integration): adds the API-connector fields
-- ShippingProvider needs to hold real carrier credentials/connection state
-- (mirroring Integration's own CONFIGURE/CONNECTE/ERREUR lifecycle via the
-- reused IntegrationStatus enum), the fields Shipment needs to record what
-- an external carrier actually returned (never fabricated), and a
-- replay-protected webhook event ledger scoped to ShippingProvider instead
-- of Integration (delivery providers are deliberately not modeled as an
-- Integration row — see docs/adr/0006-delivery-providers.md). See
-- docs/adr/0012-delivery-provider-integration.md.

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "providerStatusRaw" TEXT;

-- AlterTable
ALTER TABLE "shipping_providers" ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "connectionStatus" "IntegrationStatus",
ADD COLUMN     "credentialsEncrypted" TEXT,
ADD COLUMN     "lastConnectionCheckAt" TIMESTAMP(3),
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "providerKey" TEXT;

-- CreateTable
CREATE TABLE "shipment_webhook_events" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_webhook_events_providerId_topic_idx" ON "shipment_webhook_events"("providerId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_webhook_events_providerId_deliveryId_key" ON "shipment_webhook_events"("providerId", "deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "shipments_providerId_externalId_key" ON "shipments"("providerId", "externalId");

-- AddForeignKey
ALTER TABLE "shipment_webhook_events" ADD CONSTRAINT "shipment_webhook_events_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "shipping_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
