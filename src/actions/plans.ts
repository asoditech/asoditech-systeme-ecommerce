"use server";

import { revalidatePath } from "next/cache";
import { prisma, prismaBase } from "@/lib/prisma";
import { requirePlatformAdminForAction, requirePermissionForAction } from "@/lib/auth/guards";
import { runUnscoped, runWithTenant } from "@/lib/tenant/context";
import { recordAuditEvent } from "@/lib/audit";
import { notifySupportTicket } from "@/lib/notifications";
import { sendSupportTicketEmail } from "@/lib/email";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import { getTenantPlan, getPlanByCode } from "@/lib/entitlements/plan";
import { getTenantUsage } from "@/lib/entitlements/usage";
import { changeTenantPlanSchema, updateSubscriptionStatusSchema, updatePlanSchema } from "@/lib/validation/plan";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import type { SubscriptionStatus } from "@prisma/client";

/**
 * Plan/subscription platform administration (docs/adr/0035) — the one
 * surface, alongside `src/actions/tenants.ts`, that legitimately operates
 * on tenants other than the actor's own. Every mutation here is
 * `requirePlatformAdminForAction`-gated: a normal tenant OWNER/ADMIN
 * cannot change their own plan or limits (see that file's own tests) —
 * only a platform admin can, exactly per the brief's "Platform plan
 * control" requirement.
 */

function subscriptionAuditAction(status: SubscriptionStatus) {
  switch (status) {
    case "ACTIVE":
    case "TRIALING":
      return "subscription.activated" as const;
    case "PAST_DUE":
      // No dedicated PAST_DUE wording exists in the brief's audit list —
      // "suspended" is the closest real-world description of a
      // billing-related hold, and is deliberately distinct from
      // `Tenant.status = SUSPENDED` (the access-lockout mechanism, wholly
      // unaffected by this).
      return "subscription.suspended" as const;
    case "CANCELED":
      return "subscription.canceled" as const;
  }
}

/**
 * A read-only preview for the plan-change confirmation dialog — shows
 * whether the tenant is currently over the CANDIDATE plan's limits
 * (docs/adr/0035 "Plan change safety"). Never blocks the change itself;
 * a downgrade always succeeds. Existing resources are never touched —
 * only future creation past the new, lower limit is refused, by the same
 * `withSeatLimit` guard every creation already goes through.
 */
export async function previewTenantPlanChange(tenantId: string, planCode: "BUSINESS" | "PRO" | "CUSTOM") {
  await requirePlatformAdminForAction();

  const [usage, targetPlan] = await Promise.all([getTenantUsage(tenantId), getPlanByCode(planCode)]);
  if (!targetPlan) throw new Error(`Plan introuvable : ${planCode}`);

  const overUsers = targetPlan.maxUsers !== null && usage.users.used > targetPlan.maxUsers;
  const overWarehouses = targetPlan.maxWarehouses !== null && usage.warehouses.used > targetPlan.maxWarehouses;

  return {
    plan: targetPlan,
    usage,
    overLimits: overUsers || overWarehouses,
    overUsers,
    overWarehouses,
  };
}

/**
 * Assigns/changes a tenant's plan. Never deletes data and never fails
 * because the tenant is currently over the new plan's limits — a
 * downgrade leaves every existing user/warehouse/order intact; only
 * NEW creation past the lower limit is refused afterward, by the normal
 * write-path guards. This is the ONLY way a tenant's limits change —
 * there is no per-tenant limit override separate from its assigned plan.
 */
export async function changeTenantPlanAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();

  const parsed = changeTenantPlanSchema.safeParse({
    tenantId: formData.get("tenantId"),
    planCode: formData.get("planCode"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const [tenant, targetPlan] = await Promise.all([
    runUnscoped("platform:change-plan", () => prismaBase.tenant.findUnique({ where: { id: parsed.data.tenantId } })),
    getPlanByCode(parsed.data.planCode),
  ]);
  if (!tenant) return actionError("Tenant introuvable.");
  if (!targetPlan) return actionError("Forfait introuvable.");

  const { plan: previousPlan } = await getTenantPlan(tenant.id);

  await runWithTenant(tenant.id, "platform:change-plan", async () => {
    await prisma.tenantSubscription.upsert({
      where: { tenantId: tenant.id },
      update: { planId: targetPlan.id, currentPlanSince: new Date() },
      create: { tenantId: tenant.id, planId: targetPlan.id, status: "ACTIVE" },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: "plan.changed",
      entityType: "TenantSubscription",
      entityId: tenant.id,
      previousValue: { planCode: previousPlan.code },
      newValue: { planCode: targetPlan.code },
    });
  });

  revalidatePath("/platform");
  revalidatePath("/parametres/abonnement");
  return actionOk({ id: tenant.id });
}

export async function updateSubscriptionStatusAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();

  const parsed = updateSubscriptionStatusSchema.safeParse({
    tenantId: formData.get("tenantId"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const tenant = await runUnscoped("platform:update-subscription-status", () =>
    prismaBase.tenant.findUnique({ where: { id: parsed.data.tenantId } })
  );
  if (!tenant) return actionError("Tenant introuvable.");

  await runWithTenant(tenant.id, "platform:update-subscription-status", async () => {
    const existing = await prisma.tenantSubscription.findUnique({ where: { tenantId: tenant.id } });
    await prisma.tenantSubscription.update({
      where: { tenantId: tenant.id },
      data: {
        status: parsed.data.status,
        canceledAt: parsed.data.status === "CANCELED" ? new Date() : null,
      },
    });

    await recordAuditEvent({
      actorType: "USER",
      actorUserId: actor.id,
      action: subscriptionAuditAction(parsed.data.status),
      entityType: "TenantSubscription",
      entityId: tenant.id,
      previousValue: { status: existing?.status ?? null },
      newValue: { status: parsed.data.status },
    });
  });

  revalidatePath("/platform");
  revalidatePath("/parametres/abonnement");
  return actionOk({ id: tenant.id });
}

/**
 * Edits a plan's own definition — the centralized place prices/limits/
 * features live (docs/adr/0035 "Central entitlements system"). Changing a
 * plan's limits here changes them for EVERY tenant currently on that
 * plan, immediately (there is no per-tenant override) — the confirmation
 * copy in the UI says this plainly.
 */
export async function updatePlanAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();

  const raw = Object.fromEntries(formData.entries());
  let featuresJson: unknown;
  try {
    featuresJson = JSON.parse(String(raw.features ?? "{}"));
  } catch {
    return actionError("Le format des fonctionnalités est invalide.");
  }

  const parsed = updatePlanSchema.safeParse({ ...raw, features: featuresJson });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prismaBase.plan.findUnique({ where: { id: parsed.data.planId } });
  if (!existing) return actionError("Forfait introuvable.");

  const updated = await prismaBase.plan.update({
    where: { id: parsed.data.planId },
    data: {
      name: parsed.data.name,
      installationPriceMad: parsed.data.installationPriceMad,
      monthlyPriceMad: parsed.data.monthlyPriceMad,
      maxOrdersPerMonth: parsed.data.maxOrdersPerMonth,
      maxUsers: parsed.data.maxUsers,
      maxWarehouses: parsed.data.maxWarehouses,
      features: parsed.data.features,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "plan.changed",
    entityType: "Plan",
    entityId: updated.id,
    previousValue: {
      name: existing.name,
      monthlyPriceMad: existing.monthlyPriceMad.toString(),
      maxOrdersPerMonth: existing.maxOrdersPerMonth,
      maxUsers: existing.maxUsers,
      maxWarehouses: existing.maxWarehouses,
      features: existing.features,
    },
    newValue: {
      name: updated.name,
      monthlyPriceMad: updated.monthlyPriceMad.toString(),
      maxOrdersPerMonth: updated.maxOrdersPerMonth,
      maxUsers: updated.maxUsers,
      maxWarehouses: updated.maxWarehouses,
      features: updated.features,
    },
  });

  revalidatePath("/platform/plans");
  revalidatePath("/parametres/abonnement");
  return actionOk({ id: updated.id });
}

/**
 * Client-facing "Passer à PRO" / "Demander une mise à niveau" — no
 * payment automation exists (see docs/adr/0035's own "Explicitly not
 * built" section), so this records intent only: an audit event plus a
 * real `SupportTicket` (the same queue "Signaler un problème" already
 * feeds — src/actions/support.ts), forwarded by email exactly like any
 * other reported issue, so an operator has something concrete to act on.
 * `settings.manage` (OWNER/ADMIN) — an upgrade is a business decision,
 * not something every role should be able to trigger.
 */
export async function requestPlanUpgradeAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("settings.manage");

  const requestedPlanCode = String(formData.get("requestedPlanCode") ?? "PRO");
  const { plan: currentPlan } = await getTenantPlan(user.tenantId);
  const requestedPlan = await getPlanByCode(requestedPlanCode === "PRO" ? "PRO" : "BUSINESS");

  const description =
    `Demande de mise à niveau depuis le forfait ${currentPlan.name} vers ${requestedPlan?.name ?? requestedPlanCode}, ` +
    `initiée depuis Paramètres → Abonnement & Utilisation.`;

  const ticket = await prisma.supportTicket.create({
    data: {
      reporterUserId: user.id,
      category: "upgrade",
      description,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "upgrade.requested",
    entityType: "TenantSubscription",
    entityId: user.tenantId,
    metadata: { fromPlan: currentPlan.code, toPlan: requestedPlan?.code ?? requestedPlanCode },
  });

  await notifySupportTicket({ id: ticket.id, categoryLabel: "Demande de mise à niveau", reporterName: user.name }, user.id);

  const settings = await prisma.businessSettings.findFirst({ select: { supportEmail: true, companyName: true } });
  try {
    await sendSupportTicketEmail({
      to: settings?.supportEmail?.trim() || "asoditech@gmail.com",
      companyName: settings?.companyName?.trim() || "ASODITECH",
      categoryLabel: "Demande de mise à niveau",
      description,
      reporterName: user.name,
      reporterEmail: user.email,
      reporterRole: USER_ROLE_LABELS[user.role] ?? user.role,
    });
  } catch (error) {
    console.error("sendSupportTicketEmail failed (non-fatal):", error);
  }

  return actionOk({ id: ticket.id });
}
