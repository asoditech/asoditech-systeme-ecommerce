-- Packing verification (« Emballage » = OrderStatus EN_PREPARATION).
-- Additive only: one enum, three nullable order columns, one settings flag
-- defaulting to false — existing tenants keep today's shipping behaviour.

-- CreateEnum
CREATE TYPE "PackingMethod" AS ENUM ('SCAN', 'MANUAL');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "packedAt" TIMESTAMP(3),
ADD COLUMN     "packedById" TEXT,
ADD COLUMN     "packingMethod" "PackingMethod";

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "packingVerificationRequired" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_packedById_fkey" FOREIGN KEY ("packedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
