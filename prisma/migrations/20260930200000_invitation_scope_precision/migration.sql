-- Invite-time channel/location precision. See docs/adr/0047-invitation-scope-precision.md.
--
-- Fully additive: two id-list columns on "invitations", both defaulting to an
-- empty array. Every existing invitation keeps the empty default, which
-- acceptInvitationAction treats as the legacy behaviour (unchanged). No row is
-- backfilled, no constraint or policy changes (the table's RLS policy is
-- row-level and unaffected by new columns).
ALTER TABLE "invitations" ADD COLUMN "offlineChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "invitations" ADD COLUMN "warehouseIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
