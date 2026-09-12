"use server";

import { revalidatePath } from "next/cache";
import { prisma, prismaBase } from "@/lib/prisma";
import { requirePlatformAdminForAction } from "@/lib/auth/guards";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { destroyAllSessionsForTenant } from "@/lib/auth/session";
import { generateRawToken, hashToken } from "@/lib/auth/tokens";
import { recordAuditEvent } from "@/lib/audit";
import { sendInvitationEmail } from "@/lib/email";
import { createTenantSchema } from "@/lib/validation/tenant";
import { provisionTenantBaseline } from "@/lib/tenant/provision";
import { deleteTenantData, BootstrapTenantDeletionError, TenantNotFoundError } from "@/lib/tenant/delete";
import { BOOTSTRAP_TENANT_ID } from "@/lib/tenant/resolve";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError, isForeignKeyConstraintError } from "@/lib/prisma-errors";

/**
 * Tenant lifecycle — the `/platform` area (Phase 5, docs/adr/0027-tenant-
 * provisioning.md). Every action here is `requirePlatformAdminForAction`-
 * gated: this is the one surface in the app that legitimately operates
 * ACROSS tenants, not the RBAC/permission system every other action uses.
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, same as inviteUserAction

/** Every tenant, newest first, with a cheap user count — for the
 * `/platform` list. Deliberately unscoped: this IS the cross-tenant view. */
export async function listTenantsForPlatform() {
  return runUnscoped("platform:list-tenants", () =>
    prismaBase.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { users: true } } },
    })
  );
}

/**
 * Provisions a brand-new tenant and an invitation for its first OWNER —
 * there is no "set an initial password" path any more (Phase 5): even a
 * tenant's very first user is provisioned by accepting an invite, exactly
 * like every other user in every tenant.
 */
export async function createTenantAction(
  formData: FormData
): Promise<ActionResult<IdResult & { inviteUrl: string }>> {
  const actor = await requirePlatformAdminForAction();

  const parsed = createTenantSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
    ownerName: formData.get("ownerName"),
    ownerEmail: formData.get("ownerEmail"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  let tenant;
  try {
    // `Tenant.id`'s schema default is the literal string "default" — a
    // well-known-singleton convention for the bootstrap tenant only (ADR
    // 0023), never a generator. An explicit id is required for every OTHER
    // tenant, or this create would repeatedly collide with the bootstrap
    // row's own id. The validated, already-unique slug doubles as it.
    tenant = await prismaBase.tenant.create({
      data: { id: parsed.data.slug, name: parsed.data.name, slug: parsed.data.slug },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return actionError("Cet identifiant est déjà utilisé.", { slug: ["Identifiant déjà utilisé."] });
    }
    throw error;
  }

  // Baseline rows the tenant's operators need before the app is usable —
  // most importantly the `isDefault` warehouse every stock path requires
  // (docs/adr/0027-tenant-provisioning.md). Best-effort: a failure here
  // must not strand the tenant/invitation that already exist — the
  // `scripts/backfill-tenant-baseline.ts` script re-runs the same
  // idempotent provisioning.
  try {
    const baseline = await provisionTenantBaseline(tenant.id, { companyName: tenant.name });
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "tenant.baseline_provisioned",
      entityType: "Tenant",
      entityId: tenant.id,
      newValue: {
        warehouseCreated: baseline.warehouseCreated,
        businessSettingsCreated: baseline.businessSettingsCreated,
        expenseCategoriesCreated: baseline.expenseCategoriesCreated,
      },
    });
  } catch (error) {
    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "tenant.baseline_provisioning_failed",
      entityType: "Tenant",
      entityId: tenant.id,
      metadata: { message: error instanceof Error ? error.message : "unknown" },
    });
  }

  const rawToken = generateRawToken();
  const invitation = await runWithTenant(tenant.id, "platform:create-tenant", () =>
    prisma.invitation.create({
      data: {
        email: parsed.data.ownerEmail,
        name: parsed.data.ownerName,
        role: "OWNER",
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: null,
      },
    })
  );

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "tenant.created",
    entityType: "Tenant",
    entityId: tenant.id,
    newValue: { name: tenant.name, slug: tenant.slug },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "invitation.created",
    entityType: "Invitation",
    entityId: invitation.id,
    newValue: { email: invitation.email, role: invitation.role },
    metadata: { via: "platform:create-tenant", tenantId: tenant.id },
  });

  const inviteUrl = `/invitations/${rawToken}`;
  await sendInvitationEmail({ to: invitation.email, inviteeName: invitation.name, role: invitation.role, inviteUrl });

  revalidatePath("/platform");
  return actionOk({ id: tenant.id, inviteUrl });
}

export async function activateTenantAction(formData: FormData): Promise<ActionResult<undefined>> {
  const actor = await requirePlatformAdminForAction();
  const id = formData.get("id");
  if (typeof id !== "string" || !id) return actionError("Tenant invalide.");

  const existing = await prismaBase.tenant.findUnique({ where: { id } });
  if (!existing) return actionError("Tenant introuvable.");
  if (existing.status === "ACTIVE") return actionOk(undefined);

  await prismaBase.tenant.update({ where: { id }, data: { status: "ACTIVE" } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "tenant.activated",
    entityType: "Tenant",
    entityId: id,
    previousValue: { status: existing.status },
    newValue: { status: "ACTIVE" },
  });

  revalidatePath("/platform");
  return actionOk(undefined);
}

/**
 * Suspending a tenant is an immediate, hard lockout: every one of its
 * users' sessions is destroyed in the same action (not just "can't log in
 * again") — `getCurrentUser()` also independently checks the tenant's
 * status on every request as a backstop (docs/adr/0027), but this makes
 * the lockout unambiguous the moment the platform admin acts.
 */
export async function suspendTenantAction(formData: FormData): Promise<ActionResult<undefined>> {
  const actor = await requirePlatformAdminForAction();
  const id = formData.get("id");
  if (typeof id !== "string" || !id) return actionError("Tenant invalide.");
  if (id === "default") return actionError("Le tenant d'amorçage ne peut pas être suspendu.");

  const existing = await prismaBase.tenant.findUnique({ where: { id } });
  if (!existing) return actionError("Tenant introuvable.");
  if (existing.status === "SUSPENDED") return actionOk(undefined);

  await prismaBase.tenant.update({ where: { id }, data: { status: "SUSPENDED" } });
  await destroyAllSessionsForTenant(id);

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "tenant.suspended",
    entityType: "Tenant",
    entityId: id,
    previousValue: { status: existing.status },
    newValue: { status: "SUSPENDED" },
  });

  revalidatePath("/platform");
  return actionOk(undefined);
}

/**
 * Irreversibly deletes a tenant and every row it owns
 * (src/lib/tenant/delete.ts). Requires the caller to type the tenant's own
 * slug as a confirmation — deliberately not just a checkbox, since there is
 * no undo (no soft-delete, no trash). The bootstrap tenant is refused both
 * here (fast, friendly error) and inside `deleteTenantData` itself (hard
 * backstop).
 */
export async function deleteTenantAction(formData: FormData): Promise<ActionResult<undefined>> {
  const actor = await requirePlatformAdminForAction();
  const id = formData.get("id");
  const slugConfirmation = formData.get("slugConfirmation");
  if (typeof id !== "string" || !id) return actionError("Tenant invalide.");
  if (typeof slugConfirmation !== "string") return actionError("Confirmation invalide.");
  if (id === BOOTSTRAP_TENANT_ID) return actionError("Le tenant d'amorçage ne peut pas être supprimé.");

  const existing = await prismaBase.tenant.findUnique({ where: { id } });
  if (!existing) return actionError("Tenant introuvable.");
  if (slugConfirmation.trim() !== existing.slug) {
    return actionError("L'identifiant saisi ne correspond pas.", {
      slugConfirmation: ["L'identifiant saisi ne correspond pas au tenant à supprimer."],
    });
  }

  let result;
  try {
    result = await deleteTenantData(id);
  } catch (error) {
    if (error instanceof BootstrapTenantDeletionError || error instanceof TenantNotFoundError) {
      return actionError(error.message);
    }
    if (isForeignKeyConstraintError(error)) {
      return actionError(
        "Suppression impossible : des données liées empêchent encore la suppression de ce tenant."
      );
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "tenant.deleted",
    entityType: "Tenant",
    entityId: id,
    previousValue: { name: existing.name, slug: existing.slug },
    metadata: { deletedCounts: result.deletedCounts, totalDeleted: result.totalDeleted },
  });

  revalidatePath("/platform");
  return actionOk(undefined);
}
