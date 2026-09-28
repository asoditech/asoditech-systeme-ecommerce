import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import {
  createSupplierAction,
  updateSupplierAction,
  createReceptionAction,
  updateReceptionDraftAction,
  validateReceptionAction,
  cancelReceptionAction,
  recordSupplierPaymentAction,
  getLatestPurchasePriceAction,
  getUnitPurchaseHistoryAction,
} from "@/actions/purchases";
import { getSupplierBalance, getReceptionRemaining } from "@/lib/receptions";
import { getReceptionDetail, listSuppliers, getSupplierPurchaseHistory } from "@/lib/queries/purchases";
import { variantLabel } from "@/lib/catalog/lookup";
import { resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser, createTestUser, grantLocationAccess } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Suppliers, receptions, supplier payments — Phase E (docs/adr/0040).
 * The reception is a DOCUMENT; the canonical inventory movement is the
 * authority for stock. A payment is a separate financial record.
 */

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

async function seed() {
  const warehouse = await prisma.warehouse.create({ data: { name: "Entrepôt principal", isDefault: true } });
  const product = await prisma.product.create({ data: { name: "Basket", sku: "BASKET-1", price: 300, status: "ACTIF" } });
  const item = await prisma.inventoryItem.create({ data: { warehouseId: warehouse.id, productId: product.id, quantityOnHand: 5 } });
  const supplier = await prisma.supplier.create({ data: { name: "Fournisseur Casa" } });
  return { warehouse, product, item, supplier };
}

const line = (productId: string, quantity: number, unitCost: number) => ({ productId, quantity, unitCost });

async function draft(supplierId: string, warehouseId: string, lines: { productId?: string; variationId?: string; quantity: number; unitCost: number }[]) {
  const r = await createReceptionAction({ supplierId, warehouseId, lines });
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return r.data.id;
}

describe("suppliers", () => {
  it("creates and updates a supplier (audited) and requires suppliers.manage", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(createSupplierAction({ name: "Fournisseur X" })).rejects.toThrow(/non autorisé/i);

    mockCookieStore.clear();
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const r = await createSupplierAction({ name: "Fournisseur X", phone: "0600000000", city: "Casablanca" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = await prisma.supplier.findUniqueOrThrow({ where: { id: r.data.id } });
    expect([s.name, s.phone, s.city]).toEqual(["Fournisseur X", "0600000000", "Casablanca"]);
    expect(await prisma.auditEvent.count({ where: { action: "supplier.created", actorUserId: admin.id } })).toBe(1);

    const u = await updateSupplierAction({ id: s.id, name: "Fournisseur Y", isActive: false });
    expect(u.ok).toBe(true);
    expect((await prisma.supplier.findUniqueOrThrow({ where: { id: s.id } })).isActive).toBe(false);
  });
});

describe("reception → stock (the canonical movement is the authority)", () => {
  it("a DRAFT adds no stock and writes no movement", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, item, supplier } = await seed();
    await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(5);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("validation adds stock ONCE through a RECEPTION movement carrying unit cost, deltas, document link and actor", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, item, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);

    const v = await validateReceptionAction({ id });
    expect(v.ok).toBe(true);

    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(15);
    const [m] = await prisma.inventoryMovement.findMany();
    const rl = await prisma.receptionLine.findFirstOrThrow({ where: { receptionId: id } });
    expect(m).toMatchObject({ type: "RECEPTION", quantity: 10, onHandDelta: 10, onHandAfter: 15, performedById: admin.id, receptionLineId: rl.id });
    expect(Number(m.unitCost)).toBe(80);
    expect(m.warehouseId).toBe(warehouse.id);

    const r = await prisma.reception.findUniqueOrThrow({ where: { id } });
    expect(r.status).toBe("VALIDEE");
    expect(Number(r.totalCost)).toBe(800);
    expect(r.validatedById).toBe(admin.id);
    expect(r.validatedByName).toBe(admin.name);
    expect(r.displayNumber).toBe(1);
  });

  it("validating twice — sequentially or concurrently — never adds stock twice", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, item, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);

    const results = await Promise.all([validateReceptionAction({ id }), validateReceptionAction({ id }), validateReceptionAction({ id })]);
    expect(results.every((r) => r.ok)).toBe(true);
    await validateReceptionAction({ id });

    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(15);
    expect(await prisma.inventoryMovement.count({ where: { type: "RECEPTION" } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: "reception.validated" } })).toBe(1);
  });

  it("receiving into a location that does not track the unit yet creates its InventoryItem", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product, supplier } = await seed();
    const store = await prisma.warehouse.create({ data: { name: "Boutique", type: "MAGASIN" } });
    const id = await draft(supplier.id, store.id, [line(product.id, 4, 50)]);
    await validateReceptionAction({ id });
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { warehouseId: store.id, productId: product.id } });
    expect(item.quantityOnHand).toBe(4);
  });

  it("a variation line is received against the variation's own stock row", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, supplier } = await seed();
    const parent = await prisma.product.create({ data: { name: "Adidas SKOUBA", sku: "SKOUBA", price: 500, status: "ACTIF" } });
    const v = await prisma.productVariation.create({ data: { productId: parent.id, sku: "SKOUBA-B-42", attributes: { Couleur: "Bleu", Taille: "42" } } });
    const id = await draft(supplier.id, warehouse.id, [{ variationId: v.id, quantity: 6, unitCost: 200 }]);
    await validateReceptionAction({ id });
    const item = await prisma.inventoryItem.findFirstOrThrow({ where: { variationId: v.id } });
    expect(item.quantityOnHand).toBe(6);
    expect(item.productId).toBeNull(); // product XOR variation invariant intact

    // The document can identify the exact unit (labelling only — snapshots untouched).
    const detail = await getReceptionDetail(id);
    expect(detail?.lines[0]).toMatchObject({ variationId: v.id, skuSnapshot: "SKOUBA-B-42" });
    // JSONB does not preserve attribute key order — assert the parts, not their order.
    expect(variantLabel(detail?.lines[0].variation?.attributes)?.split(" / ").sort()).toEqual(["42", "Bleu"]);
  });

  it("refuses a variable parent line and an untracked product", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, supplier } = await seed();
    const parent = await prisma.product.create({ data: { name: "Parent", sku: "PAR", price: 1, status: "ACTIF" } });
    await prisma.productVariation.create({ data: { productId: parent.id, sku: "PAR-1", attributes: {} } });
    const untracked = await prisma.product.create({ data: { name: "Service", sku: "SRV", price: 1, status: "ACTIF", trackInventory: false } });

    expect((await createReceptionAction({ supplierId: supplier.id, warehouseId: warehouse.id, lines: [line(parent.id, 1, 1)] })).ok).toBe(false);
    expect((await createReceptionAction({ supplierId: supplier.id, warehouseId: warehouse.id, lines: [line(untracked.id, 1, 1)] })).ok).toBe(false);
  });

  it("a draft can be edited (lines replaced), but not once validated or cancelled", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);

    expect((await updateReceptionDraftAction({ id, supplierId: supplier.id, warehouseId: warehouse.id, lines: [line(product.id, 3, 90)] })).ok).toBe(true);
    expect((await prisma.receptionLine.findMany({ where: { receptionId: id } })).map((l) => l.quantity)).toEqual([3]);

    await validateReceptionAction({ id });
    expect((await updateReceptionDraftAction({ id, supplierId: supplier.id, warehouseId: warehouse.id, lines: [line(product.id, 99, 1)] })).ok).toBe(false);
    expect((await cancelReceptionAction({ id })).ok).toBe(false);
    expect(await prisma.inventoryMovement.count()).toBe(1); // untouched by the rejected edit/cancel
  });

  it("cancelling a draft has no stock effect, and a cancelled reception cannot be validated", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, item, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);
    expect((await cancelReceptionAction({ id })).ok).toBe(true);
    expect((await validateReceptionAction({ id })).ok).toBe(false);
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).quantityOnHand).toBe(5);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("traceability: from the movement you can reach the reception line, reception, supplier, date and cost", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);
    await validateReceptionAction({ id });
    const m = await prisma.inventoryMovement.findFirstOrThrow({
      include: { receptionLine: { include: { reception: { include: { supplier: true } } } } },
    });
    expect(m.receptionLine?.reception.supplier.name).toBe("Fournisseur Casa");
    expect(m.receptionLine?.nameSnapshot).toBe("Basket");
    expect(Number(m.receptionLine?.unitCost)).toBe(80);
  });
});

describe("location access (ADR 0037) still governs where stock lands", () => {
  it("a warehouse user without access to the destination cannot create or validate a reception there", async () => {
    const { warehouse, product, supplier } = await seed();
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 80)]);
    mockCookieStore.clear();

    const w = await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(createReceptionAction({ supplierId: supplier.id, warehouseId: warehouse.id, lines: [line(product.id, 1, 1)] })).rejects.toThrow(/non autorisé/i);
    await expect(validateReceptionAction({ id })).rejects.toThrow(/non autorisé/i);

    await grantLocationAccess(w.id, warehouse.id);
    expect((await validateReceptionAction({ id })).ok).toBe(true);
    expect(admin.id).not.toBe(w.id);
  });
});

describe("supplier payments — a separate financial record", () => {
  it("a payment creates NO stock movement, and the balance is DERIVED (received − paid)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 100, 100)]); // 10 000
    await validateReceptionAction({ id });
    const before = await prisma.inventoryMovement.count();

    const p = await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: id, amount: 6000, method: "VIREMENT" });
    expect(p.ok).toBe(true);

    expect(await prisma.inventoryMovement.count()).toBe(before); // paying never touches stock
    const bal = await getSupplierBalance(supplier.id);
    expect([Number(bal.totalReceived), Number(bal.totalPaid), Number(bal.balance)]).toEqual([10000, 6000, 4000]);
    const rem = await getReceptionRemaining(id);
    expect(Number(rem?.remaining)).toBe(4000);
  });

  it("a draft or cancelled reception owes nothing", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    const c = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    await cancelReceptionAction({ id: c });
    expect(Number((await getSupplierBalance(supplier.id)).balance)).toBe(0);
  });

  it("rejects paying an unvalidated reception, another supplier's reception, and more than the remaining amount", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const other = await prisma.supplier.create({ data: { name: "Autre" } });
    const draftId = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    expect((await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: draftId, amount: 10 })).ok).toBe(false);

    await validateReceptionAction({ id: draftId }); // 1 000
    expect((await recordSupplierPaymentAction({ supplierId: other.id, receptionId: draftId, amount: 10 })).ok).toBe(false);
    expect((await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: draftId, amount: 1000.01 })).ok).toBe(false);
    expect((await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: draftId, amount: 1000 })).ok).toBe(true);
    expect((await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: draftId, amount: 1 })).ok).toBe(false); // fully settled
  });

  it("concurrent payments cannot together exceed a reception's remaining amount (row-locked)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });
    const results = await Promise.all([
      recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: id, amount: 700 }),
      recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: id, amount: 700 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(Number((await getReceptionRemaining(id))?.remaining)).toBe(300);
  });

  it("an on-account payment (no reception) reduces the supplier balance", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    await validateReceptionAction({ id });
    await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 250, method: "ESPECES" });
    expect(Number((await getSupplierBalance(supplier.id)).balance)).toBe(750);
  });

  it("receiving and paying are separate permissions: a WAREHOUSE user can receive but not pay", async () => {
    const { warehouse, product, supplier } = await seed();
    const w = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(w.id, warehouse.id);
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    expect((await validateReceptionAction({ id })).ok).toBe(true);
    await expect(recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: id, amount: 10 })).rejects.toThrow(/non autorisé/i);
  });

  it("the DB rejects a non-positive payment amount", async () => {
    const { supplier } = await seed();
    await expect(prismaBase.supplierPayment.create({ data: { supplierId: supplier.id, amount: 0, tenantId: "default" } })).rejects.toThrow();
  });
});

// docs/adr/0042 — the user enters only an amount; the server allocates it
// across the supplier's oldest outstanding VALIDATED receptions first.
describe("supplier payment auto-allocation (docs/adr/0042)", () => {
  it("one unpaid reception + exact payment fully settles it", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.paymentGroupId).toBeNull(); // a single-reception allocation is never grouped
    expect(r.data.allocations).toEqual([{ receptionId: id, receptionLabel: expect.any(String), amount: "1000" }]);
    expect(r.data.remainingBalance).toBe("0");
    expect(Number((await getReceptionRemaining(id))?.remaining)).toBe(0);
  });

  it("one unpaid reception + partial payment leaves the rest outstanding", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 400 });
    expect(r.ok).toBe(true);
    expect(Number((await getReceptionRemaining(id))?.remaining)).toBe(600);
  });

  it("two unpaid receptions + payment smaller than the first debt only touches the oldest", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000, oldest
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 30, 100)]); // 3 000
    await validateReceptionAction({ id: r2 });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 300 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.allocations).toEqual([{ receptionId: r1, receptionLabel: expect.any(String), amount: "300" }]);
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(700);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(3000);
  });

  it("two unpaid receptions + payment exactly covering the first debt settles it and touches nothing else", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 30, 100)]); // 3 000
    await validateReceptionAction({ id: r2 });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.allocations).toEqual([{ receptionId: r1, receptionLabel: expect.any(String), amount: "1000" }]);
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(0);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(3000);
  });

  it("two unpaid receptions + payment crossing from the first into the second splits it exactly (spec example)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 30, 100)]); // 3 000
    await validateReceptionAction({ id: r2 });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 3500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.paymentGroupId).not.toBeNull(); // split across 2 receptions — grouped for display
    expect(r.data.allocations).toEqual([
      { receptionId: r1, receptionLabel: expect.any(String), amount: "1000" },
      { receptionId: r2, receptionLabel: expect.any(String), amount: "2500" },
    ]);
    expect(r.data.remainingBalance).toBe("500");
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(0);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(500);
    // both rows share the same group id
    const rows = await prisma.supplierPayment.findMany({ where: { supplierId: supplier.id }, orderBy: { amount: "desc" } });
    expect(rows.map((p) => p.paymentGroupId)).toEqual([r.data.paymentGroupId, r.data.paymentGroupId]);
  });

  it("multiple sequential payments always allocate from the real current outstanding state", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 30, 100)]); // 3 000
    await validateReceptionAction({ id: r2 });

    await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 500 });
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(500);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(3000);

    await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 700 });
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(0);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(2800);

    await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 });
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(0);
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(1800);
  });

  it("a draft reception never receives an allocation", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000, validated
    await validateReceptionAction({ id: r1 });
    await draft(supplier.id, warehouse.id, [line(product.id, 50, 100)]); // 5 000, LEFT AS DRAFT

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // only the validated reception appears — the draft is invisible to allocation
    expect(r.data.allocations.map((a) => a.receptionId)).toEqual([r1]);
    expect(r.data.remainingBalance).toBe("0");
  });

  it("a cancelled reception never receives an allocation", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000, validated
    await validateReceptionAction({ id: r1 });
    const cancelled = await draft(supplier.id, warehouse.id, [line(product.id, 50, 100)]); // would be 5 000
    await cancelReceptionAction({ id: cancelled });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.allocations.map((a) => a.receptionId)).toEqual([r1]);
    expect(r.data.remainingBalance).toBe("0");
  });

  it("a fully paid reception is skipped and the next oldest debt is used instead", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000, oldest
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 20, 100)]); // 2 000
    await validateReceptionAction({ id: r2 });
    await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1000 }); // fully settles r1

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // r1 is fully paid — skipped entirely, the payment goes straight to r2
    expect(r.data.allocations).toEqual([{ receptionId: r2, receptionLabel: expect.any(String), amount: "500" }]);
  });

  it("allocates strictly oldest-first regardless of debt size (deterministic ordering)", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    // Created in this order — smallest debt first, biggest debt last.
    const small = await draft(supplier.id, warehouse.id, [line(product.id, 1, 100)]); // 100, oldest
    await validateReceptionAction({ id: small });
    const big = await draft(supplier.id, warehouse.id, [line(product.id, 40, 100)]); // 4 000, newest
    await validateReceptionAction({ id: big });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 150 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The oldest (smallest) debt is fully settled first, then the excess
    // spills into the newest — NOT "biggest debt first" or "newest first".
    expect(r.data.allocations).toEqual([
      { receptionId: small, receptionLabel: expect.any(String), amount: "100" },
      { receptionId: big, receptionLabel: expect.any(String), amount: "50" },
    ]);
  });

  it("tenant isolation: allocation only ever touches the caller's own tenant's receptions", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });

    await prismaBase.tenant.create({ data: { id: "tenant-b-alloc", name: "B", slug: "tenant-b-alloc" } });
    const supB = await prismaBase.supplier.create({ data: { name: "Fournisseur B", tenantId: "tenant-b-alloc" } });
    const whB = await prismaBase.warehouse.create({ data: { name: "WB", isDefault: true, tenantId: "tenant-b-alloc" } });
    const recB = await prismaBase.reception.create({
      data: { supplierId: supB.id, warehouseId: whB.id, tenantId: "tenant-b-alloc", status: "VALIDEE", totalCost: 50 },
    });

    // Cross-tenant supplier id: rejected before any allocation is even planned.
    expect((await recordSupplierPaymentAction({ supplierId: supB.id, amount: 10 })).ok).toBe(false);
    expect(await prismaBase.supplierPayment.count({ where: { receptionId: recB.id } })).toBe(0);
  });

  it("a user without purchases.pay cannot record an auto-allocated payment", async () => {
    const { warehouse, product, supplier } = await seed();
    const w = await loginAsTestUser({ role: "WAREHOUSE" });
    await grantLocationAccess(w.id, warehouse.id);
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]);
    expect((await validateReceptionAction({ id })).ok).toBe(true);
    await expect(recordSupplierPaymentAction({ supplierId: supplier.id, amount: 10 })).rejects.toThrow(/non autorisé/i);
  });

  it("concurrent payments against one reception cannot together exceed it — the second is rejected, not silently underfilled", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });

    const results = await Promise.all([
      recordSupplierPaymentAction({ supplierId: supplier.id, amount: 700 }),
      recordSupplierPaymentAction({ supplierId: supplier.id, amount: 700 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(Number((await getReceptionRemaining(id))?.remaining)).toBe(300);
    expect(await prisma.supplierPayment.aggregate({ where: { supplierId: supplier.id }, _sum: { amount: true } }).then((a) => Number(a._sum.amount))).toBe(700);
  });

  it("overpayment beyond the total outstanding debt is rejected with a clear message, not silently absorbed as credit", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const id = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id });

    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 1500 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/dépasse/i);
    expect(await prisma.supplierPayment.count()).toBe(0); // rejected atomically — nothing partially written
    expect(Number((await getReceptionRemaining(id))?.remaining)).toBe(1000); // untouched
  });

  it("a payment against a supplier with no outstanding debt at all is rejected", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { supplier } = await seed(); // no receptions at all
    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, amount: 100 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/aucune dette/i);
  });

  it("the manual receptionId path still works unchanged alongside auto-allocation", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 10, 100)]); // 1 000
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 20, 100)]); // 2 000
    await validateReceptionAction({ id: r2 });

    // Explicitly targets the NEWER reception, out of allocation order — the
    // manual override still bypasses oldest-first entirely.
    const r = await recordSupplierPaymentAction({ supplierId: supplier.id, receptionId: r2, amount: 500 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.paymentGroupId).toBeNull();
    expect(r.data.allocations).toEqual([{ receptionId: r2, receptionLabel: expect.any(String), amount: "500" }]);
    expect(Number((await getReceptionRemaining(r1))?.remaining)).toBe(1000); // untouched
    expect(Number((await getReceptionRemaining(r2))?.remaining)).toBe(1500);
  });
});

describe("tenant isolation — suppliers & receptions", () => {
  it("a tenant-A user cannot use tenant B's supplier or read its receptions", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product } = await seed();
    await prismaBase.tenant.create({ data: { id: "tenant-b-purch", name: "B", slug: "tenant-b-purch" } });
    const supB = await prismaBase.supplier.create({ data: { name: "Fournisseur B", tenantId: "tenant-b-purch" } });
    const whB = await prismaBase.warehouse.create({ data: { name: "WB", isDefault: true, tenantId: "tenant-b-purch" } });
    const recB = await prismaBase.reception.create({ data: { supplierId: supB.id, warehouseId: whB.id, tenantId: "tenant-b-purch" } });

    const r = await createReceptionAction({ supplierId: supB.id, warehouseId: warehouse.id, lines: [line(product.id, 1, 1)] });
    expect(r.ok).toBe(false);
    expect((await validateReceptionAction({ id: recB.id })).ok).toBe(false);
    expect((await recordSupplierPaymentAction({ supplierId: supB.id, amount: 5 })).ok).toBe(false);
    expect(await prisma.supplier.count()).toBe(1); // only A's own
    expect(await prisma.reception.findUnique({ where: { id: recB.id } })).toBeNull();
    expect(await prisma.supplierPayment.count()).toBe(0);
  });

  it("display numbers are sequential per tenant", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const a = await draft(supplier.id, warehouse.id, [line(product.id, 1, 1)]);
    const b = await draft(supplier.id, warehouse.id, [line(product.id, 1, 1)]);
    const nums = (await prisma.reception.findMany({ where: { id: { in: [a, b] } }, orderBy: { createdAt: "asc" } })).map((r) => r.displayNumber);
    expect(nums).toEqual([1, 2]);
    // sanity: a second tenant would start again at 1 (separate counter column per tenant row)
    const t = await createTestUser({ role: "OWNER" });
    expect(t.tenantId).toBe("default");
  });
});

// Batch 3, Task 3A — "Dernier achat" hint shown when adding a reception line.
describe("getLatestPurchasePriceAction", () => {
  it("returns the price from the most recently VALIDATED reception, not a draft", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();

    const older = await draft(supplier.id, warehouse.id, [line(product.id, 1, 50)]);
    await validateReceptionAction({ id: older });
    const newer = await draft(supplier.id, warehouse.id, [line(product.id, 1, 65)]);
    await validateReceptionAction({ id: newer });
    // A later DRAFT at a different price must never win over the last VALIDATED one.
    await draft(supplier.id, warehouse.id, [line(product.id, 1, 999)]);

    const result = await getLatestPurchasePriceAction({ productId: product.id });
    expect(result?.unitCost).toBe(65);
    expect(result?.supplierName).toBe("Fournisseur Casa");
  });

  it("returns null when there is no validated purchase history for this product", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { product } = await seed();
    expect(await getLatestPurchasePriceAction({ productId: product.id })).toBeNull();
  });

  it("requires purchases.create, same as the reception screen", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const { product } = await seed();
    await expect(getLatestPurchasePriceAction({ productId: product.id })).rejects.toThrow(/non autorisé/i);
  });
});

// Batch 14 — supplier list "number of receptions" / "latest reception date".
describe("listSuppliers — reception activity", () => {
  it("counts non-cancelled receptions and reports the latest reception date, per supplier", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const other = await prisma.supplier.create({ data: { name: "Fournisseur Sans Activité" } });

    const a = await draft(supplier.id, warehouse.id, [line(product.id, 1, 10)]);
    await validateReceptionAction({ id: a });
    await draft(supplier.id, warehouse.id, [line(product.id, 1, 10)]); // a second, still-draft reception
    const cancelled = await draft(supplier.id, warehouse.id, [line(product.id, 1, 10)]);
    await cancelReceptionAction({ id: cancelled });

    const { suppliers } = await listSuppliers();
    const row = suppliers.find((s) => s.id === supplier.id)!;
    expect(row.receptionCount).toBe(2); // validated + draft, NOT the cancelled one
    expect(row.lastReceptionDate).not.toBeNull();

    const otherRow = suppliers.find((s) => s.id === other.id)!;
    expect(otherRow.receptionCount).toBe(0);
    expect(otherRow.lastReceptionDate).toBeNull();
  });
});

// Batch 14 — line-level "which products did we buy from this supplier".
describe("getSupplierPurchaseHistory", () => {
  it("returns validated purchase LINES for one supplier, newest first, excluding drafts and other suppliers", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const otherSupplier = await prisma.supplier.create({ data: { name: "Autre Fournisseur" } });

    const r1 = await draft(supplier.id, warehouse.id, [line(product.id, 2, 40)]);
    await validateReceptionAction({ id: r1 });
    const r2 = await draft(supplier.id, warehouse.id, [line(product.id, 3, 45)]);
    await validateReceptionAction({ id: r2 });
    await draft(supplier.id, warehouse.id, [line(product.id, 9, 999)]); // draft — must not appear
    await draft(otherSupplier.id, warehouse.id, [line(product.id, 1, 1)]).then((id) => validateReceptionAction({ id })); // other supplier — must not appear

    const history = await getSupplierPurchaseHistory(supplier.id);
    expect(history).toHaveLength(2);
    expect(history[0].unitCost).toBe(45); // newest first
    expect(history[1].unitCost).toBe(40);
    expect(history.every((h) => h.productName === "Basket")).toBe(true);
  });

  it("resolves a variation line to its own attributes, distinct from the parent product", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: "BASKET-1-42", attributes: { Pointure: "42" } },
    });
    const r = await createReceptionAction({ supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ variationId: variation.id, quantity: 1, unitCost: 55 }] });
    if (!r.ok) throw new Error(r.error);
    await validateReceptionAction({ id: r.data.id });

    const history = await getSupplierPurchaseHistory(supplier.id);
    expect(history[0].variantLabel).toBe("42");
    expect(history[0].sku).toBe("BASKET-1-42");
  });

  it("tenant isolation: a supplier id from another tenant returns no history", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await prismaBase.tenant.create({ data: { id: "tenant-b-purchhist", name: "B", slug: "tenant-b-purchhist" } });
    const supB = await prismaBase.supplier.create({ data: { name: "Fournisseur B", tenantId: "tenant-b-purchhist" } });
    expect(await getSupplierPurchaseHistory(supB.id)).toEqual([]);
  });
});

// Batch 14 — variation-level full purchase history dialog (product page).
describe("getUnitPurchaseHistoryAction", () => {
  it("returns the full history for a variation, newest first", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const { warehouse, product, supplier } = await seed();
    const variation = await prisma.productVariation.create({
      data: { productId: product.id, sku: "BASKET-1-43", attributes: { Pointure: "43" } },
    });
    for (const cost of [30, 35, 40]) {
      const r = await createReceptionAction({ supplierId: supplier.id, warehouseId: warehouse.id, lines: [{ variationId: variation.id, quantity: 1, unitCost: cost }] });
      if (!r.ok) throw new Error(r.error);
      await validateReceptionAction({ id: r.data.id });
    }
    const history = await getUnitPurchaseHistoryAction({ variationId: variation.id });
    expect(history.map((h) => h.unitCost)).toEqual([40, 35, 30]);
  });

  it("requires purchases.view — readable by a role without purchases.create", async () => {
    await loginAsTestUser({ role: "ACCOUNTANT" }); // purchases.view yes, purchases.create no
    const { product } = await seed();
    expect(await getUnitPurchaseHistoryAction({ productId: product.id })).toEqual([]);
  });

  it("rejects a caller without purchases.view", async () => {
    await loginAsTestUser({ role: "SUPPORT" });
    const { product } = await seed();
    await expect(getUnitPurchaseHistoryAction({ productId: product.id })).rejects.toThrow(/non autorisé/i);
  });
});
