"use server";

import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { runWithTenant } from "@/lib/tenant/context";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { findUsableInvitation } from "@/lib/auth/token-lookup";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";
import { recordAuditEvent } from "@/lib/audit";
import { sendInvitationEmail } from "@/lib/email";
import { withSeatLimit, PlanLimitReachedError } from "@/lib/entitlements/checks";
import { getTenantUsage } from "@/lib/entitlements/usage";
import { checkAndNotifyUsageThreshold } from "@/lib/entitlements/alerts";
import { inviteUserSchema } from "@/lib/validation/user";
import { acceptInvitationSchema } from "@/lib/validation/auth";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { isGlobalRole } from "@/lib/auth/effective-access";
import type { InvitationChannelScope } from "@prisma/client";
import type { PrismaTransactionClient } from "@/lib/prisma";

// Phase 5 (docs/adr/0027-tenant-provisioning.md) — tenant-scoped user
// provisioning by invitation, replacing the old "OWNER picks a temporary
// password" flow entirely. `inviteUserAction`/`revokeInvitationAction` run
// inside the inviter's own tenant (`requirePermissionForAction` + the
// Phase 2-4 extension/RLS scope every query to it automatically — no
// explicit tenantId check needed anywhere in this file).

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const GENERIC_INVALID_INVITATION = "Cette invitation n'est plus valide.";

/**
 * Invite an email to join the caller's own tenant at a given role. Only
 * OWNER may invite another OWNER — the same privilege-escalation guard
 * `updateUserRoleAction` already enforces for role changes.
 */
export async function inviteUserAction(formData: FormData): Promise<ActionResult<IdResult & { inviteUrl: string }>> {
  const actor = await requirePermissionForAction("users.manage");

  const rawChannelScope = formData.get("channelScope");
  const parsed = inviteUserSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role"),
    // The form only ever sends a real value when the picker was shown —
    // an empty string (nothing selected / picker hidden) means "no explicit
    // choice", same as omitting the field entirely.
    channelScope: typeof rawChannelScope === "string" && rawChannelScope.length > 0 ? rawChannelScope : undefined,
    offlineChannelIds: formData.getAll("offlineChannelIds").filter((v): v is string => typeof v === "string" && v.length > 0),
    warehouseIds: formData.getAll("warehouseIds").filter((v): v is string => typeof v === "string" && v.length > 0),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }
  if (parsed.data.role === "OWNER" && actor.role !== "OWNER") {
    return actionError("Seul le propriétaire peut inviter un autre propriétaire.");
  }
  // Phase 4B (docs/adr/0043): STORE_SELLER holds only in-store permissions,
  // which are inert without the `offlineSales` capability (ADR 0041) — an
  // ONLINE_ONLY tenant would get a login that can do nothing. Refused here,
  // not just hidden in the form.
  if (parsed.data.role === "STORE_SELLER" && !actor.capabilities.has("offlineSales")) {
    return actionError("Le rôle Vendeur magasin n'est disponible que pour un espace « En ligne + Magasin ».");
  }

  // Invite-time business scope (Phase 2): meaningless for a global role —
  // OWNER/ADMIN bypass UserChannel entirely (docs/adr/0039) — so it is
  // silently dropped for one rather than rejecting the whole invitation
  // over a harmless mismatched field (the form itself hides the picker
  // for OWNER/ADMIN; this is the server-side backstop for a direct call).
  // For a non-global role, OFFLINE/BOTH requires the `storeChannels`
  // capability (ADR 0041) — an ONLINE_ONLY tenant has no Offline channel
  // to assign, so this is rejected explicitly rather than silently
  // downgraded to ONLINE, matching this codebase's existing convention
  // for an unavailable-capability request (see setUserPermissionOverridesAction).
  let channelScope: InvitationChannelScope | null = null;
  if (!isGlobalRole(parsed.data.role) && parsed.data.channelScope) {
    if (
      (parsed.data.channelScope === "OFFLINE" || parsed.data.channelScope === "BOTH") &&
      !actor.capabilities.has("storeChannels")
    ) {
      return actionError("La portée Magasin n'est pas disponible dans le mode d'activité de votre espace.");
    }
    if ((parsed.data.channelScope === "OFFLINE" || parsed.data.channelScope === "BOTH") && actor.capabilities.has("storeChannels")) {
      const hasOfflineChannel = await prisma.salesChannel.findFirst({ where: { kind: "OFFLINE", isActive: true }, select: { id: true } });
      if (!hasOfflineChannel) {
        return actionError(
          "Aucun canal magasin actif n'existe pour ce tenant — créez-en un depuis Paramètres → Canaux de vente avant d'inviter un utilisateur avec la portée Magasin."
        );
      }
    }
    channelScope = parsed.data.channelScope;
  }

  // Invite-time precision (docs/adr/0047): the exact store channel(s) and
  // location(s) the account starts with, instead of "every OFFLINE channel,
  // no location". Optional and additive — empty lists keep the legacy
  // behaviour. Dropped for a global role (it needs no row), exactly like
  // `channelScope`. Every id must be a live row of THIS tenant (tenant-scoped
  // client): an unknown / foreign / inactive id rejects the invitation rather
  // than being silently ignored, so the inviter never believes a scope was
  // applied when it wasn't. Re-validated again at accept time.
  const offlineChannelIds = [...new Set(parsed.data.offlineChannelIds)];
  const warehouseIds = [...new Set(parsed.data.warehouseIds)];
  const precise = !isGlobalRole(parsed.data.role);
  if (precise && offlineChannelIds.length > 0) {
    if (channelScope !== "OFFLINE" && channelScope !== "BOTH") {
      return actionError("Un canal magasin ne peut être choisi qu'avec la portée « Magasin » ou « En ligne + Magasin ».");
    }
    const valid = await prisma.salesChannel.count({ where: { id: { in: offlineChannelIds }, kind: "OFFLINE", isActive: true } });
    if (valid !== offlineChannelIds.length) return actionError("Un canal magasin choisi est introuvable ou inactif.");
  }
  if (precise && warehouseIds.length > 0) {
    const valid = await prisma.warehouse.count({ where: { id: { in: warehouseIds }, isActive: true } });
    if (valid !== warehouseIds.length) return actionError("Un emplacement choisi est introuvable ou inactif.");
  }

  // Early, informative check — not the authoritative enforcement point
  // (that's the actual seat-limit lock in acceptInvitationAction, which
  // is race-safe under concurrent accepts). This one just avoids sending
  // an invitation that would fail at acceptance time, by warning the
  // inviter immediately instead.
  const seatUsage = await getTenantUsage(actor.tenantId);
  if (seatUsage.users.limit !== null && seatUsage.users.used >= seatUsage.users.limit) {
    return actionError(
      `Votre forfait est limité à ${seatUsage.users.limit} utilisateur${seatUsage.users.limit > 1 ? "s" : ""} actif${seatUsage.users.limit > 1 ? "s" : ""} ` +
        `(${seatUsage.users.used}/${seatUsage.users.limit} déjà utilisés). Passez à un forfait supérieur pour inviter davantage de membres.`
    );
  }

  const existingUser = await prisma.user.findFirst({ where: { email: parsed.data.email } });
  if (existingUser) {
    return actionError("Un utilisateur avec cet e-mail existe déjà.", { email: ["E-mail déjà utilisé."] });
  }

  // At most one live invitation per (tenant, email) — revoke any prior
  // pending one rather than leaving two valid tokens outstanding.
  await prisma.invitation.updateMany({
    where: { email: parsed.data.email, status: "PENDING" },
    data: { status: "REVOKED" },
  });

  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);

  let invitation;
  try {
    invitation = await prisma.invitation.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name,
        role: parsed.data.role,
        channelScope,
        offlineChannelIds: precise ? offlineChannelIds : [],
        warehouseIds: precise ? warehouseIds : [],
        tokenHash,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: actor.id,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // tokenHash collision — astronomically unlikely (256-bit random);
      // treat as a transient failure the caller can retry.
      return actionError("Une erreur est survenue, veuillez réessayer.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "invitation.created",
    entityType: "Invitation",
    entityId: invitation.id,
    newValue: {
      email: invitation.email,
      role: invitation.role,
      channelScope: invitation.channelScope,
      offlineChannelIds: invitation.offlineChannelIds,
      warehouseIds: invitation.warehouseIds,
    },
  });

  const inviteUrl = `/invitations/${rawToken}`;
  await sendInvitationEmail({ to: invitation.email, inviteeName: invitation.name, role: invitation.role, inviteUrl });

  revalidatePath("/utilisateurs");
  return actionOk({ id: invitation.id, inviteUrl });
}

/**
 * The choices the invite form offers for invite-time precision
 * (docs/adr/0047): this tenant's active store channels — with the locations
 * each one sells from (SalesChannelLocation) — and its active locations.
 * `users.manage`-gated like the invitation itself; store channels only when
 * the tenant's mode has them (ADR 0041).
 */
export async function listInvitationScopeOptionsAction(): Promise<{
  offlineChannels: { id: string; name: string; warehouseIds: string[] }[];
  warehouses: { id: string; name: string; type: "ENTREPOT" | "MAGASIN" }[];
}> {
  const actor = await requirePermissionForAction("users.manage");
  const [channels, warehouses] = await Promise.all([
    actor.capabilities.has("storeChannels")
      ? prisma.salesChannel.findMany({
          where: { kind: "OFFLINE", isActive: true },
          orderBy: { name: "asc" },
          select: { id: true, name: true, locations: { where: { warehouse: { isActive: true } }, select: { warehouseId: true } } },
        })
      : Promise.resolve([]),
    prisma.warehouse.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);
  return {
    offlineChannels: channels.map((c) => ({ id: c.id, name: c.name, warehouseIds: c.locations.map((l) => l.warehouseId) })),
    warehouses,
  };
}

export async function revokeInvitationAction(formData: FormData): Promise<ActionResult<undefined>> {
  const actor = await requirePermissionForAction("users.manage");
  const id = formData.get("id");
  if (typeof id !== "string" || !id) return actionError("Invitation invalide.");

  const existing = await prisma.invitation.findUnique({ where: { id } });
  if (!existing) return actionError("Invitation introuvable.");
  if (existing.status !== "PENDING") return actionError("Cette invitation n'est plus en attente.");

  await prisma.invitation.update({ where: { id }, data: { status: "REVOKED" } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "invitation.revoked",
    entityType: "Invitation",
    entityId: existing.id,
    metadata: { email: existing.email },
  });

  revalidatePath("/utilisateurs");
  return actionOk(undefined);
}

/**
 * The real `SalesChannel` id(s) an invitation's chosen `channelScope`
 * resolves to, AT ACCEPT TIME (Phase 2). `null` (no explicit choice) keeps
 * the exact pre-Phase-2 behavior: the tenant's default ONLINE channel only.
 * OFFLINE resolves to every currently-active OFFLINE channel — there is no
 * "default store channel" concept (only ONLINE has one, deliberately, per
 * the SalesChannel.isDefault doc comment), and inventing one here would be
 * exactly the "new model" this phase is told not to introduce. If none
 * exists at accept time (one existed at invite time but was retired since,
 * or `inviteUserAction`'s own check was raced), the user simply ends up
 * with zero OFFLINE channels — the existing safe-default-deny philosophy
 * (zero rows = zero access), never a fabricated one.
 */
async function resolveInvitationChannelIds(
  tx: PrismaTransactionClient,
  channelScope: InvitationChannelScope | null,
  explicitOfflineIds: readonly string[]
): Promise<string[]> {
  if (!channelScope) {
    const defaultChannel = await ensureDefaultOnlineChannel(tx);
    return [defaultChannel.id];
  }
  const ids: string[] = [];
  if (channelScope === "ONLINE" || channelScope === "BOTH") {
    const online = await ensureDefaultOnlineChannel(tx);
    ids.push(online.id);
  }
  if (channelScope === "OFFLINE" || channelScope === "BOTH") {
    // Explicit store channel(s) chosen at invite time (docs/adr/0047): exactly
    // those that are still active OFFLINE channels of this tenant — never the
    // "every OFFLINE channel" fallback, even if all of them were retired since
    // (zero rows = zero access).
    const offlineChannels = await tx.salesChannel.findMany({
      where: {
        kind: "OFFLINE",
        isActive: true,
        ...(explicitOfflineIds.length > 0 ? { id: { in: [...explicitOfflineIds] } } : {}),
      },
      select: { id: true },
    });
    ids.push(...offlineChannels.map((c) => c.id));
  }
  return ids;
}

/**
 * Public — no session. Looked up by the token's hash across every tenant
 * (`runUnscoped`, exactly like login's email lookup — the tenant isn't
 * known until the token resolves one), then the User row is created
 * pinned to the invitation's own tenant (`runWithTenant`).
 */
export async function acceptInvitationAction(
  _prevState: ActionResult<undefined> | undefined,
  formData: FormData
): Promise<ActionResult<undefined>> {
  const parsed = acceptInvitationSchema.safeParse({
    token: formData.get("token"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const found = await findUsableInvitation(parsed.data.token);
  if (!found) {
    return actionError(GENERIC_INVALID_INVITATION);
  }
  const { invitation, usable } = found;
  if (!usable) {
    await runWithTenant(invitation.tenantId, "invitation:accept", () =>
      recordAuditEvent({
        actorType: "SYSTEM",
        action: "invitation.expired_or_invalid_use_attempt",
        entityType: "Invitation",
        entityId: invitation.id,
        metadata: { status: invitation.status },
      })
    );
    return actionError(GENERIC_INVALID_INVITATION);
  }

  // The whole create-if-under-limit unit of work is wrapped in
  // `withSeatLimit` — it locks the tenant row and re-counts ACTIVE users
  // inside one transaction, so two invitees accepting at the same instant
  // can never both slip past the plan's seat limit (docs/adr/0035
  // "Limit behaviour"). This is the AUTHORITATIVE check; `inviteUserAction`
  // above only gives the inviter an early warning.
  let seatLimitError: PlanLimitReachedError | null = null;
  const user = await runWithTenant(invitation.tenantId, "invitation:accept", async () => {
    try {
      return await withSeatLimit(invitation.tenantId, "users", async (tx) => {
        // Race guard: another request could have accepted a DIFFERENT
        // invitation for this same email in the tiny window since the
        // check above (composite unique also backstops this at the DB
        // level).
        const already = await tx.user.findFirst({ where: { email: invitation.email } });
        if (already) return null;

        const created = await tx.user.create({
          data: {
            email: invitation.email,
            name: invitation.name,
            role: invitation.role,
            passwordHash: await hashPassword(parsed.data.password),
            status: "ACTIVE",
          },
        });

        // Channel scope (docs/adr/0039, widened by Phase 2's invite-time
        // scope): OWNER/ADMIN need no row (global by role — bypass
        // UserChannel entirely). Everyone else gets exactly what the
        // inviter chose (`invitation.channelScope`), resolved to real
        // channel ids NOW rather than at invite time, so a channel
        // created/retired in between is reflected correctly. No explicit
        // choice (legacy invitation, or the inviter left it unset) falls
        // back to the original pre-Phase-2 behavior unchanged: the
        // tenant's default ONLINE channel only.
        if (!isGlobalRole(created.role)) {
          const channelIds = await resolveInvitationChannelIds(tx, invitation.channelScope, invitation.offlineChannelIds);
          if (channelIds.length > 0) {
            await tx.userChannel.createMany({
              data: channelIds.map((salesChannelId) => ({ userId: created.id, salesChannelId })),
              skipDuplicates: true,
            });
          }

          // Locations chosen at invite time (docs/adr/0047) — the same
          // UserLocation rows `setUserLocationsAction` writes, restricted to
          // warehouses that are still active in this tenant. None chosen →
          // none assigned, exactly as before (docs/adr/0037 §8).
          if (invitation.warehouseIds.length > 0) {
            const warehouses = await tx.warehouse.findMany({
              where: { id: { in: invitation.warehouseIds }, isActive: true },
              select: { id: true },
            });
            if (warehouses.length > 0) {
              await tx.userLocation.createMany({
                data: warehouses.map((w) => ({ userId: created.id, warehouseId: w.id, createdById: invitation.invitedById })),
                skipDuplicates: true,
              });
            }
          }
        }

        await tx.invitation.update({
          where: { id: invitation.id },
          data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: created.id },
        });

        await recordAuditEvent(
          {
            actorType: "USER",
            actorUserId: created.id,
            action: "invitation.accepted",
            entityType: "Invitation",
            entityId: invitation.id,
            newValue: { userId: created.id },
          },
          tx
        );
        await recordAuditEvent(
          {
            actorType: "USER",
            actorUserId: created.id,
            action: "user.created",
            entityType: "User",
            entityId: created.id,
            newValue: { email: created.email, role: created.role },
            metadata: { via: "invitation", invitationId: invitation.id },
          },
          tx
        );

        return created;
      });
    } catch (error) {
      if (error instanceof PlanLimitReachedError) {
        seatLimitError = error;
        return null;
      }
      throw error;
    }
  });

  if (seatLimitError) {
    const e: PlanLimitReachedError = seatLimitError;
    await runWithTenant(invitation.tenantId, "invitation:accept", () =>
      recordAuditEvent({
        actorType: "SYSTEM",
        action: "invitation.expired_or_invalid_use_attempt",
        entityType: "Invitation",
        entityId: invitation.id,
        metadata: { reason: "plan_limit_reached", limit: e.limit, current: e.current },
      })
    );
    return actionError(
      "Le forfait de cette entreprise a atteint sa limite d'utilisateurs actifs. " +
        "Contactez le propriétaire du compte pour mettre à niveau le forfait avant d'accepter cette invitation."
    );
  }

  if (!user) {
    return actionError("Un compte existe déjà pour cette adresse e-mail.");
  }

  const usage = await getTenantUsage(invitation.tenantId);
  await checkAndNotifyUsageThreshold(invitation.tenantId, "USERS", usage.users);

  await createSession(user.id);
  redirect("/tableau-de-bord");
}
