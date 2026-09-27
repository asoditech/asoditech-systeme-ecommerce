-- CreateTable
CREATE TABLE "product_publications" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "productId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedById" TEXT,
    "publishedByName" TEXT,

    CONSTRAINT "product_publications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_publications_productId_idx" ON "product_publications"("productId");

-- CreateIndex
CREATE INDEX "product_publications_tenantId_idx" ON "product_publications"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "product_publications_tenantId_productId_provider_key" ON "product_publications"("tenantId", "productId", "provider");

-- AddForeignKey
ALTER TABLE "product_publications" ADD CONSTRAINT "product_publications_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_publications" ADD CONSTRAINT "product_publications_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_publications" ADD CONSTRAINT "product_publications_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS — identical policy shape to every other tenant-scoped table
-- (docs/adr/0026). Default-deny: no GUC set => zero rows.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "product_publications" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE "product_publications" FORCE ROW LEVEL SECURITY';
  EXECUTE $p$CREATE POLICY "tenant_isolation" ON "product_publications"
    USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
    WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))$p$;
END $$;
