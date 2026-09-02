-- CreateEnum
CREATE TYPE "DeliveryManifestStatus" AS ENUM ('BROUILLON', 'FINALISE', 'ECHEC');

-- AlterTable
ALTER TABLE "shipments" ADD COLUMN     "manifestId" TEXT;

-- CreateTable
CREATE TABLE "delivery_manifests" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalRef" TEXT,
    "status" "DeliveryManifestStatus" NOT NULL DEFAULT 'BROUILLON',
    "parcelCount" INTEGER NOT NULL DEFAULT 0,
    "documents" JSONB NOT NULL DEFAULT '[]',
    "failedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "delivery_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_manifests_providerId_idx" ON "delivery_manifests"("providerId");

-- CreateIndex
CREATE INDEX "shipments_manifestId_idx" ON "shipments"("manifestId");

-- AddForeignKey
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_manifestId_fkey" FOREIGN KEY ("manifestId") REFERENCES "delivery_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manifests" ADD CONSTRAINT "delivery_manifests_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "shipping_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_manifests" ADD CONSTRAINT "delivery_manifests_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
