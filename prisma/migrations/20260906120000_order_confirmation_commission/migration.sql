-- CreateEnum
CREATE TYPE "CommissionEntryType" AS ENUM ('EARNED', 'REVERSED');

-- CreateEnum
CREATE TYPE "CommissionStatementStatus" AS ENUM ('CLOTURE', 'PAYE');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "confirmationAgentId" TEXT;

-- CreateTable
CREATE TABLE "commission_agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ratePerOrder" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'MAD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_entries" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "CommissionEntryType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "rateApplied" DECIMAL(10,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'MAD',
    "note" TEXT,
    "statementId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commission_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_statements" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "periodYear" INTEGER NOT NULL,
    "periodMonth" INTEGER NOT NULL,
    "status" "CommissionStatementStatus" NOT NULL DEFAULT 'CLOTURE',
    "earnedCount" INTEGER NOT NULL DEFAULT 0,
    "reversedCount" INTEGER NOT NULL DEFAULT 0,
    "earnedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reversedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'MAD',
    "note" TEXT,
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "commission_statements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "commission_agents_userId_key" ON "commission_agents"("userId");

-- CreateIndex
CREATE INDEX "commission_entries_agentId_idx" ON "commission_entries"("agentId");

-- CreateIndex
CREATE INDEX "commission_entries_statementId_idx" ON "commission_entries"("statementId");

-- CreateIndex
CREATE INDEX "commission_entries_createdAt_idx" ON "commission_entries"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "commission_entries_orderId_type_key" ON "commission_entries"("orderId", "type");

-- CreateIndex
CREATE INDEX "commission_statements_agentId_idx" ON "commission_statements"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "commission_statements_agentId_periodYear_periodMonth_key" ON "commission_statements"("agentId", "periodYear", "periodMonth");

-- CreateIndex
CREATE INDEX "orders_confirmationAgentId_idx" ON "orders"("confirmationAgentId");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmationAgentId_fkey" FOREIGN KEY ("confirmationAgentId") REFERENCES "commission_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_agents" ADD CONSTRAINT "commission_agents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "commission_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_entries" ADD CONSTRAINT "commission_entries_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "commission_statements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "commission_agents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_statements" ADD CONSTRAINT "commission_statements_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
