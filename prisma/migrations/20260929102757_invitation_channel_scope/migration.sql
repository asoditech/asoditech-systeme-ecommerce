-- CreateEnum
CREATE TYPE "InvitationChannelScope" AS ENUM ('ONLINE', 'OFFLINE', 'BOTH');

-- AlterTable
ALTER TABLE "invitations" ADD COLUMN     "channelScope" "InvitationChannelScope";

