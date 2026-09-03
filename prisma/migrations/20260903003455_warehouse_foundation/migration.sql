-- CreateEnum
CREATE TYPE "WarehouseType" AS ENUM ('ENTREPOT', 'MAGASIN');

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "address" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "type" "WarehouseType" NOT NULL DEFAULT 'ENTREPOT';

-- CreateIndex
CREATE INDEX "inventory_movements_inventoryItemId_createdAt_idx" ON "inventory_movements"("inventoryItemId", "createdAt");

-- CreateIndex
CREATE INDEX "warehouses_isActive_idx" ON "warehouses"("isActive");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
