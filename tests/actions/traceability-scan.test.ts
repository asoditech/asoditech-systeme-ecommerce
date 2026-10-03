import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/session";
import { requirePermission } from "@/lib/auth/guards";
import { findTraceUnits, getUnitTraceability } from "@/lib/queries/traceability";
import { inactiveUnitLabel, traceabilitySearchHref } from "@/lib/traceability-scan";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Traçabilité camera scan (TraceScanButton → `?q=<code>` → the page's own
 * findTraceUnits/getUnitTraceability). A scan is a read-only search: these
 * tests cover the URL it builds, what the lookup returns for scanned,
 * unknown and archived codes, that nothing is written, that a scoped user
 * only sees their own location, and that the page stays permission-gated.
 */

beforeEach(async () => {
  await resetDb();
  await setTestBusinessMode("ONLINE_AND_OFFLINE");
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

const SCANNED = "6111000000017";

async function seed() {
  const whA = await prisma.warehouse.create({ data: { name: "Magasin A", type: "MAGASIN", isDefault: true } });
  const whB = await prisma.warehouse.create({ data: { name: "Magasin B", type: "MAGASIN" } });
  const chA = await prisma.salesChannel.create({ data: { name: "Canal A", kind: "OFFLINE" } });
  await prisma.salesChannelLocation.create({ data: { salesChannelId: chA.id, warehouseId: whA.id } });
  const product = await prisma.product.create({ data: { name: "Polo Classic", sku: "POLO-1", price: 150, status: "ACTIF" } });
  await prisma.barcode.create({ data: { code: SCANNED, productId: product.id, isPrimary: true } });
  await prisma.inventoryItem.create({ data: { warehouseId: whA.id, productId: product.id, quantityOnHand: 7 } });
  await prisma.inventoryItem.create({ data: { warehouseId: whB.id, productId: product.id, quantityOnHand: 30 } });
  return { whA, whB, chA, product };
}

async function writeCounts() {
  const [movements, audits, sales, receptions, items] = await Promise.all([
    prismaBase.inventoryMovement.count(),
    prismaBase.auditEvent.count(),
    prismaBase.sale.count(),
    prismaBase.reception.count(),
    prismaBase.inventoryItem.findMany({ select: { id: true, quantityOnHand: true, quantityReserved: true }, orderBy: { id: "asc" } }),
  ]);
  return { movements, audits, sales, receptions, items };
}

describe("traceabilitySearchHref — the URL a scan navigates to", () => {
  it("builds the page's own ?q= search with the trimmed, encoded code", () => {
    expect(traceabilitySearchHref(`  ${SCANNED} `)).toBe(`/tracabilite?q=${SCANNED}`);
    expect(traceabilitySearchHref("REF 12/A+B")).toBe("/tracabilite?q=REF+12%2FA%2BB");
    expect(new URLSearchParams(traceabilitySearchHref("REF 12/A+B")!.split("?")[1]).get("q")).toBe("REF 12/A+B");
  });

  it("drops any previously chosen unit and ignores an empty scan", () => {
    expect(traceabilitySearchHref(SCANNED)).not.toContain("unit=");
    expect(traceabilitySearchHref("   ")).toBeNull();
    expect(traceabilitySearchHref(null)).toBeNull();
  });

  it("labels only non-active statuses", () => {
    expect(inactiveUnitLabel("ACTIF")).toBeNull();
    expect(inactiveUnitLabel("ARCHIVE")).toBe("Archivé");
    expect(inactiveUnitLabel("BROUILLON")).toBe("Brouillon");
  });
});

describe("Traçabilité lookup for a scanned code", () => {
  it("a scanned barcode resolves to exactly its unit, and the lookup writes nothing", async () => {
    const { product } = await seed();
    await loginAsTestUser({ role: "ADMIN" });
    const before = await writeCounts();

    const units = await findTraceUnits(SCANNED);
    expect(units).toHaveLength(1);
    expect(units[0].productId).toBe(product.id);
    expect(units[0].variationId).toBeNull();
    const trace = await getUnitTraceability((await getCurrentUser())!, { productId: product.id, variationId: null });
    expect(trace?.identity.barcodes.map((b) => b.code)).toContain(SCANNED);

    expect(await writeCounts()).toEqual(before);
  });

  it("an unknown code finds nothing (the page shows « Aucun article trouvé. ») and writes nothing", async () => {
    await seed();
    await loginAsTestUser({ role: "ADMIN" });
    const before = await writeCounts();
    expect(await findTraceUnits("0000000000000")).toEqual([]);
    expect(await writeCounts()).toEqual(before);
  });

  it("an archived product is still found — its history stays consultable — with its status", async () => {
    const { product } = await seed();
    await prisma.product.update({ where: { id: product.id }, data: { status: "ARCHIVE" } });
    await loginAsTestUser({ role: "ADMIN" });
    const units = await findTraceUnits(SCANNED);
    expect(units).toHaveLength(1);
    expect(units[0].status).toBe("ARCHIVE");
    expect(inactiveUnitLabel(units[0].status)).toBe("Archivé");
  });

  it("a user scoped to location A sees only location A's stock for the scanned unit", async () => {
    const { product, whA, chA } = await seed();
    const u = await loginAsTestUser({ role: "MANAGER", channels: "none" });
    await grantChannelAccess(u.id, chA.id);
    await grantLocationAccess(u.id, whA.id);
    const viewer = (await getCurrentUser())!;

    const trace = await getUnitTraceability(viewer, { productId: product.id, variationId: null });
    expect(trace?.stock.map((s) => s.warehouseName)).toEqual(["Magasin A"]);
    expect(trace?.stock[0].onHand).toBe(7);
  });
});

describe("Traçabilité access", () => {
  it("is refused to a role without traceability.view", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await expect(requirePermission("traceability.view")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("is refused even to an OWNER when the tenant is Online-only (capability off)", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "OWNER" });
    await expect(requirePermission("traceability.view")).rejects.toBeInstanceOf(RedirectSignal);
  });
});
