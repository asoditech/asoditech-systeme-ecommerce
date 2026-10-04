import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import Link from "next/link";
import { quickSearchAction } from "@/actions/search";
import ProduitDetailPage from "@/app/(protected)/produits/[id]/page";
import NouvelleReceptionPage from "@/app/(protected)/receptions/nouveau/page";
import { unitImageUrl } from "@/lib/catalog/unit-image";
import {
  CODE128_QUIET_ZONE_MODULES,
  LABEL_BARCODE_WIDTH_MM,
  LABEL_INNER_MM,
  LABEL_MM,
  LABEL_PRINT_CSS,
  LABEL_TEXT_WIDTH_MM,
  MIN_MODULE_MM,
  MIN_QR_MODULE_MM,
  QR_QUIET_ZONE_MODULES,
  code128ModuleCount,
  labelBarcodeFit,
  labelHeightBudget,
  labelQrFit,
} from "@/lib/catalog/label-layout";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * Phase 1 — variant images, the 50×30 mm label, the plain « Recevoir du
 * stock » link (product page → ordinary new-reception page, nothing
 * pre-selected or written) and the command-palette product actions.
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

/** Every record a reception or a stock change would create or touch. */
const stockState = async () =>
  Promise.all([
    prismaBase.reception.count(),
    prismaBase.receptionLine.count(),
    prismaBase.inventoryItem.count(),
    prismaBase.inventoryMovement.count(),
    prismaBase.inventoryItem
      .aggregate({ _sum: { quantityOnHand: true, quantityReserved: true } })
      .then((x) => [x._sum.quantityOnHand ?? 0, x._sum.quantityReserved ?? 0]),
  ]);

async function variableProduct() {
  const product = await prisma.product.create({ data: { name: "Chemise Lin", sku: "CHL", price: 199, cost: 80, status: "ACTIF" } });
  const noir = await prisma.productVariation.create({
    data: { productId: product.id, sku: "CHL-NOIR", attributes: { Couleur: "Noir" }, cost: 75 },
  });
  const blanc = await prisma.productVariation.create({
    data: { productId: product.id, sku: "CHL-BLANC", attributes: { Couleur: "Blanc" } },
  });
  const archived = await prisma.productVariation.create({
    data: { productId: product.id, sku: "CHL-ROUGE", attributes: { Couleur: "Rouge" }, isActive: false },
  });
  return { product, noir, blanc, archived };
}

/** Every element of `type` in a rendered server-component tree, looking through ALL props (e.g. `render={<Link />}`). */
function findAll(node: unknown, type: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, type, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (!el.props) return out;
  if (el.type === type) out.push(el.props);
  for (const value of Object.values(el.props)) findAll(value, type, out);
  return out;
}

describe("unitImageUrl — variant image first, product gallery fallback", () => {
  it("prefers the variation's own image", () => {
    expect(unitImageUrl({ imageUrl: "https://cdn/v.jpg" }, "https://cdn/p.jpg")).toBe("https://cdn/v.jpg");
  });
  it("falls back to the first available product image when the variation has none", () => {
    expect(unitImageUrl({ imageUrl: null }, "https://cdn/p.jpg")).toBe("https://cdn/p.jpg");
    expect(unitImageUrl({ imageUrl: "   " }, undefined, "https://cdn/parent.jpg")).toBe("https://cdn/parent.jpg");
  });
  it("simple product (no variation) uses the gallery; nothing at all → null", () => {
    expect(unitImageUrl(null, "https://cdn/p.jpg")).toBe("https://cdn/p.jpg");
    expect(unitImageUrl(undefined)).toBeNull();
    expect(unitImageUrl({ imageUrl: null }, null, "")).toBeNull();
  });
});

describe("50 × 30 mm label", () => {
  it("is laid out on a 50 × 30 mm sheet; the barcode spans the full inner width", () => {
    expect(LABEL_MM.width).toBe(50);
    expect(LABEL_MM.height).toBe(30);
    expect(LABEL_INNER_MM).toEqual({ width: 50 - 2 * LABEL_MM.padding, height: 30 - 2 * LABEL_MM.padding });
    expect(LABEL_BARCODE_WIDTH_MM).toBe(LABEL_INNER_MM.width);
    // QR + gap + a text column wide enough for a short product name.
    expect(LABEL_MM.qr + LABEL_MM.qrTextGap + LABEL_TEXT_WIDTH_MM).toBeCloseTo(LABEL_INNER_MM.width, 6);
    expect(LABEL_TEXT_WIDTH_MM).toBeGreaterThanOrEqual(30);
  });

  it("the worst case (2-line name, variant, SKU, barcode, value, internal caption) fits the inner height", () => {
    const b = labelHeightBudget();
    expect(b.available).toBeCloseTo(30 - 2 * LABEL_MM.padding, 6);
    expect(b.text).toBeLessThanOrEqual(LABEL_MM.qr); // the text column never outgrows the QR row
    expect(b.total).toBeLessThanOrEqual(b.available);
    expect(b.total).toBeGreaterThan(b.available - 3); // compact: no large unused band
  });

  it("barcode module width matches the rendered viewBox (modules + both quiet zones stretched to the inner width)", () => {
    const short = labelBarcodeFit("TSB-NOIR-S")!;
    expect(short.modules).toBe(code128ModuleCount("TSB-NOIR-S"));
    expect(short.moduleMm).toBeCloseTo(LABEL_BARCODE_WIDTH_MM / (short.modules + 2 * CODE128_QUIET_ZONE_MODULES), 9);
    expect(short.moduleMm).toBeGreaterThanOrEqual(MIN_MODULE_MM);
    expect(short.legible).toBe(true);
    // Quiet zone actually printed on each side = 10 modules.
    expect(CODE128_QUIET_ZONE_MODULES * short.moduleMm).toBeGreaterThanOrEqual(10 * MIN_MODULE_MM);

    // A 13-digit EAN (Code 128 set C) fits comfortably.
    expect(labelBarcodeFit("6111234567890")!.legible).toBe(true);

    // A long SKU is flagged — never presented as reliable.
    const long = labelBarcodeFit("CHEMISE-LIN-PREMIUM-ETE-26")!;
    expect(long.moduleMm).toBeLessThan(MIN_MODULE_MM);
    expect(long.legible).toBe(false);
  });

  it("QR module size and quiet zone for a real-length scan URL (43-char token)", () => {
    const fit = labelQrFit(`https://www.asoditech.com/scan/${"A".repeat(43)}`)!;
    expect(fit.moduleMm).toBeCloseTo(LABEL_MM.qr / fit.modules, 9);
    expect(fit.moduleMm).toBeGreaterThanOrEqual(MIN_QR_MODULE_MM);
    expect(Math.min(LABEL_MM.padding, LABEL_MM.qrTextGap, LABEL_MM.rowGap)).toBeGreaterThanOrEqual(QR_QUIET_ZONE_MODULES * fit.moduleMm);
    expect(fit.legible).toBe(true);
    // A much longer URL gets denser modules and is flagged.
    expect(labelQrFit(`https://${"x".repeat(150)}.example.com/scan/${"A".repeat(43)}`)!.legible).toBe(false);
  });

  it("print CSS sets the 50 × 30 mm page, zero margin, scoped to print media", () => {
    expect(LABEL_PRINT_CSS.startsWith("@media print")).toBe(true);
    expect(LABEL_PRINT_CSS).toContain("@page { size: 50mm 30mm; margin: 0; }");
    expect(LABEL_PRINT_CSS).toContain("width: 50mm !important;");
    expect(LABEL_PRINT_CSS).toContain("height: 30mm !important;");
    expect(LABEL_PRINT_CSS).toContain("[data-label-sheet]");
  });

  it("does not touch A4 printing: globals.css keeps its own @page rule and only the label page sets a page size", () => {
    const root = path.join(__dirname, "..", "..");
    const globals = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
    expect(globals).toMatch(/@page\s*{\s*margin:\s*14mm;\s*}/);
    expect(globals).not.toMatch(/50mm|30mm|80mm/);

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(css|tsx?)$/.test(entry.name) && /@page\s*{\s*size/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    walk(path.join(root, "src"));
    expect(offenders.map((f) => path.relative(root, f))).toEqual(["src/lib/catalog/label-layout.ts"]);

    const labelPage = fs.readFileSync(path.join(root, "src/app/(protected)/produits/[id]/etiquette/page.tsx"), "utf8");
    expect(labelPage).toContain("<style>{LABEL_PRINT_CSS}</style>");
  });
});

describe("« Recevoir du stock » — plain link to the ordinary reception page", () => {
  const receptionLinks = (tree: unknown) =>
    findAll(tree, Link)
      .map((p) => String(p.href))
      .filter((href) => href.startsWith("/receptions"));

  it("the product page links to /receptions/nouveau with NO product/variation pre-selection, and rendering it writes nothing", async () => {
    const { product } = await variableProduct();
    await loginAsTestUser({ role: "ADMIN" });
    const before = await stockState();
    const tree = await ProduitDetailPage({ params: Promise.resolve({ id: product.id }), searchParams: Promise.resolve({}) });
    expect(receptionLinks(tree)).toEqual(["/receptions/nouveau"]); // one header link, none per variation
    expect(await stockState()).toEqual(before);
  });

  it("is hidden without purchases.create (the reception page enforces it anyway)", async () => {
    const product = await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50 } });
    await loginAsTestUser({ role: "CONFIRMATION" }); // products.view, no purchases.create
    const tree = await ProduitDetailPage({ params: Promise.resolve({ id: product.id }), searchParams: Promise.resolve({}) });
    expect(receptionLinks(tree)).toEqual([]);
  });

  it("the reception page opens EMPTY (no lines pre-selected) and opening it creates no reception, line, inventory item, reservation or movement", async () => {
    await prisma.product.create({ data: { name: "Casquette", sku: "CAP-1", price: 50 } });
    await loginAsTestUser({ role: "WAREHOUSE" });
    const before = await stockState();
    const tree = await NouvelleReceptionPage();
    const { ReceptionForm } = await import("@/components/purchases/reception-form");
    const [props] = findAll(tree, ReceptionForm);
    expect(props).toBeDefined();
    expect(props.reception).toBeUndefined();
    expect("initialLines" in props).toBe(false);
    expect(await stockState()).toEqual(before);
  });

  it("the reception page still enforces purchases.create on the server", async () => {
    for (const role of ["CONFIRMATION", "ACCOUNTANT", "STORE_SELLER"] as const) {
      mockCookieStore.clear();
      await loginAsTestUser({ role });
      await expect(NouvelleReceptionPage()).rejects.toBeInstanceOf(RedirectSignal);
    }
  });
});

describe("command palette — product actions", () => {
  const kinds = async (q: string) => {
    const results = await quickSearchAction(q);
    const product = results.find((r) => r.type === "product");
    return product?.actions?.map((a) => a.kind) ?? null;
  };

  it("ADMIN on a simple product: fiche, traçabilité, étiquette, recevoir — with server-built links", async () => {
    const product = await prisma.product.create({ data: { name: "Casquette Sport", sku: "CAP-SPORT", price: 50 } });
    await loginAsTestUser({ role: "ADMIN" });
    const [r] = (await quickSearchAction("CAP-SPORT")).filter((x) => x.type === "product");
    expect(r.actions).toEqual([
      { kind: "open", label: "Ouvrir la fiche", href: `/produits/${product.id}` },
      { kind: "trace", label: "Voir la traçabilité", href: "/tracabilite?q=CAP-SPORT" },
      { kind: "label", label: "Imprimer l'étiquette", href: `/produits/${product.id}/etiquette` },
      { kind: "receive", label: "Recevoir du stock", href: "/receptions/nouveau" },
    ]);
    expect(r.actions!.some((a) => /transf/i.test(a.label))).toBe(false); // no transfer pre-selection workflow exists
  });

  it("variable product: no parent label (labels are printed per variation)", async () => {
    await variableProduct();
    await loginAsTestUser({ role: "ADMIN" });
    expect(await kinds("Chemise Lin")).toEqual(["open", "trace", "receive"]);
  });

  it("is filtered by the caller's permissions", async () => {
    await prisma.product.create({ data: { name: "Casquette Sport", sku: "CAP-SPORT", price: 50 } });
    await loginAsTestUser({ role: "WAREHOUSE" }); // products.view, traceability.view, purchases.create — no products.edit
    expect(await kinds("CAP-SPORT")).toEqual(["open", "trace", "receive"]);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "CONFIRMATION" }); // products.view only
    expect(await kinds("CAP-SPORT")).toEqual(["open"]);

    mockCookieStore.clear();
    await loginAsTestUser({ role: "STORE_SELLER" }); // no products.view → no product results at all
    expect(await kinds("CAP-SPORT")).toBeNull();
  });

  it("ONLINE_ONLY tenant: no label, traceability or reception actions (capabilities off)", async () => {
    await setTestBusinessMode("ONLINE_ONLY");
    await prisma.product.create({ data: { name: "Casquette Sport", sku: "CAP-SPORT", price: 50 } });
    await loginAsTestUser({ role: "ADMIN" });
    expect(await kinds("CAP-SPORT")).toEqual(["open"]);
  });
});
