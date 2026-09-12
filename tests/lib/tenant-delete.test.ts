import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { deleteTenantData, BootstrapTenantDeletionError, TenantNotFoundError } from "@/lib/tenant/delete";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";
import { createSession } from "@/lib/auth/session";

/**
 * Full tenant deletion (companion to the /platform lifecycle tests in
 * tests/actions/tenants.test.ts). Seeds one row in every table that isn't
 * cleared by a DB-level cascade (docs/adr/0034's business-data list,
 * reversed, plus the platform-only tables — see src/lib/tenant/delete.ts's
 * own doc comment) and confirms deletion clears all of it, leaves another
 * tenant's data untouched, and refuses the bootstrap tenant outright.
 */

async function seedTenant(id: string) {
  const tenant = await prismaBase.tenant.create({ data: { id, name: `Tenant ${id}`, slug: id } });

  const owner = await createTestUser({ tenantId: id, role: "OWNER" });
  await createSession(owner.id);

  const category = await prismaBase.category.create({
    data: { tenantId: id, name: "Cat", slug: `cat-${id}` },
  });
  const product = await prismaBase.product.create({
    data: { tenantId: id, name: "Prod", sku: `sku-${id}`, price: 10, categoryId: category.id },
  });
  await prismaBase.customer.create({
    data: { tenantId: id, fullName: "Cust", phone: `06${id}` },
  });

  const integration = await prismaBase.integration.create({
    data: { tenantId: id, provider: "WOOCOMMERCE" },
  });
  await prismaBase.syncRun.create({
    data: { tenantId: id, integrationId: integration.id, resource: "PRODUCTS", direction: "IMPORT" },
  });
  await prismaBase.webhookEvent.create({
    data: {
      tenantId: id,
      integrationId: integration.id,
      provider: "WOOCOMMERCE",
      deliveryId: `d-${id}`,
      topic: "order.created",
      status: "OK",
    },
  });

  const provider = await prismaBase.shippingProvider.create({ data: { tenantId: id, name: "Carrier" } });
  await prismaBase.shipmentWebhookEvent.create({
    data: { tenantId: id, providerId: provider.id, deliveryId: `sd-${id}`, topic: "status", status: "OK" },
  });

  await prismaBase.notification.create({
    data: { tenantId: id, userId: owner.id, type: "NOUVELLE_COMMANDE", title: "Hi", message: "Hello" },
  });

  await prismaBase.invitation.create({
    data: {
      tenantId: id,
      email: `invite-${id}@test.com`,
      name: "Invitee",
      role: "ADMIN",
      tokenHash: `hash-${id}`,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  await prismaBase.supportTicket.create({
    data: { tenantId: id, category: "autre", description: "Help" },
  });

  await prismaBase.backupRun.create({
    data: { tenantId: id, type: "MANUAL_EXPORT", formatVersion: 1, appVersion: "1.0", schemaVersion: "1", counts: {} },
  });

  await prismaBase.googleDriveConnection.create({
    data: { tenantId: id, credentialsEncrypted: "enc" },
  });

  const plan = await prismaBase.plan.findUniqueOrThrow({ where: { code: "BUSINESS" } });
  await prismaBase.tenantSubscription.create({ data: { tenantId: id, planId: plan.id } });
  await prismaBase.usageAlertState.create({
    data: { tenantId: id, metric: "ORDERS", period: "current", highestThresholdNotified: 80 },
  });

  await prismaBase.auditEvent.create({
    data: { tenantId: id, actorType: "USER", actorUserId: owner.id, action: "test.event", entityType: "Test", entityId: "1" },
  });

  return { tenant, owner, product };
}

describe("deleteTenantData", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("refuses the bootstrap tenant", async () => {
    await expect(deleteTenantData(DEFAULT_TENANT_ID)).rejects.toBeInstanceOf(BootstrapTenantDeletionError);
    expect(await prismaBase.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } })).not.toBeNull();
  });

  it("throws for a tenant that doesn't exist", async () => {
    await expect(deleteTenantData("no-such-tenant")).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it("deletes every row the tenant owns, cascades included, and leaves other tenants untouched", async () => {
    const TENANT_B = "tenant-b-delete";
    const { owner: ownerB } = await seedTenant(TENANT_B);

    // Seed the bootstrap tenant with the same shape of rows so we can prove
    // tenant A's data survives tenant B's deletion.
    const ownerA = await createTestUser({ tenantId: DEFAULT_TENANT_ID, role: "OWNER" });
    await createSession(ownerA.id);
    const categoryA = await prismaBase.category.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "CatA", slug: "cat-a" } });
    await prismaBase.product.create({
      data: { tenantId: DEFAULT_TENANT_ID, name: "ProdA", sku: "sku-a", price: 10, categoryId: categoryA.id },
    });

    const result = await deleteTenantData(TENANT_B);
    expect(result.tenantId).toBe(TENANT_B);
    expect(result.totalDeleted).toBeGreaterThan(0);

    // The tenant row itself, and everything under it, is gone.
    expect(await prismaBase.tenant.findUnique({ where: { id: TENANT_B } })).toBeNull();
    expect(await prismaBase.user.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.session.count({ where: { userId: ownerB.id } })).toBe(0);
    expect(await prismaBase.category.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.product.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.customer.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.integration.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.syncRun.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.webhookEvent.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.shippingProvider.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.shipmentWebhookEvent.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.notification.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.invitation.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.supportTicket.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.backupRun.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.googleDriveConnection.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.tenantSubscription.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.usageAlertState.count({ where: { tenantId: TENANT_B } })).toBe(0);
    expect(await prismaBase.auditEvent.count({ where: { tenantId: TENANT_B } })).toBe(0);

    // Tenant A (bootstrap) is completely unaffected.
    expect(await prismaBase.tenant.findUnique({ where: { id: DEFAULT_TENANT_ID } })).not.toBeNull();
    expect(await prismaBase.user.count({ where: { tenantId: DEFAULT_TENANT_ID, id: ownerA.id } })).toBe(1);
    expect(await prismaBase.category.count({ where: { tenantId: DEFAULT_TENANT_ID, slug: "cat-a" } })).toBe(1);
    expect(await prismaBase.product.count({ where: { tenantId: DEFAULT_TENANT_ID, sku: "sku-a" } })).toBe(1);
  });
});
