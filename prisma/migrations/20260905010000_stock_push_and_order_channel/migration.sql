-- CreateEnum
CREATE TYPE "OrderChannel" AS ENUM ('TELEPHONE', 'WHATSAPP', 'INSTAGRAM', 'FACEBOOK', 'SITE_WEB', 'AUTRE');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "channel" "OrderChannel";

-- AlterTable
ALTER TABLE "inventory_items" ADD COLUMN "lastPushedQuantity" INTEGER,
ADD COLUMN "lastPushedAt" TIMESTAMP(3);
