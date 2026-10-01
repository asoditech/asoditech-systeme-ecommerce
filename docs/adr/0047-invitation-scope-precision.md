# ADR 0047 — Invite-time channel and location precision

## Status
Accepted (2026-09-30). Extends ADR 0039 (channel scope), ADR 0037 (location
access) and ADR 0043 (store seller). One additive migration
(`20260930200000_invitation_scope_precision`).

## Context
An invitation recorded only a channel *kind* (`channelScope`). At acceptance,
« Magasin » resolved to **every** active OFFLINE channel and no location was
assigned (ADR 0037 §8). For a store seller in a multi-store tenant this meant:
until an admin edited the account, the seller could read every store's sales
(sale reads are channel-scoped) and could not sell anywhere (no location).

## Decision
- `Invitation` gains two id lists, `offlineChannelIds` and `warehouseIds`,
  both defaulting to `[]`. The invite form offers the tenant's active store
  channels and locations; for a seller, only locations mapped to the chosen
  channels.
- **Invite time:** every id must be a live row of the inviter's tenant (an
  active OFFLINE channel, an active warehouse). An invalid id rejects the
  invitation. Store channels require a « Magasin » or « En ligne + Magasin »
  scope. Both lists are dropped for OWNER/ADMIN, like `channelScope`.
- **Accept time:** the ids are re-resolved through the tenant-scoped client.
  Explicit channels → exactly those still active (possibly none — never the
  "every channel" fallback). Explicit locations → `UserLocation` rows for those
  still active. The rows are the same ones `setUserChannelsAction` /
  `setUserLocationsAction` write.
- **Backward compatible:** empty lists (every pre-existing invitation) keep
  the legacy behaviour exactly.
- Unchanged: effective access `(role ∪ GRANT) − DENY` → channel scope → tenant
  mode, the role matrix, STORE_SELLER permissions, `users.manage`. No
  GRANT/DENY at invitation (no business requirement yet).

## Store Manager
No new role: MANAGER + « Magasin » scope + the store's channel and location(s)
chosen here, then the DENY template of ADR 0048 (`STORE_MANAGER_DENIES`).

## Consequences
- A seller invited to one store sells there right after acceptance and sees
  only that store's channel — provided each store has its own OFFLINE channel.
  Sale reads stay channel-scoped: a channel deliberately shared by several
  stores is visible across them (writes remain location-checked).
