import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import {
  addBarcodeAction,
  removeBarcodeAction,
  setPrimaryBarcodeAction,
  updateProductReferenceAction,
  setProductChannelsAction,
  lookupSellableUnitsAction,
} from "@/actions/catalog";
import {
  createProductAction,
  createProductVariationAction,
  updateProductAction,
  createCategoryAction,
} from "@/actions/products";
import { searchProductsForOrderAction } from "@/actions/orders";
import { quickSearchAction } from "@/actions/search";
import { listProducts } from "@/lib/queries/products";
import { ensureDefaultOnlineChannel } from "@/lib/channels";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Catalog identity (docs/adr/0038): reference, barcode, variant-level
 * lookup, category, channel availability. Phase B.
 */

function formData(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) value.forEach((v) => fd.append(key, v));
    else fd.set(key, value);
  }
  return fd;
}

async function seedProduct(sku: string, name = "Produit " + sku, extra: Record<string, unknown> = {}) {
  return prisma.product.create({ data: { name, sku, price: 100, status: "ACTIF", ...extra } });
}

/** Adidas SKOUBA — a variable product with colour/size variations. */
async function seedSkouba() {
  const product = await seedProduct("SKOUBA-PARENT", "Adidas SKOUBA", { reference: "SKOUBA" });
  const variations = [];
  for (const [color, size] of [
    ["Bleu", "41"],
    ["Bleu", "42"],
    ["Gris", "41"],
  ]) {
    variations.push(
      await prisma.productVariation.create({
        data: { productId: product.id, sku: `SKOUBA-${color[0]}-${size}`, attributes: { Couleur: color, Taille: size } },
      })
    );
  }
  return { product, variations };
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

describe("barcodes — ownership and uniqueness", () => {
  it("attaches a barcode to a simple product; the first one becomes primary", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await seedProduct("SIMPLE-1");
    const r1 = await addBarcodeAction({ productId: p.id, code: "2000000013480" });
    const r2 = await addBarcodeAction({ productId: p.id, code: "ALT-CODE-1" });
    expect(r1.ok && r2.ok).toBe(true);
    const rows = await prisma.barcode.findMany({ where: { productId: p.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((b) => [b.code, b.isPrimary])).toEqual([
      ["2000000013480", true],
      ["ALT-CODE-1", false],
    ]);
  });

  it("makePrimary promotes the new code and demotes the old one (one primary per unit)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await seedProduct("SIMPLE-2");
    await addBarcodeAction({ productId: p.id, code: "CODE-AAA" });
    await addBarcodeAction({ productId: p.id, code: "CODE-BBB", makePrimary: true });
    const rows = await prisma.barcode.findMany({ where: { productId: p.id } });
    expect(rows.filter((b) => b.isPrimary).map((b) => b.code)).toEqual(["CODE-BBB"]);
  });

  it("setPrimaryBarcodeAction and removeBarcodeAction keep exactly one primary", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await seedProduct("SIMPLE-3");
    await addBarcodeAction({ productId: p.id, code: "CODE-111" });
    const second = await addBarcodeAction({ productId: p.id, code: "CODE-222" });
    if (!second.ok) throw new Error("setup");
    await setPrimaryBarcodeAction({ barcodeId: second.data.id });
    expect((await prisma.barcode.findMany({ where: { productId: p.id, isPrimary: true } })).map((b) => b.code)).toEqual([
      "CODE-222",
    ]);
    // removing the primary promotes the remaining one
    await removeBarcodeAction({ barcodeId: second.data.id });
    const left = await prisma.barcode.findMany({ where: { productId: p.id } });
    expect(left).toHaveLength(1);
    expect(left[0].isPrimary).toBe(true);
  });

  it("refuses a barcode already used by ANOTHER unit (tenant-wide uniqueness across products and variations)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { variations } = await seedSkouba();
    const other = await seedProduct("OTHER-1");
    expect((await addBarcodeAction({ variationId: variations[0].id, code: "SHARED-CODE" })).ok).toBe(true);

    const dupOnProduct = await addBarcodeAction({ productId: other.id, code: "SHARED-CODE" });
    expect(dupOnProduct.ok).toBe(false);
    const dupOnVariation = await addBarcodeAction({ variationId: variations[1].id, code: "SHARED-CODE" });
    expect(dupOnVariation.ok).toBe(false);
    expect(await prisma.barcode.count({ where: { code: "SHARED-CODE" } })).toBe(1);
  });

  it("refuses a barcode on a VARIABLE parent — it belongs on each variation", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seedSkouba();
    const r = await addBarcodeAction({ productId: product.id, code: "PARENT-CODE" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/variation/i);
  });

  it("refuses a barcode equal to another unit's SKU (it would shadow it in scan lookup)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await seedProduct("REAL-SKU-1");
    const other = await seedProduct("OTHER-2");
    const r = await addBarcodeAction({ productId: other.id, code: "REAL-SKU-1" });
    expect(r.ok).toBe(false);
  });

  it("rejects an invalid barcode shape and an empty one", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await seedProduct("SIMPLE-4");
    expect((await addBarcodeAction({ productId: p.id, code: "no spaces allowed" })).ok).toBe(false);
    expect((await addBarcodeAction({ productId: p.id, code: "  " })).ok).toBe(false);
    expect((await addBarcodeAction({ productId: p.id, code: "ab" })).ok).toBe(false);
  });

  it("DB rejects a barcode with BOTH or NEITHER owner (XOR CHECK)", async () => {
    const p = await seedProduct("SIMPLE-5");
    const v = await prisma.productVariation.create({ data: { productId: p.id, sku: "SIMPLE-5-V", attributes: {} } });
    await expect(
      prismaBase.barcode.create({ data: { code: "BOTH-OWNERS", productId: p.id, variationId: v.id, tenantId: "default" } })
    ).rejects.toThrow();
    await expect(prismaBase.barcode.create({ data: { code: "NO-OWNER", tenantId: "default" } })).rejects.toThrow();
  });

  it("requires products.edit", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const p = await seedProduct("SIMPLE-6");
    await expect(addBarcodeAction({ productId: p.id, code: "NOPE-CODE" })).rejects.toThrow(/non autorisé/i);
  });

  it("barcode / reference / channels stay editable on a WooCommerce-sourced product (ADR 0017: ASODITECH-owned)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const woo = await seedProduct("WOO-1", "Produit Woo", { source: "WOOCOMMERCE", externalId: "42" });
    expect((await addBarcodeAction({ productId: woo.id, code: "WOO-BARCODE" })).ok).toBe(true);
    expect((await updateProductReferenceAction({ productId: woo.id, reference: "MODEL-W" })).ok).toBe(true);
    // …but its DEFINITION is still provider-owned:
    const edit = await updateProductAction(
      formData({ id: woo.id, name: "Renommé", sku: "WOO-1", price: "100", status: "ACTIF" })
    );
    expect(edit.ok).toBe(false);
  });
});

describe("product creation — identity, category and channels", () => {
  it("creates a product with reference, barcode and channel availability atomically", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const offline = await prisma.salesChannel.create({ data: { name: "Magasin Casablanca", kind: "OFFLINE" } });
    const category = await prisma.category.create({ data: { name: "Chaussures", slug: "chaussures" } });

    const r = await createProductAction(
      formData({
        name: "Basket Test",
        sku: "BASKET-1",
        price: "250",
        status: "ACTIF",
        reference: "BASKET",
        barcode: "6111111111111",
        categoryId: category.id,
        channelsSubmitted: "1",
        salesChannelIds: [offline.id],
        trackInventory: "on",
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = await prisma.product.findUniqueOrThrow({
      where: { id: r.data.id },
      include: { barcodes: true, salesChannels: true },
    });
    expect(p.reference).toBe("BASKET");
    expect(p.categoryId).toBe(category.id);
    expect(p.barcodes.map((b) => [b.code, b.isPrimary])).toEqual([["6111111111111", true]]);
    // Offline-only: available on the store channel and NOT on the default online one.
    expect(p.salesChannels.map((c) => c.salesChannelId)).toEqual([offline.id]);
  });

  it("a caller that sends no channel field keeps the legacy behaviour: sellable on the default ONLINE channel", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const r = await createProductAction(formData({ name: "Legacy Produit", sku: "LEGACY-1", price: "10", status: "ACTIF" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const online = await ensureDefaultOnlineChannel();
    const rows = await prisma.productSalesChannel.findMany({ where: { productId: r.data.id } });
    expect(rows.map((x) => x.salesChannelId)).toEqual([online.id]);
  });

  it("a product with NO channel ticked is not available anywhere (explicit 'none')", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const r = await createProductAction(
      formData({ name: "Nulle part", sku: "NOWHERE-1", price: "10", status: "BROUILLON", channelsSubmitted: "1" })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(await prisma.productSalesChannel.count({ where: { productId: r.data.id } })).toBe(0);
  });

  it("rejects a duplicate barcode at creation without leaving a half-created product", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const first = await seedProduct("HAS-CODE");
    await addBarcodeAction({ productId: first.id, code: "TAKEN-CODE" });
    const r = await createProductAction(
      formData({ name: "Second", sku: "SECOND-1", price: "10", status: "ACTIF", barcode: "TAKEN-CODE" })
    );
    expect(r.ok).toBe(false);
    expect(await prisma.product.count({ where: { sku: "SECOND-1" } })).toBe(0);
  });

  it("cross-table reference guard: a product SKU cannot equal a variation SKU or a barcode", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { variations } = await seedSkouba();
    const clashVariation = await createProductAction(
      formData({ name: "Clash", sku: variations[0].sku, price: "10", status: "ACTIF" })
    );
    expect(clashVariation.ok).toBe(false);

    const p = await seedProduct("HAS-CODE-2");
    await addBarcodeAction({ productId: p.id, code: "BARCODE-AS-SKU" });
    const clashBarcode = await createProductAction(
      formData({ name: "Clash2", sku: "BARCODE-AS-SKU", price: "10", status: "ACTIF" })
    );
    expect(clashBarcode.ok).toBe(false);
  });

  it("createProductAction still reports the original message for a plain duplicate product SKU", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await seedProduct("DUP-SKU");
    const r = await createProductAction(formData({ name: "Dup", sku: "DUP-SKU", price: "10", status: "ACTIF" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Un produit avec ce SKU existe déjà.");
  });

  it("a variation can be created with its own barcode, and a variation SKU cannot equal a product SKU", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const parent = await seedProduct("PARENT-1");
    await seedProduct("TAKEN-BY-PRODUCT");
    const ok = await createProductVariationAction(
      formData({
        productId: parent.id,
        sku: "PARENT-1-BLEU-42",
        barcode: "6222222222222",
        attributes: JSON.stringify({ Couleur: "Bleu", Taille: "42" }),
      })
    );
    expect(ok.ok).toBe(true);
    const v = await prisma.productVariation.findFirstOrThrow({ where: { sku: "PARENT-1-BLEU-42" }, include: { barcodes: true } });
    expect(v.barcodes.map((b) => b.code)).toEqual(["6222222222222"]);

    const clash = await createProductVariationAction(
      formData({ productId: parent.id, sku: "TAKEN-BY-PRODUCT", attributes: "{}" })
    );
    expect(clash.ok).toBe(false);
  });

  it("categories are real entities: created inline (slug derived), assignable, filterable, tenant-scoped", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const c = await createCategoryAction(formData({ name: "Chaussures Homme" }));
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.data.slug).toBe("chaussures-homme");

    const dup = await createCategoryAction(formData({ name: "Chaussures  Homme" }));
    expect(dup.ok).toBe(false); // same derived slug

    const p = await createProductAction(
      formData({ name: "Mocassin", sku: "MOCA-1", price: "300", status: "ACTIF", categoryId: c.data.id })
    );
    expect(p.ok).toBe(true);
    const filtered = await listProducts({ categoryId: c.data.id });
    expect(filtered.products.map((x) => x.sku)).toEqual(["MOCA-1"]);
  });
});

describe("variant-level lookup and search", () => {
  it("a scan resolves to EXACTLY the variation carrying that barcode", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { variations } = await seedSkouba();
    await addBarcodeAction({ variationId: variations[1].id, code: "BLUE-42-CODE" });

    const hits = await lookupSellableUnitsAction({ query: "BLUE-42-CODE" });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      variationId: variations[1].id,
      matchedBy: "barcode",
      primaryBarcode: "BLUE-42-CODE",
      reference: "SKOUBA",
    });
    // Attribute order is whatever JSONB stores (it does not preserve key
    // order), so compare the label's parts, not their sequence.
    expect(hits[0].variantLabel!.split(" / ").sort()).toEqual(["42", "Bleu"]);
  });

  it("priority: barcode beats an equal-looking SKU; SKU beats a partial name match", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { variations } = await seedSkouba();
    const hitsBySku = await lookupSellableUnitsAction({ query: variations[0].sku.toLowerCase() });
    expect(hitsBySku).toHaveLength(1);
    expect(hitsBySku[0].matchedBy).toBe("sku");
    expect(hitsBySku[0].variationId).toBe(variations[0].id);

    const hitsByName = await lookupSellableUnitsAction({ query: "skouba" });
    // the variable parent is expanded into its 3 variations (never a unit itself)
    expect(hitsByName).toHaveLength(3);
    expect(hitsByName.every((u) => u.variationId !== null && u.matchedBy === "partial")).toBe(true);
  });

  it("an unknown scan returns nothing (no fuzzy fallback for an exact code)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await seedSkouba();
    expect(await lookupSellableUnitsAction({ query: "0000000000000" })).toEqual([]);
  });

  it("does not parse codes: size/colour come from attributes, never from the barcode string", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { variations } = await seedSkouba();
    // A code that "looks like" another size still resolves only by exact match.
    await addBarcodeAction({ variationId: variations[0].id, code: "SIZE-99-BLEU" });
    const hits = await lookupSellableUnitsAction({ query: "SIZE-99-BLEU" });
    expect(hits[0].variantLabel!.split(" / ").sort()).toEqual(["41", "Bleu"]);
  });

  it("the channel filter only returns products enabled on that channel", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const offline = await prisma.salesChannel.create({ data: { name: "Magasin A", kind: "OFFLINE" } });
    const onlyOnline = await seedProduct("ONLINE-ONLY", "Écharpe");
    const both = await seedProduct("BOTH-CH", "Écharpe duo");
    const online = await ensureDefaultOnlineChannel();
    await prisma.productSalesChannel.createMany({
      data: [
        { productId: onlyOnline.id, salesChannelId: online.id },
        { productId: both.id, salesChannelId: online.id },
        { productId: both.id, salesChannelId: offline.id },
      ],
    });
    const atStore = await lookupSellableUnitsAction({ query: "Écharpe", channelId: offline.id });
    expect(atStore.map((u) => u.sku)).toEqual(["BOTH-CH"]);
  });

  it("the product list, order-form picker and global search all find a product by variant SKU, barcode and reference", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product, variations } = await seedSkouba();
    await addBarcodeAction({ variationId: variations[2].id, code: "GREY-41-CODE" });

    for (const q of ["SKOUBA-G-41", "GREY-41-CODE", "SKOUBA"]) {
      const list = await listProducts({ q });
      expect(list.products.map((p) => p.id)).toContain(product.id);
      const picker = await searchProductsForOrderAction(q);
      expect(picker.map((p) => p.id)).toContain(product.id);
      const global = await quickSearchAction(q);
      expect(global.some((r) => r.id === product.id)).toBe(true);
    }
  });
});

describe("channel availability actions", () => {
  it("setProductChannelsAction replaces the set, stores no quantity, and rejects an unknown channel", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const p = await seedProduct("CH-1");
    const online = await ensureDefaultOnlineChannel();
    const store = await prisma.salesChannel.create({ data: { name: "Magasin B", kind: "OFFLINE" } });

    expect((await setProductChannelsAction({ productId: p.id, salesChannelIds: [online.id, store.id] })).ok).toBe(true);
    expect(await prisma.productSalesChannel.count({ where: { productId: p.id } })).toBe(2);
    expect((await setProductChannelsAction({ productId: p.id, salesChannelIds: [store.id] })).ok).toBe(true);
    expect((await prisma.productSalesChannel.findMany({ where: { productId: p.id } })).map((r) => r.salesChannelId)).toEqual([
      store.id,
    ]);
    expect((await setProductChannelsAction({ productId: p.id, salesChannelIds: ["nope"] })).ok).toBe(false);
    // Nothing stock-related moved.
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });
});

describe("tenant isolation — barcodes", () => {
  it("the same code can exist in two tenants; a tenant-A scan never sees tenant B's product", async () => {
    await loginAsTestUser({ role: "ADMIN" }); // tenant A
    const pA = await seedProduct("A-1");
    await addBarcodeAction({ productId: pA.id, code: "SAME-CODE-1" });

    await prismaBase.tenant.create({ data: { id: "tenant-b-bc", name: "B", slug: "tenant-b-bc" } });
    const pB = await prismaBase.product.create({
      data: { name: "Produit B", sku: "B-1", price: 1, status: "ACTIF", tenantId: "tenant-b-bc" },
    });
    // Same code, other tenant: allowed (unique per tenant, not global).
    await prismaBase.barcode.create({ data: { code: "SAME-CODE-1", productId: pB.id, tenantId: "tenant-b-bc" } });
    await prismaBase.barcode.create({ data: { code: "B-ONLY-CODE", productId: pB.id, tenantId: "tenant-b-bc" } });

    const hitsSame = await lookupSellableUnitsAction({ query: "SAME-CODE-1" });
    expect(hitsSame.map((u) => u.productId)).toEqual([pA.id]);
    expect(await lookupSellableUnitsAction({ query: "B-ONLY-CODE" })).toEqual([]);
    expect(await prisma.barcode.count()).toBe(1);
  });
});
