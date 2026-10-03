import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { setUserPermissionOverridesAction } from "@/actions/users";
import { createShipmentAction } from "@/actions/delivery";
import { requirePermission, requirePermissionForAction } from "@/lib/auth/guards";
import { createSession, getCurrentUser } from "@/lib/auth/session";
import { analyticsAccess } from "@/lib/analytics/access";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/auth/permissions";
import {
  presetsForRole,
  RESPONSIBILITY_PRESETS,
  responsibilityGrants,
  responsibilityRevocations,
  responsibilityStatus,
  type DraftState,
} from "@/lib/auth/responsibilities";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantChannelAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * One account, several responsibilities over time (docs/adr/0039): a
 * confirmation agent who later also handles delivery, then also reads
 * analytics — and loses delivery again — through the EXISTING per-user
 * overrides. The role never changes, no account is duplicated, and every
 * check below goes through the real server-side guards and actions.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

/** What the dialog offers an override for (users.manage excluded). */
const OVERRIDABLE = PERMISSIONS.filter((p) => p !== "users.manage");
const BASE = ROLE_PERMISSIONS.CONFIRMATION;

async function loginAs(userId: string) {
  mockCookieStore.clear();
  await createSession(userId);
  return (await getCurrentUser())!;
}

const draft = (grants: string[]): Record<string, DraftState> => Object.fromEntries(grants.map((p) => [p, "grant" as const]));
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

describe("responsibility bundles (pure)", () => {
  it("Livraison for a confirmation agent = exactly the delivery permissions it lacks", () => {
    expect(responsibilityGrants("DELIVERY", BASE, OVERRIDABLE).sort()).toEqual(["delivery.manage", "delivery.view"]);
  });

  it("Analyses = analytics.view only — never finance.view", () => {
    expect(responsibilityGrants("ANALYTICS", BASE, OVERRIDABLE)).toEqual(["analytics.view"]);
    for (const p of RESPONSIBILITY_PRESETS) expect(p.permissions).not.toContain("finance.view");
  });

  it("no bundle ever contains users.manage; a role's own bundle is not offered to that role", () => {
    for (const p of RESPONSIBILITY_PRESETS) expect(responsibilityGrants(p.id, [], PERMISSIONS)).not.toContain("users.manage");
    expect(presetsForRole("CONFIRMATION").map((p) => p.id).sort()).toEqual(["ANALYTICS", "DELIVERY", "WAREHOUSE"]);
    expect(presetsForRole("MANAGER").map((p) => p.id).sort()).toEqual(["ANALYTICS", "CONFIRMATION", "DELIVERY", "WAREHOUSE"]);
  });

  it("status reflects the draft: none → partial → granted; covered-by-role when the role has it", () => {
    expect(responsibilityStatus("DELIVERY", BASE, OVERRIDABLE, {})).toBe("none");
    expect(responsibilityStatus("DELIVERY", BASE, OVERRIDABLE, draft(["delivery.view"]))).toBe("partial");
    expect(responsibilityStatus("DELIVERY", BASE, OVERRIDABLE, draft(["delivery.view", "delivery.manage"]))).toBe("granted");
    expect(responsibilityStatus("CONFIRMATION", BASE, OVERRIDABLE, {})).toBe("covered-by-role");
  });

  it("removing one bundle keeps permissions another still-granted bundle needs", () => {
    // A confirmation agent with Livraison + Entrepôt: both bundles grant delivery.view.
    const withBoth = draft([...responsibilityGrants("DELIVERY", BASE, OVERRIDABLE), ...responsibilityGrants("WAREHOUSE", BASE, OVERRIDABLE)]);
    const removeDelivery = responsibilityRevocations("DELIVERY", BASE, OVERRIDABLE, withBoth);
    expect(removeDelivery).toEqual(["delivery.manage"]); // delivery.view kept for Entrepôt
    const removeWarehouse = responsibilityRevocations("WAREHOUSE", BASE, OVERRIDABLE, withBoth);
    expect(removeWarehouse).not.toContain("delivery.view");
    expect(removeWarehouse).toContain("inventory.view");
  });

  it("removal never touches a DENY or a role permission", () => {
    const states: Record<string, DraftState> = { "delivery.view": "grant", "delivery.manage": "grant", "orders.edit": "deny" };
    expect(responsibilityRevocations("DELIVERY", BASE, OVERRIDABLE, states).sort()).toEqual(["delivery.manage", "delivery.view"]);
    expect(responsibilityRevocations("CONFIRMATION", BASE, OVERRIDABLE, states)).toEqual([]);
  });
});

describe("one account, responsibilities added and removed over time (server-side)", () => {
  it("confirmation → + livraison → + analyses → − livraison: each change independent, role unchanged, audited", async () => {
    const agent = await createTestUser({ role: "CONFIRMATION" });
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const delivery = responsibilityGrants("DELIVERY", BASE, OVERRIDABLE);
    const analytics = responsibilityGrants("ANALYTICS", BASE, OVERRIDABLE);

    // 1. + Livraison
    expect((await setUserPermissionOverridesAction({ userId: agent.id, grants: delivery, denies: [] })).ok).toBe(true);
    let me = await loginAs(agent.id);
    await expect(requirePermissionForAction("delivery.manage")).resolves.toBeTruthy();
    await expect(requirePermissionForAction("orders.confirm")).resolves.toBeTruthy();
    await expect(requirePermissionForAction("analytics.view")).rejects.toThrow(/non autorisé/i);

    // 2. + Analyses (delivery kept)
    await loginAs(admin.id);
    expect((await setUserPermissionOverridesAction({ userId: agent.id, grants: [...delivery, ...analytics], denies: [] })).ok).toBe(true);
    me = await loginAs(agent.id);
    await expect(requirePermissionForAction("delivery.manage")).resolves.toBeTruthy();
    await expect(requirePermissionForAction("analytics.view")).resolves.toBeTruthy();
    expect(analyticsAccess(me)).toEqual({ online: true, store: false, commissions: false, finance: false });

    // 3. − Livraison (analytics and confirmation kept)
    const states = draft([...delivery, ...analytics]);
    const remaining = Object.keys(states).filter((p) => !responsibilityRevocations("DELIVERY", BASE, OVERRIDABLE, states).includes(p as never));
    await loginAs(admin.id);
    expect((await setUserPermissionOverridesAction({ userId: agent.id, grants: remaining, denies: [] })).ok).toBe(true);
    await loginAs(agent.id);
    await expect(requirePermissionForAction("delivery.manage")).rejects.toThrow(/non autorisé/i);
    await expect(requirePermissionForAction("analytics.view")).resolves.toBeTruthy();
    await expect(requirePermissionForAction("orders.confirm")).resolves.toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: agent.id } });
    expect(user.role).toBe("CONFIRMATION");
    expect(await prisma.user.count({ where: { email: user.email } })).toBe(1); // no duplicate account
    expect(await prismaBase.auditEvent.count({ where: { action: "user.permissions_updated", entityId: agent.id } })).toBe(3);
  });

  it("analytics never implies finance: profitability and treasury stay refused server-side", async () => {
    const agent = await createTestUser({ role: "CONFIRMATION" });
    await loginAsTestUser({ role: "ADMIN" });
    await setUserPermissionOverridesAction({ userId: agent.id, grants: ["analytics.view"], denies: [] });
    await loginAs(agent.id);
    await expect(requirePermission("analytics.view")).resolves.toBeTruthy();
    await expect(requirePermission("finance.view")).rejects.toBeInstanceOf(RedirectSignal);
    await expect(requirePermissionForAction("finance.view")).rejects.toThrow(/non autorisé/i);
  });

  it("delivery permission does not bypass the order workflow, and keeps creator / confirmation agent untouched", async () => {
    const agent = await createTestUser({ role: "CONFIRMATION" });
    const admin = await loginAsTestUser({ role: "ADMIN" });
    await setUserPermissionOverridesAction({ userId: agent.id, grants: ["delivery.view", "delivery.manage"], denies: [] });

    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const provider = await prisma.shippingProvider.create({ data: { name: "Livreur interne" } });
    const commissionUser = await createTestUser({ role: "CONFIRMATION" });
    const commissionAgent = await prisma.commissionAgent.create({ data: { userId: commissionUser.id, ratePerOrder: 5 } });
    const fresh = await prisma.order.create({ data: { customerId: customer.id, status: "NOUVELLE", subtotal: 100, total: 100, createdById: admin.id } });
    const confirmed = await prisma.order.create({
      data: { customerId: customer.id, status: "CONFIRMEE", subtotal: 100, total: 100, createdById: admin.id, confirmationAgentId: commissionAgent.id },
    });

    await loginAs(agent.id);
    const refused = await createShipmentAction(fd({ orderId: fresh.id, providerId: provider.id }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/statut/);

    const ok = await createShipmentAction(fd({ orderId: confirmed.id, providerId: provider.id }));
    expect(ok.ok).toBe(true);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(after.createdById).toBe(admin.id);
    expect(after.confirmationAgentId).toBe(commissionAgent.id);
  });

  it("before any grant, the delivery action itself is refused (not just hidden)", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(createShipmentAction(fd({ orderId: "x", providerId: "y" }))).rejects.toThrow(/non autorisé/i);
  });
});

describe("who may grant", () => {
  it("a confirmation agent cannot grant themselves anything — nothing is stored", async () => {
    const agent = await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(setUserPermissionOverridesAction({ userId: agent.id, grants: ["delivery.manage", "analytics.view"], denies: [] })).rejects.toThrow(
      /non autorisé/i
    );
    expect(await prisma.userPermissionOverride.count({ where: { userId: agent.id } })).toBe(0);
  });

  it("a MANAGER cannot hand out responsibilities", async () => {
    const agent = await createTestUser({ role: "CONFIRMATION" });
    await loginAsTestUser({ role: "MANAGER" });
    await expect(setUserPermissionOverridesAction({ userId: agent.id, grants: ["delivery.manage"], denies: [] })).rejects.toThrow(/non autorisé/i);
  });

  it("users.manage is never grantable, even by an ADMIN", async () => {
    const agent = await createTestUser({ role: "CONFIRMATION" });
    await loginAsTestUser({ role: "ADMIN" });
    expect((await setUserPermissionOverridesAction({ userId: agent.id, grants: ["users.manage"], denies: [] })).ok).toBe(false);
    expect(await prisma.userPermissionOverride.count({ where: { userId: agent.id } })).toBe(0);
  });

  it("an ADMIN cannot grant anything to a user of ANOTHER tenant", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-other", name: "Autre", slug: "tenant-other" } });
    const foreign = await createTestUser({ role: "CONFIRMATION", tenantId: "tenant-other" });
    await loginAsTestUser({ role: "ADMIN" });
    const r = await setUserPermissionOverridesAction({ userId: foreign.id, grants: ["delivery.manage"], denies: [] });
    expect(r.ok).toBe(false);
    expect(await prismaBase.userPermissionOverride.count({ where: { userId: foreign.id } })).toBe(0);
  });
});

describe("channel scope still applies (Online + Magasin tenant)", () => {
  it("delivery stays inert without the Online channel; analytics shows only the user's channels", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    const online = await ensureDefaultOnlineChannel();
    const agent = await createTestUser({ role: "CONFIRMATION", channels: "none" });
    await grantChannelAccess(agent.id, store.id);
    await loginAsTestUser({ role: "ADMIN" });
    expect((await setUserPermissionOverridesAction({ userId: agent.id, grants: ["delivery.view", "delivery.manage", "analytics.view"], denies: [] })).ok).toBe(true);

    let me = await loginAs(agent.id);
    await expect(requirePermissionForAction("delivery.manage")).rejects.toThrow(/non autorisé/i);
    expect(analyticsAccess(me)).toMatchObject({ online: false, store: true, finance: false });

    await grantChannelAccess(agent.id, online.id);
    me = await loginAs(agent.id);
    await expect(requirePermissionForAction("delivery.manage")).resolves.toBeTruthy();
    expect(analyticsAccess(me)).toMatchObject({ online: true, store: true, finance: false });
  });
});
