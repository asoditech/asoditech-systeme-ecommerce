-- AlterTable
ALTER TABLE "product_variations" ADD COLUMN     "imageUrl" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "salePrice" DECIMAL(12,2);
