import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { BACKUP_MODELS } from "@/lib/backup/models";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup } from "@/lib/backup/import";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { createTestUser } from "../helpers/auth";

/**
 * P3 — physical-return history (OrderReturn / OrderReturnLine) and the new
 * ReturnReception are part of a tenant backup, in a dependency-safe order,
 * and a tenant holding them round-trips through export → restore. Before
 * this fix such a restore could not even wipe the tenant's orders
 * (order_returns RESTRICTs them).
 */

const NEW_KEYS = ["order_returns", "order_return_lines", "return_receptions"] as const;

describe("backup registry — return models", () => {
  it("includes OrderReturn, OrderReturnLine and ReturnReception", () => {
    const keys = BACKUP_MODELS.map((m) => m.key);
    for (const k of NEW_KEYS) expect(keys).toContain(k);
    for (const m of BACKUP_MODELS.filter((x) => (NEW_KEYS as readonly string[]).includes(x.key))) expect(m.strategy).toBe("replace");
  });

  it("every foreign key of the return models (and InventoryMovement → OrderReturn) points at a model restored EARLIER", () => {
    const index = new Map(BACKUP_MODELS.map((m, i) => [m.model, i]));
    const checked = ["OrderReturn", "OrderReturnLine", "ReturnReception", "InventoryMovement"];
    const violations: string[] = [];
    for (const name of checked) {
      const descriptor = BACKUP_MODELS.find((m) => m.model === name)!;
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name)!;
      for (const f of model.fields) {
        if (f.kind !== "object" || !f.relationFromFields?.length) continue;
        if (f.type === name || f.type === "Tenant") continue;
        if (f.relationFromFields.every((c) => descriptor.deferredFks?.includes(c))) continue;
        const target = index.get(f.type);
        if (target === undefined) continue; // not a backed-up model (e.g. a platform table)
        if (target >= index.get(name)!) violations.push(`${name}.${f.name} → ${f.type}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("backup round-trip — tenant with returns and receptions", () => {
  beforeEach(resetDb);
  afterEach(resetDb);

  it("exports the return history and receptions, and restores them with their links", async () => {
    const T = DEFAULT_TENANT_ID;
    const user = await createTestUser({ role: "OWNER" });
    const ids = await runWithTenant(T, "test", async () => {
      const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt", isDefault: true } });
      const product = await prisma.product.create({ data: { name: "Sac", sku: "BK-RET", price: 100 } });
      const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 6 } });
      const customer = await prisma.customer.create({ data: { fullName: "Client" } });
      const provider = await prisma.shippingProvider.create({ data: { name: "Ozon", type: "MANUEL" } });
      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          subtotal: 200,
          total: 200,
          status: "EXPEDIEE",
          shippedAt: new Date(),
          fulfillmentWarehouseId: warehouse.id,
          items: { create: [{ productId: product.id, nameSnapshot: "Sac", skuSnapshot: "BK-RET", unitPrice: 100, quantity: 2, total: 200 }] },
        },
        include: { items: true },
      });
      const shipment = await prisma.shipment.create({ data: { orderId: order.id, providerId: provider.id, trackingNumber: "BK-1", status: "RETOURNE" } });
      const ret = await prisma.orderReturn.create({ data: { orderId: order.id, idempotencyKey: "bk-key", receivedById: user.id } });
      await prisma.orderReturnLine.create({
        data: { orderReturnId: ret.id, orderItemId: order.items[0].id, nameSnapshot: "Sac", skuSnapshot: "BK-RET", quantitySellable: 1, warehouseId: warehouse.id },
      });
      await prisma.inventoryMovement.create({
        data: { inventoryItemId: item.id, warehouseId: warehouse.id, type: "RETOUR", quantity: 1, orderId: order.id, orderReturnId: ret.id },
      });
      const inspected = await prisma.returnReception.create({
        data: { shipmentId: shipment.id, orderId: order.id, warehouseId: warehouse.id, status: "INSPECTE", orderReturnId: ret.id, inspectedAt: new Date(), receivedById: user.id, inspectedById: user.id },
      });
      const pending = await prisma.returnReception.create({ data: { shipmentId: shipment.id, orderId: order.id, warehouseId: warehouse.id } });
      return { ret, inspected, pending };
    });

    const backup = await buildTenantBackup({ tenantId: T, createdByUserId: null });
    const inspectedPkg = inspectBackup(backup.container);
    expect(inspectedPkg.valid).toBe(true);
    expect(inspectedPkg.counts).toMatchObject({ order_returns: 1, order_return_lines: 1, return_receptions: 2 });

    // Live data drifts after the backup: the pending reception is deleted.
    await runWithTenant(T, "test", () => prisma.returnReception.delete({ where: { id: ids.pending.id } }));

    const result = await restoreTenantBackup({ activeTenantId: T, inspected: inspectedPkg });
    expect(result.restoredCounts).toMatchObject({ order_returns: 1, order_return_lines: 1, return_receptions: 2 });

    await runWithTenant(T, "test", async () => {
      const inspected = await prisma.returnReception.findUniqueOrThrow({ where: { id: ids.inspected.id }, include: { orderReturn: { include: { lines: true, movements: true } } } });
      expect(inspected.status).toBe("INSPECTE");
      expect(inspected.orderReturn?.id).toBe(ids.ret.id);
      expect(inspected.orderReturn?.lines).toHaveLength(1);
      expect(inspected.orderReturn?.movements).toHaveLength(1);
      expect((await prisma.returnReception.findUniqueOrThrow({ where: { id: ids.pending.id } })).status).toBe("A_INSPECTER");
    });
    expect(await prismaBase.returnReception.count({ where: { tenantId: T } })).toBe(2);
  });
});
