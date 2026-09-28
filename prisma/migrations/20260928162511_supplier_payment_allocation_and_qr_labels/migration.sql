-- AlterTable
ALTER TABLE "product_variations" ADD COLUMN     "qrToken" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "qrToken" TEXT;

-- AlterTable
ALTER TABLE "supplier_payments" ADD COLUMN     "paymentGroupId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "product_variations_qrToken_key" ON "product_variations"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "products_qrToken_key" ON "products"("qrToken");

-- CreateIndex
CREATE INDEX "supplier_payments_paymentGroupId_idx" ON "supplier_payments"("paymentGroupId");

