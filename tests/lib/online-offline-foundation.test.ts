import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { applyStockMovement, InsufficientStockError } from "@/lib/inventory";
import {
  ensureDefaultOnlineChannel,
  getDefaultOnlineChannelId,
  isProductAvailableOnChannel,
  listChannelWarehouseIds,
} from "@/lib/channels";
import { removeProductAction } from "@/actions/products";
import { createWarehouseAction } from "@/actions/warehouses";
import { deleteUserAction } from "@/actions/users";
import { createOrderAction } from "@/actions/orders";
import { provisionTenantBaseline } from "@/lib/tenant/provision";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Online/Offline unification — phases A (ledger hardening) and C (business
 * channels). docs/adr/0038-online-offline-unification.md.
 */

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function seedStock(onHand: number, reserved = 0) {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({
    data: { name: "Coffret", sku: `SKU-${Math.random()}`, price: 100, status: "ACTIF" },
  });
  const item = await prisma.inventoryItem.create({
    data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: onHand, quantityReserved: reserved },
  });
  return { warehouse, product, item };
}

beforeEach(async () => {
  await resetDb();
  // These suites cover the Offline capabilities, which exist only in an
  // ONLINE_AND_OFFLINE tenant (docs/adr/0041).
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("ledger hardening — applyStockMovement", () => {
  it("records the signed on-hand delta and the running balance on every new movement", async () => {
    const { warehouse, product } = await seedStock(10);

    await prisma.$transaction(async (tx) => {
      await applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "VENTE",
        quantity: 4,
        onHandDelta: -4,
      });
      await applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "RECEPTION",
        quantity: 7,
        onHandDelta: 7,
        unitCost: "12.50",
      });
    });

    const [sale, reception] = await prisma.inventoryMovement.findMany({ orderBy: { createdAt: "asc" } });
    expect(sale.onHandDelta).toBe(-4);
    expect(sale.onHandAfter).toBe(6);
    expect(sale.unitCost).toBeNull();
    expect(reception.onHandDelta).toBe(7);
    expect(reception.onHandAfter).toBe(13);
    expect(Number(reception.unitCost)).toBe(12.5);
    // `quantity` keeps its historical meaning: an unsigned magnitude.
    expect(sale.quantity).toBe(4);
  });

  it("a pure reservation records a zero on-hand delta", async () => {
    const { warehouse, product } = await seedStock(10);
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "RESERVATION",
        quantity: 3,
        onHandDelta: 0,
        reservedDelta: 3,
      })
    );
    const m = await prisma.inventoryMovement.findFirstOrThrow();
    expect(m.onHandDelta).toBe(0);
    expect(m.onHandAfter).toBe(10);
  });

  it("DEFAULT behaviour is unchanged: consuming reserved units is still allowed while on-hand stays >= 0", async () => {
    // 10 on hand, 8 reserved => only 2 available. The order lifecycle's own
    // fulfilment consumes reserved units, so the default primitive must keep
    // allowing an on-hand decrement beyond `available`.
    const { warehouse, product, item } = await seedStock(10, 8);
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "VENTE",
        quantity: 5,
        onHandDelta: -5,
      })
    );
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(5);
  });

  it("enforceAvailable refuses to consume units reserved for another transaction, atomically", async () => {
    const { warehouse, product, item } = await seedStock(10, 8); // available = 2
    await expect(
      prisma.$transaction((tx) =>
        applyStockMovement(tx, {
          warehouseId: warehouse.id,
          productId: product.id,
          type: "VENTE",
          quantity: 3,
          onHandDelta: -3,
          enforceAvailable: true,
        })
      )
    ).rejects.toBeInstanceOf(InsufficientStockError);

    // Fully rolled back: quantities untouched, no movement row.
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.quantityOnHand).toBe(10);
    expect(after.quantityReserved).toBe(8);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("enforceAvailable allows exactly the available quantity", async () => {
    const { warehouse, product, item } = await seedStock(10, 8);
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "VENTE",
        quantity: 2,
        onHandDelta: -2,
        enforceAvailable: true,
      })
    );
    const after = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.quantityOnHand).toBe(8);
    expect(after.quantityReserved).toBe(8);
  });

  it("on-hand can never go negative (unchanged invariant)", async () => {
    const { warehouse, product } = await seedStock(3);
    await expect(
      prisma.$transaction((tx) =>
        applyStockMovement(tx, {
          warehouseId: warehouse.id,
          productId: product.id,
          type: "VENTE",
          quantity: 4,
          onHandDelta: -4,
        })
      )
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });
});

describe("ledger protection — history is never destroyed by a delete", () => {
  it("removeProductAction ARCHIVES a never-sold product that has stock movements", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product } = await seedStock(10);
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "AJUSTEMENT_POSITIF",
        quantity: 5,
        onHandDelta: 5,
      })
    );

    const result = await removeProductAction(formData({ productId: product.id }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deleted).toBe(false);

    expect((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).status).toBe("ARCHIVE");
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });

  it("removeProductAction ARCHIVES when only a VARIATION has movements", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const warehouse = await prisma.warehouse.create({ data: { name: "E", isDefault: true } });
    const product = await prisma.product.create({ data: { name: "P", sku: "P-VAR", price: 10, status: "ACTIF" } });
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: "P-VAR-1", attributes: { Couleur: "Bleu" } },
    });
    await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, variationId: variation.id, quantityOnHand: 1 } });
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        variationId: variation.id,
        type: "AJUSTEMENT_POSITIF",
        quantity: 2,
        onHandDelta: 2,
      })
    );

    const result = await removeProductAction(formData({ productId: product.id }));
    expect(result.ok && result.data.deleted).toBe(false);
    expect(await prisma.inventoryMovement.count()).toBe(1);
  });

  it("removeProductAction still hard-deletes a product with no history at all", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seedStock(0);
    const result = await removeProductAction(formData({ productId: product.id }));
    expect(result.ok && result.data.deleted).toBe(true);
    expect(await prisma.product.count({ where: { id: product.id } })).toBe(0);
  });

  it("deleting a user snapshots their name onto the movements they performed", async () => {
    const admin = await loginAsTestUser({ role: "OWNER" });
    const worker = await createTestUser({ role: "WAREHOUSE", email: "worker-del@asoditech.test" });
    const { warehouse, product } = await seedStock(10);
    await prisma.$transaction((tx) =>
      applyStockMovement(tx, {
        warehouseId: warehouse.id,
        productId: product.id,
        type: "AJUSTEMENT_POSITIF",
        quantity: 1,
        onHandDelta: 1,
        performedById: worker.id,
      })
    );

    const result = await deleteUserAction(formData({ id: worker.id, confirmEmail: worker.email }));
    expect(result.ok).toBe(true);
    expect(admin.id).not.toBe(worker.id);

    const m = await prisma.inventoryMovement.findFirstOrThrow();
    expect(m.performedById).toBeNull(); // FK semantics unchanged (SetNull)
    expect(m.performedByName).toBe(worker.name); // …but WHO is no longer lost
  });
});

describe("business channels", () => {
  it("ensureDefaultOnlineChannel creates exactly one default ONLINE channel, idempotently", async () => {
    const a = await ensureDefaultOnlineChannel();
    const b = await ensureDefaultOnlineChannel();
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("ONLINE");
    expect(a.isDefault).toBe(true);
    expect(await prisma.salesChannel.count()).toBe(1);
  });

  it("maps active ENTREPOTs and Shopify locations to the default channel — never a MAGASIN or an inactive location", async () => {
    const entrepot = await prisma.warehouse.create({ data: { name: "Entrepôt", type: "ENTREPOT", isDefault: true } });
    const magasin = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN" } });
    const inactive = await prisma.warehouse.create({ data: { name: "Ancien", type: "ENTREPOT", isActive: false } });
    const shopify = await prisma.warehouse.create({
      data: { name: "Shopify loc", type: "MAGASIN", source: "SHOPIFY", externalId: "gid://shopify/Location/1" },
    });

    const channel = await ensureDefaultOnlineChannel();
    const ids = await listChannelWarehouseIds(prisma, channel.id);
    expect(ids.sort()).toEqual([entrepot.id, shopify.id].sort());
    expect(ids).not.toContain(magasin.id);
    expect(ids).not.toContain(inactive.id);
  });

  it("the channel↔location mapping stores NO quantity (channel stock is derived, never duplicated)", async () => {
    const cols = await prismaBase.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('sales_channels','sales_channel_locations','product_sales_channels','user_channels')`;
    const names = cols.map((c) => c.column_name.toLowerCase());
    expect(names.some((n) => n.includes("quantity") || n.includes("stock") || n.includes("onhand"))).toBe(false);
  });

  it("createWarehouseAction auto-maps a new ENTREPOT to the default ONLINE channel, but not a MAGASIN", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prisma.warehouse.create({ data: { name: "Défaut", isDefault: true, type: "ENTREPOT" } });

    const e = await createWarehouseAction(formData({ name: "Second entrepôt", type: "ENTREPOT" }));
    const m = await createWarehouseAction(formData({ name: "Boutique Rabat", type: "MAGASIN" }));
    expect(e.ok && m.ok).toBe(true);

    const channelId = await getDefaultOnlineChannelId();
    const mapped = await listChannelWarehouseIds(prisma, channelId);
    if (e.ok) expect(mapped).toContain(e.data.id);
    if (m.ok) expect(mapped).not.toContain(m.data.id);
  });

  it("createOrderAction attributes a new delivery order to the default ONLINE channel and leaves the lifecycle untouched", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seedStock(10);
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });

    const result = await createOrderAction({
      customerId: customer.id,
      paymentMethod: "PAIEMENT_LIVRAISON",
      currency: "MAD",
      shippingCost: 0,
      discountTotal: 0,
      items: [{ productId: product.id, quantity: 2, unitPrice: 100, discount: 0 }],
    } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.data.id } });
    const channel = await prisma.salesChannel.findFirstOrThrow({ where: { isDefault: true } });
    expect(order.salesChannelId).toBe(channel.id);
    expect(order.status).toBe("NOUVELLE"); // lifecycle unchanged
    // No stock effect at creation (ADR 0030 — reservation happens at CONFIRMEE).
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { productId: product.id } });
    expect(item.quantityReserved).toBe(0);
    expect(item.quantityOnHand).toBe(10);
  });

  it("product availability is a relation only — enabling a product on a channel changes no stock", async () => {
    const { product, item } = await seedStock(10);
    const channel = await ensureDefaultOnlineChannel();
    expect(await isProductAvailableOnChannel(prisma, product.id, channel.id)).toBe(false);
    await prisma.productSalesChannel.create({ data: { productId: product.id, salesChannelId: channel.id } });
    expect(await isProductAvailableOnChannel(prisma, product.id, channel.id)).toBe(true);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(10);
  });

  it("provisionTenantBaseline gives a new tenant its default channel, mapped to its default warehouse (idempotent)", async () => {
    await prismaBase.tenant.create({ data: { id: "tenant-chan", name: "T", slug: "tenant-chan" } });
    const first = await provisionTenantBaseline("tenant-chan");
    const second = await provisionTenantBaseline("tenant-chan");
    expect(first.channelCreated).toBe(true);
    expect(second.channelCreated).toBe(false);

    const channels = await prismaBase.salesChannel.findMany({ where: { tenantId: "tenant-chan" } });
    expect(channels).toHaveLength(1);
    const locs = await prismaBase.salesChannelLocation.findMany({ where: { tenantId: "tenant-chan" } });
    const wh = await prismaBase.warehouse.findFirstOrThrow({ where: { tenantId: "tenant-chan", isDefault: true } });
    expect(locs.map((l) => l.warehouseId)).toEqual([wh.id]);
  });
});

describe("tenant isolation — channels, mappings, availability", () => {
  const TENANT_B = "tenant-b-channels";

  it("a tenant-A session cannot see tenant B's channels, mappings or product availability", async () => {
    await loginAsTestUser({ role: "ADMIN" }); // tenant A (default)
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const wB = await prismaBase.warehouse.create({ data: { name: "WB", isDefault: true, tenantId: TENANT_B } });
    const pB = await prismaBase.product.create({ data: { name: "PB", sku: "PB", price: 1, tenantId: TENANT_B } });
    const cB = await prismaBase.salesChannel.create({
      data: { name: "En ligne", kind: "ONLINE", isDefault: true, tenantId: TENANT_B },
    });
    await prismaBase.salesChannelLocation.create({ data: { salesChannelId: cB.id, warehouseId: wB.id, tenantId: TENANT_B } });
    await prismaBase.productSalesChannel.create({ data: { productId: pB.id, salesChannelId: cB.id, tenantId: TENANT_B } });

    await ensureDefaultOnlineChannel(); // tenant A gets its OWN channel, not B's

    expect((await prisma.salesChannel.findMany()).every((c) => c.tenantId !== TENANT_B)).toBe(true);
    expect(await prisma.salesChannelLocation.count()).toBe(0); // A has no warehouse => nothing mapped
    expect(await prisma.productSalesChannel.count()).toBe(0);
    expect(await prisma.salesChannel.findUnique({ where: { id: cB.id } })).toBeNull();
    // Two tenants can each have their own default ONLINE channel called "En ligne".
    expect(await prismaBase.salesChannel.count({ where: { isDefault: true } })).toBe(2);
  });
});
