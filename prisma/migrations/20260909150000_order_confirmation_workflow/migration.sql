-- Order-confirmation call workflow. See docs/adr/0029-order-confirmation-workflow.md.
--
-- A shared queue of NOUVELLE orders that a confirmateur works through:
-- each call attempt is logged with its outcome; CONFIRME / ANNULE move
-- the order on (and CONFIRME auto-credits the caller as the order's
-- confirmation agent when they have a CommissionAgent record and none is
-- set yet). The two denormalised columns on `orders` let the queue sort
-- by "least recently tried" and flag orders past a retry threshold.

-- 1. enum
CREATE TYPE "OrderConfirmationOutcome" AS ENUM ('CONFIRME', 'PAS_DE_REPONSE', 'OCCUPE', 'RAPPELER', 'FAUX_NUMERO', 'ANNULE');

-- 2. orders — denormalised attempt counters
ALTER TABLE "orders" ADD COLUMN "confirmationAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "lastConfirmationAttemptAt" TIMESTAMP(3);
CREATE INDEX "orders_status_lastConfirmationAttemptAt_idx" ON "orders" ("status", "lastConfirmationAttemptAt");

-- 3. order_confirmation_attempts — append-only log
CREATE TABLE "order_confirmation_attempts" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "orderId" TEXT NOT NULL,
    "agentUserId" TEXT,
    "outcome" "OrderConfirmationOutcome" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "order_confirmation_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_confirmation_attempts_orderId_idx" ON "order_confirmation_attempts" ("orderId");
CREATE INDEX "order_confirmation_attempts_agentUserId_idx" ON "order_confirmation_attempts" ("agentUserId");
CREATE INDEX "order_confirmation_attempts_tenantId_idx" ON "order_confirmation_attempts" ("tenantId");

ALTER TABLE "order_confirmation_attempts" ADD CONSTRAINT "order_confirmation_attempts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_confirmation_attempts" ADD CONSTRAINT "order_confirmation_attempts_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_confirmation_attempts" ADD CONSTRAINT "order_confirmation_attempts_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. RLS — same tenant_isolation policy as every other tenant-scoped table
--    (docs/adr/0026-multi-tenant-rls.md).
ALTER TABLE "order_confirmation_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_confirmation_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order_confirmation_attempts"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.tenant_id', true));
