-- CreateTable
CREATE TABLE "delivery_city_mappings" (
    "id" TEXT NOT NULL,
    "shippingProviderId" TEXT NOT NULL,
    "localCityKey" TEXT NOT NULL,
    "localCityLabel" TEXT NOT NULL,
    "providerCityId" TEXT NOT NULL,
    "providerCityName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_city_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delivery_city_mappings_shippingProviderId_idx" ON "delivery_city_mappings"("shippingProviderId");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_city_mappings_shippingProviderId_localCityKey_key" ON "delivery_city_mappings"("shippingProviderId", "localCityKey");

-- AddForeignKey
ALTER TABLE "delivery_city_mappings" ADD CONSTRAINT "delivery_city_mappings_shippingProviderId_fkey" FOREIGN KEY ("shippingProviderId") REFERENCES "shipping_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
