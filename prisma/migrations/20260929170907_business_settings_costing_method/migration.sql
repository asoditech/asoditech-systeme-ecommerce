-- CreateEnum
CREATE TYPE "CostingMethod" AS ENUM ('MANUAL', 'LAST_COST', 'WEIGHTED_AVERAGE');

-- AlterTable
ALTER TABLE "business_settings" ADD COLUMN     "costingMethod" "CostingMethod" NOT NULL DEFAULT 'MANUAL';

