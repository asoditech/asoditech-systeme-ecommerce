-- AlterTable
ALTER TABLE "customers" ADD COLUMN "isBlacklisted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "blacklistedAt" TIMESTAMP(3),
ADD COLUMN "blacklistReason" TEXT;
