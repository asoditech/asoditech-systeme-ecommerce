import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup } from "@/lib/backup/import";
import { deleteTenantData } from "@/lib/tenant/delete";
import { createSupplierAction, createReceptionAction, validateReceptionAction, recordSupplierPaymentAction } from "@/actions/purchases";
import { createSaleAction, createSaleReturnAction } from "@/actions/sales";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { createTestUser, loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { createSession } from "@/lib/auth/session";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Online/Offline domains (ADR 0038–0040) vs the tenant-wide maintenance paths:
 * backup/restore and tenant deletion must know every new table. Seeds a
 * COMPLETE Offline graph through the real actions, then exercises both.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

/** Build a full Offline graph for `tenantId` (must already be ONLINE_AND_OFFLINE). */
async function seedOfflineGraph(tenantId: string) {
  const owner = await loginAsTestUser({ role: "OWNER", tenantId });
  const seller = await createTestUser({ role: "MANAGER", tenantId }); // has the default Online channel row

  const ids = await runWithTenant(tenantId, "test-seed", async () => {
    const warehouse = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN", isDefault: true } });
    const store = await prisma.salesChannel.create({ data: { name: "Magasin", kind: "OFFLINE" } });
    await prisma.salesChannelLocation.create({ data: { salesChannelId: store.id, warehouseId: warehouse.id } });
    const product = await prisma.product.create({ data: { name: "Basket", sku: `BSK-${tenantId}`, price: 300, status: "ACTIF" } });
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: store.id } });
    await prisma.barcode.create({ data: { code: `611${tenantId.length}00001`, productId: product.id, isPrimary: true } });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 2 } });
    return { warehouseId: warehouse.id, storeId: store.id, productId: product.id };
  });

  // per-user access configuration
  await grantChannelAccess(seller.id, ids.storeId);
  await grantLocationAccess(seller.id, ids.warehouseId);
  await prismaBase.userPermissionOverride.create({ data: { tenantId, userId: seller.id, permission: "sales.override_price", effect: "GRANT" } });

  // Actions resolve their tenant from the session; pin it explicitly so the
  // graph is built for `tenantId` regardless of which tenant the default context is.
  await runWithTenant(tenantId, "test-seed", async () => {
    const sup = await createSupplierAction({ name: "Fournisseur" });
    if (!sup.ok) throw new Error("supplier: " + sup.error);
    const rec = await createReceptionAction({ supplierId: sup.data.id, warehouseId: ids.warehouseId, lines: [{ productId: ids.productId, quantity: 10, unitCost: 100 }] });
    if (!rec.ok) throw new Error("reception: " + rec.error);
    if (!(await validateReceptionAction({ id: rec.data.id })).ok) throw new Error("validate");
    if (!(await recordSupplierPaymentAction({ supplierId: sup.data.id, receptionId: rec.data.id, amount: 400, method: "VIREMENT" })).ok) throw new Error("payment");

    const s = await createSaleAction({
      salesChannelId: ids.storeId,
      warehouseId: ids.warehouseId,
      idempotencyKey: randomUUID(),
      lines: [{ productId: ids.productId, quantity: 3 }],
      payments: [{ method: "ESPECES", amount: 900 }],
    });
    if (!s.ok) throw new Error("sale: " + s.error);
    const sale = await runWithTenant(tenantId, "test-seed", () => prisma.sale.findUniqueOrThrow({ where: { id: s.data.id }, include: { lines: true } }));
    const r = await createSaleReturnAction({
      saleId: sale.id,
      idempotencyKey: randomUUID(),
      lines: [{ saleLineId: sale.lines[0].id, quantitySellable: 1, quantityDamaged: 1 }],
      refundAmount: 300,
      refundMethod: "ESPECES",
    });
    if (!r.ok) throw new Error("return: " + r.error);

  });

  return { owner, seller, ...ids };
}

/** Row counts of every table the Offline domains added, for one tenant (bypass client, explicit filter). */
async function offlineCounts(tenantId: string) {
  const where = { tenantId };
  return {
    salesChannels: await prismaBase.salesChannel.count({ where }),
    channelLocations: await prismaBase.salesChannelLocation.count({ where }),
    productChannels: await prismaBase.productSalesChannel.count({ where }),
    barcodes: await prismaBase.barcode.count({ where }),
    suppliers: await prismaBase.supplier.count({ where }),
    receptions: await prismaBase.reception.count({ where }),
    receptionLines: await prismaBase.receptionLine.count({ where }),
    supplierPayments: await prismaBase.supplierPayment.count({ where }),
    sales: await prismaBase.sale.count({ where }),
    saleLines: await prismaBase.saleLine.count({ where }),
    salePayments: await prismaBase.salePayment.count({ where }),
    saleReturns: await prismaBase.saleReturn.count({ where }),
    saleReturnLines: await prismaBase.saleReturnLine.count({ where }),
    movements: await prismaBase.inventoryMovement.count({ where: { inventoryItem: { tenantId } } }),
    userChannels: await prismaBase.userChannel.count({ where }),
    overrides: await prismaBase.userPermissionOverride.count({ where }),
  };
}

describe("backup & restore of the Offline domains", () => {
  it("a same-tenant restore brings back every Offline table, with its document links and the per-user channel access", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const g = await seedOfflineGraph(DEFAULT_TENANT_ID);
    const before = await offlineCounts(DEFAULT_TENANT_ID);
    expect(before.sales).toBe(1);
    expect(before.saleReturns).toBe(1);
    expect(before.receptions).toBe(1);
    expect(before.userChannels).toBeGreaterThan(0);

    const backup = await buildTenantBackup({ tenantId: DEFAULT_TENANT_ID, createdByUserId: null });
    const inspected = inspectBackup(backup.container);
    expect(inspected.valid).toBe(true);
    await restoreTenantBackup({ activeTenantId: DEFAULT_TENANT_ID, inspected });

    const after = await offlineCounts(DEFAULT_TENANT_ID);
    expect(after.salesChannels).toBe(before.salesChannels);
    expect(after.channelLocations).toBe(before.channelLocations);
    expect(after.productChannels).toBe(before.productChannels);
    expect(after.barcodes).toBe(before.barcodes);
    expect(after.suppliers).toBe(before.suppliers);
    expect(after.receptions).toBe(before.receptions);
    expect(after.receptionLines).toBe(before.receptionLines);
    expect(after.supplierPayments).toBe(before.supplierPayments);
    expect(after.sales).toBe(before.sales);
    expect(after.saleLines).toBe(before.saleLines);
    expect(after.salePayments).toBe(before.salePayments);
    expect(after.saleReturns).toBe(before.saleReturns);
    expect(after.saleReturnLines).toBe(before.saleReturnLines);
    expect(after.movements).toBe(before.movements);

    // Ledger provenance survives the round trip.
    const linked = await prismaBase.inventoryMovement.findMany({
      where: { inventoryItem: { tenantId: DEFAULT_TENANT_ID } },
      select: { type: true, receptionLineId: true, saleId: true, saleReturnId: true, onHandAfter: true },
    });
    expect(linked.filter((m) => m.receptionLineId).length).toBe(1);
    expect(linked.filter((m) => m.saleId).length).toBeGreaterThanOrEqual(2);
    expect(linked.filter((m) => m.saleReturnId).length).toBe(2);

    // Per-user access configuration is NOT part of a backup — but a restore must
    // never silently ERASE it (that would lock operators out of their channels).
    expect(after.userChannels).toBe(before.userChannels);
    expect(after.overrides).toBe(before.overrides);
    expect(await prismaBase.userLocation.count({ where: { userId: g.seller.id } })).toBe(1);
  });
});

describe("tenant deletion with Offline data", () => {
  it("deletes every Offline table, the per-user access rows and the tenant, and leaves another tenant untouched", async () => {
    const B = "tenant-b-offline-delete";
    await prismaBase.tenant.create({ data: { id: B, name: "B", slug: B, businessMode: "ONLINE_AND_OFFLINE" } });
    await seedOfflineGraph(B);
    expect((await offlineCounts(B)).sales).toBe(1);

    // Another tenant with its own Offline data must survive.
    mockCookieStore.clear();
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await seedOfflineGraph(DEFAULT_TENANT_ID);
    const aBefore = await offlineCounts(DEFAULT_TENANT_ID);

    await deleteTenantData(B);

    expect(await prismaBase.tenant.findUnique({ where: { id: B } })).toBeNull();
    const gone = await offlineCounts(B);
    expect(Object.values(gone).every((n) => n === 0)).toBe(true);
    expect(await prismaBase.userLocation.count({ where: { tenantId: B } })).toBe(0);
    expect(await offlineCounts(DEFAULT_TENANT_ID)).toEqual(aBefore);
    void createSession; // (kept for parity with the other maintenance tests)
  });
});
