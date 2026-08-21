/*
  Warnings:

  - Added the required column `resource` to the `sync_runs` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "IntegrationStatus" ADD VALUE 'CONFIGURE';

-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'INTERNE';

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'INTERNE';

-- AlterTable
ALTER TABLE "integrations" ADD COLUMN     "lastConnectionCheckAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "externalNumber" TEXT;

-- AlterTable
ALTER TABLE "product_variations" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'INTERNE';

-- AlterTable
ALTER TABLE "refunds" ADD COLUMN     "source" "RecordSource" NOT NULL DEFAULT 'INTERNE';

-- AlterTable
-- `resource` is backfilled to 'INCONNU' for any pre-existing row (this
-- table was unused before this migration — sync never shipped until now —
-- but the backfill keeps the migration safe regardless of environment
-- state) and left NOT NULL with no default going forward, since every
-- future SyncRun must explicitly name its resource.
ALTER TABLE "sync_runs" ADD COLUMN     "itemsImported" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "itemsSkipped" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "itemsUnchanged" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resource" TEXT NOT NULL DEFAULT 'INCONNU',
ADD COLUMN     "triggeredById" TEXT;

ALTER TABLE "sync_runs" ALTER COLUMN "resource" DROP DEFAULT;

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" TEXT,
    "status" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_events_integrationId_topic_idx" ON "webhook_events"("integrationId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_integrationId_deliveryId_key" ON "webhook_events"("integrationId", "deliveryId");

-- CreateIndex
CREATE INDEX "categories_source_externalId_idx" ON "categories"("source", "externalId");

-- CreateIndex
CREATE INDEX "customers_source_externalId_idx" ON "customers"("source", "externalId");

-- CreateIndex
CREATE INDEX "product_variations_source_externalId_idx" ON "product_variations"("source", "externalId");

-- CreateIndex
CREATE INDEX "sync_runs_resource_idx" ON "sync_runs"("resource");

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
