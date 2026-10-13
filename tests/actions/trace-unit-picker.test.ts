import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { lookupTraceUnitsAction } from "@/actions/traceability";
import { findTraceUnits } from "@/lib/queries/traceability";
import { traceabilitySearchHref, traceabilityUnitHref, traceUnitKey } from "@/lib/traceability-scan";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }),
}));
const { TraceUnitPicker } = await import("@/components/traceability/trace-unit-picker");

/**
 * « Traçabilité » product picker: its lookup action (same search as the page,
 * traceability.view, tenant-scoped, read-only, no price/cost), the URLs it
 * navigates to (the page's existing ?q= / ?q=&unit=), and its field markup.
 * Opening/typing/keyboard interaction is checked in the browser — the test
 * harness has no DOM (vitest `environment: "node"`).
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

async function seed() {
  const polo = await prisma.product.create({ data: { name: "Polo Classic", sku: "POLO-1", price: 150, cost: 60, status: "ACTIF" } });
  await prisma.barcode.create({ data: { code: "6111000000017", productId: polo.id, isPrimary: true } });
  const tee = await prisma.product.create({ data: { name: "T-shirt Basique", sku: "TEE-1", price: 90, status: "ACTIF" } });
  const teeM = await prisma.productVariation.create({ data: { productId: tee.id, sku: "TEE-1-M", attributes: { Taille: "M" }, isActive: true } });
  const archived = await prisma.product.create({ data: { name: "Polo Ancien", sku: "POLO-OLD", price: 120, status: "ARCHIVE" } });
  return { polo, tee, teeM, archived };
}

const writes = async () =>
  Promise.all([prismaBase.inventoryMovement.count(), prismaBase.auditEvent.count(), prismaBase.productPublication.count(), prismaBase.inventoryItem.count()]);

describe("lookupTraceUnitsAction", () => {
  it("empty query (field opened): the first active articles, archived ones left out", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const { polo, archived } = await seed();
    const units = await lookupTraceUnitsAction({ query: "" });
    expect(units.length).toBeGreaterThan(0);
    expect(units.length).toBeLessThanOrEqual(15);
    expect(units.map((u) => u.productId)).toContain(polo.id);
    expect(units.map((u) => u.productId)).not.toContain(archived.id);
  });

  it("searches by name, SKU, barcode and variation SKU — archived articles stay findable by typing", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const { polo, teeM, archived } = await seed();
    expect((await lookupTraceUnitsAction({ query: "polo cla" })).map((u) => u.productId)).toContain(polo.id);
    expect((await lookupTraceUnitsAction({ query: "POLO-1" }))[0]).toMatchObject({ productId: polo.id, variationId: null, sku: "POLO-1" });
    expect((await lookupTraceUnitsAction({ query: "6111000000017" }))[0]).toMatchObject({ productId: polo.id, primaryBarcode: "6111000000017" });
    const variation = (await lookupTraceUnitsAction({ query: "TEE-1-M" })).find((u) => u.variationId === teeM.id);
    expect(variation).toMatchObject({ name: "T-shirt Basique", variantLabel: "M", sku: "TEE-1-M" });
    expect((await lookupTraceUnitsAction({ query: "POLO-OLD" }))[0]).toMatchObject({ productId: archived.id, status: "ARCHIVE" });
    expect(await lookupTraceUnitsAction({ query: "introuvable-xyz" })).toEqual([]);
  });

  it("returns exactly what the page's own lookup returns, with no price or cost", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seed();
    const units = await lookupTraceUnitsAction({ query: "polo" });
    const page = await findTraceUnits("polo");
    expect(units.map(traceUnitKey)).toEqual(page.map(traceUnitKey));
    for (const u of units) {
      expect(u).not.toHaveProperty("cost");
      expect(u).not.toHaveProperty("price");
    }
  });

  it("is read-only: searching writes nothing (no movement, stock row, publication or audit)", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seed();
    const before = await writes();
    await lookupTraceUnitsAction({ query: "" });
    await lookupTraceUnitsAction({ query: "polo" });
    expect(await writes()).toEqual(before);
  });

  it("requires traceability.view", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    await seed();
    await expect(lookupTraceUnitsAction({ query: "polo" })).rejects.toThrow(/non autorisé/i);
    mockCookieStore.clear();
    await expect(lookupTraceUnitsAction({ query: "polo" })).rejects.toThrow();
  });

  it("is unavailable when the tenant's business mode has no traceability (ONLINE_ONLY)", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "MANAGER" });
    await expect(lookupTraceUnitsAction({ query: "" })).rejects.toThrow(/non autorisé/i);
  });

  it("never returns another tenant's articles", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seed();
    const TENANT_B = "tenant-b-trace-picker";
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    const foreign = await prismaBase.product.create({ data: { tenantId: TENANT_B, name: "Polo Tenant B", sku: "POLO-B", price: 100, status: "ACTIF" } });
    const ids = [...(await lookupTraceUnitsAction({ query: "" })), ...(await lookupTraceUnitsAction({ query: "polo" })), ...(await lookupTraceUnitsAction({ query: "POLO-B" }))].map((u) => u.productId);
    expect(ids).not.toContain(foreign.id);
    await prismaBase.product.delete({ where: { id: foreign.id } }).catch(() => {});
    await prismaBase.tenant.delete({ where: { id: TENANT_B } }).catch(() => {});
  });
});

describe("picker URLs = the page's existing ?q= / ?q=&unit= mechanism", () => {
  it("free text keeps the old search URL (multi-match list, scanners' Enter)", () => {
    expect(traceabilitySearchHref("polo")).toBe("/tracabilite?q=polo");
    expect(traceabilitySearchHref("   ")).toBeNull();
  });

  it("a picked article/variation opens through ?q=<search>&unit=<key>, or its SKU when nothing was typed", () => {
    const simple = { productId: "p1", variationId: null, sku: "POLO-1" };
    const variation = { productId: "p2", variationId: "v9", sku: "TEE-1-M" };
    expect(traceabilityUnitHref("polo", simple)).toBe("/tracabilite?q=polo&unit=p%3Ap1");
    expect(traceabilityUnitHref("", variation)).toBe("/tracabilite?q=TEE-1-M&unit=v%3Av9");
    expect(traceUnitKey(variation)).toBe("v:v9");
  });

  it("the page's own lookup resolves every URL the picker can build to the picked article", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seed();
    for (const query of ["", "polo", "TEE"]) {
      for (const unit of await lookupTraceUnitsAction({ query })) {
        const params = new URL(traceabilityUnitHref(query, unit), "http://x").searchParams;
        const candidates = await findTraceUnits(params.get("q")!);
        expect(candidates.map(traceUnitKey), `${query} → ${unit.sku}`).toContain(params.get("unit"));
      }
    }
  });

  it("an article still listed from the previous search (new one pending) opens with THAT search, not the new text", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    await seed();
    // Building the URL from the newer text would send a `unit` the page's lookup does not return.
    const [stale] = await lookupTraceUnitsAction({ query: "TEE" });
    expect((await findTraceUnits("polo")).map(traceUnitKey)).not.toContain(traceUnitKey(stale));
    const picker = readFileSync(join(process.cwd(), "src/components/traceability/trace-unit-picker.tsx"), "utf8");
    expect(picker).toContain("traceabilityUnitHref(result?.query ?? term, unit)");
  });
});

describe("Traçabilité page wiring", () => {
  it("renders an accessible combobox field prefilled with the current search", () => {
    const html = renderToStaticMarkup(createElement(TraceUnitPicker, { defaultValue: "POLO-1" }));
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Rechercher un article à tracer"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('value="POLO-1"');
    expect(html).toContain('aria-controls="trace-unit-picker-list"');
  });

  it("the page uses the picker, keeps the camera scan button and the multi-match list", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(protected)/tracabilite/page.tsx"), "utf8");
    expect(page).toContain("<TraceUnitPicker key={q} defaultValue={q}");
    expect(page).toContain("<TraceScanButton />");
    expect(page).toContain("articles correspondent");
    expect(page).not.toContain("FilterSearchInput");
    expect(page).toContain('requirePermission("traceability.view")');
  });
});
