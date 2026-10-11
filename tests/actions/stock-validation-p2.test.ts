import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { env } from "@/lib/env";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { createOrderAction, getOrderLinesStockAction, searchProductsForOrderAction, updateOrderStatusAction } from "@/actions/orders";
import { setUserPermissionOverridesAction } from "@/actions/users";
import { signStockOverrideToken } from "@/lib/stock-override-token";
import { lineTrackInventory, reserveForConfirmation } from "@/lib/stock-validation";
import { listOrdersAwaitingConfirmation, stockFlagsForOrders } from "@/lib/queries/order-confirmation";
import { confirmationStockNotice } from "@/lib/stock-shortage";
import { InsufficientStockError, stockRowKey } from "@/lib/inventory";
import type { ActionResult } from "@/actions/types";
import type { CreateOrderInput } from "@/lib/validation/order";
import type { UserRole } from "@prisma/client";
import { resetDb } from "../helpers/db";
import { createTestUser, grantLocationAccess, loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * P2 — stock validation at confirmation, through the three real confirmation
 * paths (queue, status change, « Client déjà confirmé »), real roles, real
 * test database. The override is per row, bound to a signed token, role- and
 * permission-gated server-side, reason-required and audited in the same
 * transaction.
 */

// Failure injection AFTER the override audit is written (reserveForConfirmation
// writes the audit, then reserves) — same pattern as phase6c test 17.
const failure = vi.hoisted(() => ({ reserve: false }));
vi.mock("@/lib/inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory")>();
  return {
    ...actual,
    reserveStockForOrder: async (...args: Parameters<typeof actual.reserveStockForOrder>) => {
      if (failure.reserve) throw new actual.InsufficientStockError("Stock insuffisant (test).");
      return actual.reserveStockForOrder(...args);
    },
  };
});

const fd = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

let warehouseId: string;
let customerId: string;

async function product(sku: string, opts: { onHand?: number; reserved?: number; row?: boolean; tracked?: boolean; warehouse?: string } = {}) {
  const p = await prisma.product.create({ data: { name: `Produit ${sku}`, sku, price: 100, status: "ACTIF", trackInventory: opts.tracked ?? true } });
  const item =
    opts.row === false
      ? null
      : await prisma.inventoryItem.create({
          data: { warehouseId: opts.warehouse ?? warehouseId, productId: p.id, quantityOnHand: opts.onHand ?? 0, quantityReserved: opts.reserved ?? 0 },
        });
  return { id: p.id, itemId: item?.id ?? null };
}

/** A NOUVELLE order fulfilled from `warehouse` (default: the seeded one). */
async function nouvelle(lines: { productId: string; variationId?: string; quantity: number }[], warehouse = warehouseId) {
  const o = await prisma.order.create({
    data: {
      customerId,
      subtotal: 100,
      total: 100,
      fulfillmentWarehouseId: warehouse,
      items: {
        create: lines.map((l) => ({
          productId: l.productId,
          variationId: l.variationId ?? null,
          nameSnapshot: "x",
          skuSnapshot: "x",
          unitPrice: 100,
          quantity: l.quantity,
          total: 100 * l.quantity,
        })),
      },
    },
  });
  return o.id;
}

async function loginAs(role: UserRole) {
  mockCookieStore.clear();
  const user = await loginAsTestUser({ role });
  await grantLocationAccess(user.id, warehouseId);
  return user;
}

const queue = (id: string, extra: Record<string, string> = {}) => recordConfirmationAttemptAction(fd({ id, outcome: "CONFIRME", ...extra }));
const status = (id: string, extra: Record<string, string> = {}) => updateOrderStatusAction(fd({ id, status: "CONFIRMEE", ...extra }));
const tokenOf = (r: ActionResult<unknown>) => (!r.ok ? (r.fieldErrors?.stockOverrideToken?.[0] ?? null) : null);
const reserved = async (itemId: string | null) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: itemId! } })).quantityReserved;
const overrideAudits = () => prisma.auditEvent.findMany({ where: { action: "order.stock_override" } });

/** Everything a confirmation can touch, for one order. */
async function footprint(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  return {
    status: order?.status ?? null,
    confirmedAt: order?.confirmedAt ?? null,
    attemptCount: order?.confirmationAttemptCount ?? null,
    agent: order?.confirmationAgentId ?? null,
    attempts: await prisma.orderConfirmationAttempt.count({ where: { orderId } }),
    reservations: await prisma.inventoryMovement.count({ where: { orderId, type: "RESERVATION" } }),
    commissions: await prisma.commissionEntry.count({ where: { orderId } }),
    audits: await prisma.auditEvent.count({ where: { entityId: orderId } }),
    notifications: await prisma.notification.count(),
  };
}

beforeEach(async () => {
  failure.reserve = false;
  await resetDb();
  mockCookieStore.clear();
  warehouseId = (await prisma.warehouse.create({ data: { name: "Entrepôt Casa", isDefault: true } })).id;
  customerId = (await prisma.customer.create({ data: { fullName: "Salma Idrissi", phone: "0611223344" } })).id;
});
afterEach(async () => {
  failure.reserve = false;
  vi.restoreAllMocks();
  await resetDb();
  mockCookieStore.clear();
});

// ---------------------------------------------------------------------------

describe("insufficient stock is refused atomically, in every confirmation path", () => {
  it("queue and status change: refused, shortage listed, NOTHING changed", async () => {
    const a = await product("P2-A", { onHand: 1 });
    for (const path of [queue, status]) {
      const user = await loginAs("MANAGER");
      await prisma.commissionAgent.create({ data: { userId: user.id, ratePerOrder: 10, isActive: true } });
      const id = await nouvelle([{ productId: a.id, quantity: 3 }]);
      const before = await footprint(id);
      const r = await path(id);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe("Stock insuffisant pour confirmer cette commande.");
        expect(r.fieldErrors?.stockShortage).toHaveLength(1);
        expect(r.fieldErrors?.stockShortage?.[0]).toMatch(/Produit P2-A \(P2-A\) — Entrepôt Casa : demandé 3, disponible 1 \(en stock 1, réservé 0\)/);
        expect(r.fieldErrors?.canOverride).toEqual(["true"]);
      }
      expect(await footprint(id)).toEqual(before);
      expect(await reserved(a.itemId)).toBe(0);
    }
  });

  it("« Client déjà confirmé »: the whole creation is rolled back — no order, no reservation", async () => {
    const a = await product("P2-C", { onHand: 1 });
    await loginAs("CONFIRMATION");
    const orders = await prisma.order.count();
    const r = await createOrderAction(createInput(a.id, 3, true));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors?.stockShortage).toHaveLength(1);
      expect(r.fieldErrors?.canOverride).toEqual(["false"]);
      expect(r.fieldErrors?.stockOverrideToken).toBeUndefined(); // never issued to a role that cannot use it
    }
    expect(await prisma.order.count()).toBe(orders);
    expect(await reserved(a.itemId)).toBe(0);
    expect(await prisma.inventoryMovement.count()).toBe(0);
  });

  it("enough stock: confirms exactly as before, strictly within available stock", async () => {
    const a = await product("P2-OK", { onHand: 5, reserved: 2 });
    await loginAs("CONFIRMATION");
    const id = await nouvelle([{ productId: a.id, quantity: 3 }]);
    expect((await queue(id)).ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(5);
    expect((await overrideAudits()).length).toBe(0);
  });
});

describe("authorised per-row override", () => {
  it("only the shown short row is overridden; a sufficient row stays enforced; audit has exactly that row", async () => {
    const a = await product("P2-SHORT", { onHand: 1 });
    const b = await product("P2-FINE", { onHand: 10 });
    const manager = await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 2 }]);

    const refused = await queue(id);
    const token = tokenOf(refused);
    expect(token).toBeTruthy();
    expect(!refused.ok && refused.fieldErrors?.stockShortage).toHaveLength(1);

    const r = await queue(id, { stockOverrideToken: token!, stockOverrideReason: "  Réassort demain  " });
    expect(r.ok).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("CONFIRMEE");
    expect(await reserved(a.itemId)).toBe(3); // beyond the 1 on hand — accepted
    expect(await reserved(b.itemId)).toBe(2); // within stock

    const [audit] = await overrideAudits();
    expect(audit).toMatchObject({ actorUserId: manager.id, entityType: "Order", entityId: id });
    const meta = audit!.metadata as { reason: string; via: string; rows: { inventoryItemId: string; requested: number; onHand: number; reserved: number; available: number; acceptedOvercommit: number }[] };
    expect(meta.reason).toBe("Réassort demain");
    expect(meta.via).toBe("queue");
    expect(meta.rows).toEqual([
      expect.objectContaining({ inventoryItemId: a.itemId, warehouseId, requested: 3, onHand: 1, reserved: 0, available: 1, acceptedOvercommit: 2 }),
    ]);
  });

  it("status change override is audited with via: status_change", async () => {
    const a = await product("P2-ST", { onHand: 0 });
    await loginAs("ADMIN");
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const token = tokenOf(await status(id));
    expect((await status(id, { stockOverrideToken: token!, stockOverrideReason: "Client VIP" })).ok).toBe(true);
    expect(((await overrideAudits())[0]!.metadata as { via: string }).via).toBe("status_change");
  });

  it("creation override is bound to the exact draft (customer, warehouse, lines)", async () => {
    const a = await product("P2-DRAFT", { onHand: 1 });
    await loginAs("MANAGER");
    const refused = await createOrderAction(createInput(a.id, 2, true));
    const token = tokenOf(refused)!;
    expect(token).toBeTruthy();
    // a different cart cannot reuse it
    const other = await createOrderAction({ ...createInput(a.id, 5, true), stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toMatch(/n'est plus valable/);
    // the same cart can
    const ok = await createOrderAction({ ...createInput(a.id, 2, true), stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(ok.ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(2);
    expect(((await overrideAudits())[0]!.metadata as { via: string }).via).toBe("order_creation");
  });

  it("a NEW shortage on a previously sufficient row is refused — the token does not cover it", async () => {
    const a = await product("P2-N-A", { onHand: 1 });
    const b = await product("P2-N-B", { onHand: 5 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 3 }, { productId: b.id, quantity: 2 }]);
    const token = tokenOf(await queue(id))!;
    await prisma.inventoryItem.update({ where: { id: b.itemId! }, data: { quantityOnHand: 1 } }); // B becomes short
    const before = await footprint(id);
    const r = await queue(id, { stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.fieldErrors?.stockShortage).toHaveLength(2);
      expect(tokenOf(r)).not.toBe(token); // a fresh token for the new situation
    }
    expect(await footprint(id)).toEqual(before);
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("a shortage that disappears before the override: confirmed normally, no override audit", async () => {
    const a = await product("P2-GONE", { onHand: 1 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 3 }]);
    const token = tokenOf(await queue(id))!;
    await prisma.inventoryItem.update({ where: { id: a.itemId! }, data: { quantityOnHand: 10 } }); // stock received
    expect((await queue(id, { stockOverrideToken: token, stockOverrideReason: "motif" })).ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(3);
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("an accepted shortage that got worse (another reservation) is refused", async () => {
    const a = await product("P2-WORSE", { onHand: 1 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 2 }]);
    const token = tokenOf(await queue(id))!;
    await prisma.inventoryItem.update({ where: { id: a.itemId! }, data: { quantityReserved: 1 } });
    const r = await queue(id, { stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(r.ok).toBe(false);
    expect(await reserved(a.itemId)).toBe(1);
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("existing over-reservation: refused even for one unit, overridable with a reason", async () => {
    const a = await product("P2-OVER", { onHand: 1, reserved: 3 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const refused = await queue(id);
    expect(!refused.ok && refused.fieldErrors?.stockShortage?.[0]).toMatch(/déjà surréservé/);
    expect((await queue(id, { stockOverrideToken: tokenOf(refused)!, stockOverrideReason: "motif" })).ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(4);
    expect(((await overrideAudits())[0]!.metadata as { rows: { acceptedOvercommit: number }[] }).rows[0]!.acceptedOvercommit).toBe(3);
  });

  it("duplicate lines on one row are aggregated: 2 + 2 against 3 is a shortage of the row", async () => {
    const a = await product("P2-DUP", { onHand: 3 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 2 }, { productId: a.id, quantity: 2 }]);
    const r = await queue(id);
    expect(!r.ok && r.fieldErrors?.stockShortage).toHaveLength(1);
    expect(!r.ok && r.fieldErrors?.stockShortage?.[0]).toMatch(/demandé 4, disponible 3/);
    expect(await reserved(a.itemId)).toBe(0);
  });
});

describe("token validation and reason", () => {
  async function refusedFor(sku: string) {
    const a = await product(sku, { onHand: 0 });
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    return { id, token: tokenOf(await queue(id))!, a };
  }

  it("tampered, foreign-order, other-actor and expired tokens are refused; nothing changes", async () => {
    await loginAs("MANAGER");
    const one = await refusedFor("P2-T1");
    const two = await refusedFor("P2-T2");
    const tampered = one.token.slice(0, -1) + (one.token.endsWith("0") ? "1" : "0");
    for (const t of [tampered, two.token, "garbage"]) {
      const r = await queue(one.id, { stockOverrideToken: t, stockOverrideReason: "motif" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/n'est plus valable/);
    }
    await loginAs("MANAGER"); // another manager cannot use the first one's token
    const r = await queue(one.id, { stockOverrideToken: one.token, stockOverrideReason: "motif" });
    expect(!r.ok && r.error).toMatch(/n'est plus valable/);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60 * 1000);
    const manager = await loginAs("MANAGER");
    const fresh = await refusedFor("P2-T3");
    vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60 * 1000);
    const expired = await queue(fresh.id, { stockOverrideToken: fresh.token, stockOverrideReason: "motif" });
    expect(!expired.ok && expired.error).toMatch(/n'est plus valable/);
    expect(manager.id).toBeTruthy();
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("reason: missing, blank, 2 chars, 501 chars refused; 3 and 500 (trimmed) accepted", async () => {
    await loginAs("MANAGER");
    for (const reason of ["", "   ", "ab", " a ", "x".repeat(501)]) {
      const { id, token } = await refusedFor(`P2-R-${reason.length}-${Math.random()}`);
      const r = await queue(id, { stockOverrideToken: token, stockOverrideReason: reason });
      expect(r.ok, JSON.stringify(reason)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/motif/i);
    }
    for (const reason of ["abc", "  abc  ", "y".repeat(500)]) {
      const { id, token } = await refusedFor(`P2-OK-${reason.length}-${Math.random()}`);
      expect((await queue(id, { stockOverrideToken: token, stockOverrideReason: reason })).ok).toBe(true);
    }
  });
});

describe("authorisation: hard role check + DENY-only permission", () => {
  it("OWNER, ADMIN and MANAGER may override", async () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER"] as const) {
      await loginAs(role);
      const a = await product(`P2-ROLE-${role}`, { onHand: 0 });
      const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
      const token = tokenOf(await queue(id));
      expect(token, role).toBeTruthy();
      expect((await queue(id, { stockOverrideToken: token!, stockOverrideReason: "motif" })).ok, role).toBe(true);
    }
  });

  it("other roles are refused even with a VALID signed token — and even with a forged GRANT row", async () => {
    const a = await product("P2-NOROLE", { onHand: 0 });
    const agent = await loginAs("CONFIRMATION");
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const refused = await queue(id);
    expect(!refused.ok && refused.fieldErrors?.canOverride).toEqual(["false"]);
    // A token signed with the real secret for THIS user and order (worst case: the attacker has one).
    const signed = signStockOverrideToken(
      { orderId: id, actorUserId: agent.id, rows: [{ rowKey: stockRowKey(warehouseId, { productId: a.id }), requested: 1, onHand: 0, reserved: 0, acceptedOvercommit: 1 }] },
      env.AUTH_SECRET
    );
    const crafted = await queue(id, { stockOverrideToken: signed, stockOverrideReason: "motif" });
    expect(!crafted.ok && crafted.error).toMatch(/Seuls un propriétaire, un administrateur ou un responsable/);
    // A GRANT row inserted directly in the database (bypassing the server refusal):
    await prisma.userPermissionOverride.create({ data: { userId: agent.id, permission: "orders.confirm_out_of_stock", effect: "GRANT" } });
    const forged = await queue(id, { stockOverrideToken: signed, stockOverrideReason: "motif" });
    expect(!forged.ok && forged.error).toMatch(/Seuls un propriétaire/);
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("NOUVELLE");
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("the server refuses to GRANT the capability; a MANAGER DENY is stored and respected", async () => {
    const admin = await createTestUser({ role: "ADMIN" });
    const agent = await createTestUser({ role: "CONFIRMATION" });
    const manager = await createTestUser({ role: "MANAGER" });
    await grantLocationAccess(manager.id, warehouseId);
    mockCookieStore.clear();
    await loginAsTestUserAs(admin.id);
    const grant = await setUserPermissionOverridesAction({ userId: agent.id, grants: ["orders.confirm_out_of_stock"], denies: [] });
    expect(grant.ok).toBe(false);
    if (!grant.ok) expect(grant.error).toMatch(/ne peut pas être accordée/);
    const deny = await setUserPermissionOverridesAction({ userId: manager.id, grants: [], denies: ["orders.confirm_out_of_stock"] });
    expect(deny.ok).toBe(true);
    const ownerDeny = await setUserPermissionOverridesAction({ userId: admin.id, grants: [], denies: ["orders.confirm_out_of_stock"] });
    expect(ownerDeny.ok).toBe(false); // global roles cannot be narrowed (existing rule)

    const a = await product("P2-DENY", { onHand: 0 });
    const ok = await product("P2-DENY-OK", { onHand: 5 });
    mockCookieStore.clear();
    await loginAsTestUserAs(manager.id);
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const refused = await queue(id);
    expect(!refused.ok && refused.fieldErrors?.canOverride).toEqual(["false"]);
    expect(tokenOf(refused)).toBeNull();
    // normal confirmation is unaffected by the DENY
    const fine = await nouvelle([{ productId: ok.id, quantity: 1 }]);
    expect((await queue(fine)).ok).toBe(true);
  });
});

describe("rollback after the override audit was written", () => {
  it("a failure after the audit insert rolls back the audit AND every confirmation change", async () => {
    const a = await product("P2-RB", { onHand: 0 });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const token = tokenOf(await queue(id))!;
    const before = await footprint(id);
    failure.reserve = true; // throws inside reserveStockForOrder, AFTER the audit insert
    const r = await queue(id, { stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(r.ok).toBe(false);
    expect(await overrideAudits()).toHaveLength(0);
    expect(await footprint(id)).toEqual(before);
    expect(await reserved(a.itemId)).toBe(0);
  });
});

describe("untracked stock", () => {
  it("no InventoryItem row at the warehouse: confirmed (« Stock non suivi »), nothing reserved, no audit", async () => {
    const a = await product("P2-NOROW", { row: false });
    await loginAs("CONFIRMATION");
    const id = await nouvelle([{ productId: a.id, quantity: 4 }]);
    expect((await queue(id)).ok).toBe(true);
    expect(await prisma.inventoryMovement.count({ where: { orderId: id } })).toBe(0);
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("trackInventory=false: never blocked, but the reservation is still taken and released symmetrically", async () => {
    const a = await product("P2-UNTRACKED", { onHand: 0, tracked: false });
    await loginAs("MANAGER");
    const id = await nouvelle([{ productId: a.id, quantity: 2 }]);
    expect((await queue(id)).ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(2);
    // tracking switched back ON before cancellation: release still undoes exactly what was reserved
    await prisma.product.update({ where: { id: a.id }, data: { trackInventory: true } });
    expect((await updateOrderStatusAction(fd({ id, status: "ANNULEE" }))).ok).toBe(true);
    expect(await reserved(a.itemId)).toBe(0);
  });
});

describe("variations, warehouses, picker, tenants, concurrency", () => {
  it("variations are independent rows: a short variation never blocks another", async () => {
    const p = await prisma.product.create({ data: { name: "T-shirt", sku: "P2-VAR", price: 100, status: "ACTIF" } });
    const s = await prisma.productVariation.create({ data: { productId: p.id, sku: "P2-VAR-S", attributes: { taille: "S" } } });
    const m = await prisma.productVariation.create({ data: { productId: p.id, sku: "P2-VAR-M", attributes: { taille: "M" } } });
    await prisma.inventoryItem.create({ data: { warehouseId, variationId: s.id, quantityOnHand: 0 } });
    await prisma.inventoryItem.create({ data: { warehouseId, variationId: m.id, quantityOnHand: 5 } });
    await loginAs("CONFIRMATION");
    expect((await queue(await nouvelle([{ productId: p.id, variationId: m.id, quantity: 2 }]))).ok).toBe(true);
    const shortS = await queue(await nouvelle([{ productId: p.id, variationId: s.id, quantity: 1 }]));
    expect(!shortS.ok && shortS.fieldErrors?.stockShortage?.[0]).toMatch(/T-shirt S \(P2-VAR-S\)/);

    const picker = await searchProductsForOrderAction("P2-VAR", warehouseId);
    const variations = picker.find((x) => x.id === p.id)!.variations;
    expect(variations.find((v) => v.id === m.id)!.stock).toMatchObject({ state: "tracked", available: 3, onHand: 5, reserved: 2 });
    expect(variations.find((v) => v.id === s.id)!.stock).toMatchObject({ state: "tracked", available: 0 });
  });

  it("stock at another warehouse never counts; the picker shows the selected warehouse only", async () => {
    const other = await prisma.warehouse.create({ data: { name: "Entrepôt Rabat" } });
    const a = await product("P2-WH", { onHand: 0 });
    await prisma.inventoryItem.create({ data: { warehouseId: other.id, productId: a.id, quantityOnHand: 50 } });
    const user = await loginAs("MANAGER");
    const r = await queue(await nouvelle([{ productId: a.id, quantity: 1 }]));
    expect(r.ok).toBe(false);
    expect((await searchProductsForOrderAction("P2-WH", warehouseId))[0]!.stock).toMatchObject({ state: "tracked", available: 0 });
    // no access to the other warehouse yet → refused; with access → its own stock
    await expect(searchProductsForOrderAction("P2-WH", other.id)).rejects.toThrow(/Non autorisé/);
    await grantLocationAccess(user.id, other.id);
    expect((await searchProductsForOrderAction("P2-WH", other.id))[0]!.stock).toMatchObject({ state: "tracked", available: 50 });
    const lines = await getOrderLinesStockAction(other.id, [{ productId: a.id }]);
    expect(lines[`p:${a.id}`]).toMatchObject({ state: "tracked", available: 50 });
    // never a cost in the payload
    expect(JSON.stringify(lines)).not.toMatch(/cost/i);
  });

  it("tenant isolation: another tenant's stock never appears", async () => {
    const B = "tenant-b-p2";
    await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
    const whB = await prismaBase.warehouse.create({ data: { tenantId: B, name: "Entrepôt B", isDefault: true } });
    const pB = await prismaBase.product.create({ data: { tenantId: B, name: "Secret B", sku: "P2-SECRET-B", price: 1, status: "ACTIF" } });
    await prismaBase.inventoryItem.create({ data: { tenantId: B, warehouseId: whB.id, productId: pB.id, quantityOnHand: 999 } });
    await loginAs("ADMIN");
    expect(await searchProductsForOrderAction("P2-SECRET-B", warehouseId)).toEqual([]);
    expect((await getOrderLinesStockAction(warehouseId, [{ productId: pB.id }]))[`p:${pB.id}`]).toMatchObject({ state: "no_row", available: null });
    await expect(searchProductsForOrderAction("x", whB.id)).rejects.toThrow(/invalide/);
  });

  it("two orders competing for the last unit (queue, in parallel): exactly one is confirmed", async () => {
    const a = await product("P2-LAST", { onHand: 1 });
    await loginAs("MANAGER");
    const o1 = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const o2 = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const results = await Promise.all([queue(o1), queue(o2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.fieldErrors?.stockShortage)).toHaveLength(1);
    expect(await reserved(a.itemId)).toBe(1);
    const statuses = (await prisma.order.findMany({ where: { id: { in: [o1, o2] } } })).map((o) => o.status).sort();
    expect(statuses).toEqual(["CONFIRMEE", "NOUVELLE"]);
  });

  it("reversed multi-line orders confirmed in parallel: no unhandled error, consistent stock", async () => {
    const a = await product("P2-RA", { onHand: 100 });
    const b = await product("P2-RB2", { onHand: 100 });
    await loginAs("MANAGER");
    for (let i = 0; i < 4; i++) {
      const x = await nouvelle([{ productId: a.id, quantity: 1 }, { productId: b.id, quantity: 1 }]);
      const y = await nouvelle([{ productId: b.id, quantity: 1 }, { productId: a.id, quantity: 1 }]);
      const results = await Promise.all([queue(x), status(y)]);
      expect(results.map((r) => r.ok), `round ${i}`).toEqual([true, true]);
    }
    expect([await reserved(a.itemId), await reserved(b.itemId)]).toEqual([8, 8]);
  });
});

// ---------------------------------------------------------------------------
// P2 audit follow-ups
// ---------------------------------------------------------------------------

describe("tracking flag — one rule for the check and the warnings", () => {
  it("variation's product wins, then the product; unknown (not loaded) → tracked", () => {
    expect(lineTrackInventory({})).toBe(true);
    expect(lineTrackInventory({ product: null, variation: null })).toBe(true);
    expect(lineTrackInventory({ product: { trackInventory: false } })).toBe(false);
    expect(lineTrackInventory({ product: { trackInventory: true }, variation: { product: { trackInventory: false } } })).toBe(false);
    // variation loaded WITHOUT the flag (getOrderDetail's shape) → the product's flag
    expect(lineTrackInventory({ product: { trackInventory: false }, variation: { product: {} } })).toBe(false);
    expect(lineTrackInventory({ product: {}, variation: { product: null } })).toBe(true);
  });
});

describe("queue stock flags (stockFlagsForOrders, on the real queue query)", () => {
  it("insufficient / untracked sets: no row, tracking off, sufficient, short, duplicate lines, legacy warehouse", async () => {
    const noRow = await product("P2-F-NOROW", { row: false });
    const off = await product("P2-F-OFF", { onHand: 0, tracked: false });
    const fine = await product("P2-F-FINE", { onHand: 10 });
    const short = await product("P2-F-SHORT", { onHand: 1 });
    const dup = await product("P2-F-DUP", { onHand: 3 });
    await loginAs("CONFIRMATION");
    const ids = {
      noRow: await nouvelle([{ productId: noRow.id, quantity: 1 }]),
      off: await nouvelle([{ productId: off.id, quantity: 5 }]),
      fine: await nouvelle([{ productId: fine.id, quantity: 2 }]),
      short: await nouvelle([{ productId: short.id, quantity: 2 }]),
      dup: await nouvelle([{ productId: dup.id, quantity: 2 }, { productId: dup.id, quantity: 2 }]),
      mixed: await nouvelle([{ productId: fine.id, quantity: 1 }, { productId: noRow.id, quantity: 1 }]),
    };
    // legacy order without a fulfilment warehouse → per-line resolution (default warehouse)
    const legacy = await prisma.order.create({
      data: {
        customerId,
        subtotal: 100,
        total: 100,
        items: { create: [{ productId: short.id, nameSnapshot: "x", skuSnapshot: "x", unitPrice: 100, quantity: 5, total: 500 }] },
      },
    });

    const { orders } = await listOrdersAwaitingConfirmation({});
    const flags = await stockFlagsForOrders(orders);
    expect([...flags.insufficient].sort()).toEqual([ids.short, ids.dup, legacy.id].sort());
    expect([...flags.untracked].sort()).toEqual([ids.noRow, ids.off, ids.mixed].sort());
    expect(flags.insufficient.has(ids.fine) || flags.untracked.has(ids.fine)).toBe(false);
  });

  it("the order page's « → Confirmée » notice follows the same flags", () => {
    expect(confirmationStockNotice(null)).toEqual([]);
    expect(confirmationStockNotice({ insufficient: false, untracked: false })).toEqual([]);
    expect(confirmationStockNotice({ insufficient: false, untracked: true })).toEqual([
      expect.stringMatching(/^Stock non suivi pour au moins un article/),
    ]);
    const both = confirmationStockNotice({ insufficient: true, untracked: true });
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/refusée, sauf validation motivée d'un responsable/);
  });
});

describe("token expiry and MANAGER DENY on the other paths", () => {
  it("« Client déjà confirmé »: an expired token is refused and nothing is created", async () => {
    const a = await product("P2-EXP-C", { onHand: 0 });
    await loginAs("MANAGER");
    const token = tokenOf(await createOrderAction(createInput(a.id, 1, true)))!;
    expect(token).toBeTruthy();
    const orders = await prisma.order.count();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60 * 1000);
    const r = await createOrderAction({ ...createInput(a.id, 1, true), stockOverrideToken: token, stockOverrideReason: "motif" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/n'est plus valable/);
    expect(await prisma.order.count()).toBe(orders);
    expect(await reserved(a.itemId)).toBe(0);
    expect(await overrideAudits()).toHaveLength(0);
  });

  async function deniedManager() {
    const admin = await createTestUser({ role: "ADMIN" });
    const manager = await createTestUser({ role: "MANAGER" });
    await grantLocationAccess(manager.id, warehouseId);
    mockCookieStore.clear();
    await loginAsTestUserAs(admin.id);
    expect((await setUserPermissionOverridesAction({ userId: manager.id, grants: [], denies: ["orders.confirm_out_of_stock"] })).ok).toBe(true);
    mockCookieStore.clear();
    await loginAsTestUserAs(manager.id);
    return manager;
  }

  it("a DENIED manager cannot override on the status-change path (no token, crafted token refused)", async () => {
    const manager = await deniedManager();
    const a = await product("P2-DENY-ST", { onHand: 0 });
    const id = await nouvelle([{ productId: a.id, quantity: 1 }]);
    const refused = await status(id);
    expect(!refused.ok && refused.fieldErrors?.canOverride).toEqual(["false"]);
    expect(tokenOf(refused)).toBeNull();
    const signed = signStockOverrideToken(
      { orderId: id, actorUserId: manager.id, rows: [{ rowKey: stockRowKey(warehouseId, { productId: a.id }), requested: 1, onHand: 0, reserved: 0, acceptedOvercommit: 1 }] },
      env.AUTH_SECRET
    );
    const crafted = await status(id, { stockOverrideToken: signed, stockOverrideReason: "motif" });
    expect(!crafted.ok && crafted.error).toMatch(/Seuls un propriétaire/);
    expect((await prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe("NOUVELLE");
    expect(await overrideAudits()).toHaveLength(0);
  });

  it("a DENIED manager cannot override on the « Client déjà confirmé » path", async () => {
    await deniedManager();
    const a = await product("P2-DENY-C", { onHand: 0 });
    const refused = await createOrderAction(createInput(a.id, 1, true));
    expect(!refused.ok && refused.fieldErrors?.canOverride).toEqual(["false"]);
    expect(tokenOf(refused)).toBeNull();
    expect(await prisma.order.count()).toBe(0);
  });
});

describe("cross-tenant confirmation isolation", () => {
  it("a tenant-A user can neither confirm nor override a tenant-B order, and B's stock is untouched", async () => {
    const B = "tenant-b-p2-confirm";
    await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
    const whB = await prismaBase.warehouse.create({ data: { tenantId: B, name: "Entrepôt B", isDefault: true } });
    const pB = await prismaBase.product.create({ data: { tenantId: B, name: "B", sku: "P2-XT-B", price: 1, status: "ACTIF" } });
    const itemB = await prismaBase.inventoryItem.create({ data: { tenantId: B, warehouseId: whB.id, productId: pB.id, quantityOnHand: 0 } });
    const cB = await prismaBase.customer.create({ data: { tenantId: B, fullName: "Client B" } });
    const orderB = await prismaBase.order.create({
      data: {
        tenantId: B,
        customerId: cB.id,
        subtotal: 1,
        total: 1,
        fulfillmentWarehouseId: whB.id,
        items: { create: [{ tenantId: B, productId: pB.id, nameSnapshot: "B", skuSnapshot: "B", unitPrice: 1, quantity: 1, total: 1 }] },
      },
    });
    const managerA = await loginAs("MANAGER");
    // A token signed for B's order with A's identity is still useless: the order is invisible to A.
    const signed = signStockOverrideToken(
      { orderId: orderB.id, actorUserId: managerA.id, rows: [{ rowKey: stockRowKey(whB.id, { productId: pB.id }), requested: 1, onHand: 0, reserved: 0, acceptedOvercommit: 1 }] },
      env.AUTH_SECRET
    );
    for (const r of [
      await queue(orderB.id),
      await status(orderB.id),
      await queue(orderB.id, { stockOverrideToken: signed, stockOverrideReason: "motif" }),
      await status(orderB.id, { stockOverrideToken: signed, stockOverrideReason: "motif" }),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBe("Commande introuvable.");
        expect(r.fieldErrors?.stockShortage).toBeUndefined(); // nothing about B's stock leaks
      }
    }
    // creating with B's product id from tenant A is refused before any confirmation
    const create = await createOrderAction({ ...createInput(pB.id, 1, true), stockOverrideToken: signed, stockOverrideReason: "motif" });
    expect(create.ok).toBe(false);
    const after = await prismaBase.order.findUniqueOrThrow({ where: { id: orderB.id } });
    expect(after.status).toBe("NOUVELLE");
    expect((await prismaBase.inventoryItem.findUniqueOrThrow({ where: { id: itemB.id } })).quantityReserved).toBe(0);
    expect(await prismaBase.auditEvent.count({ where: { action: "order.stock_override" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function createInput(productId: string, quantity: number, alreadyConfirmed: boolean): CreateOrderInput {
  return {
    customerId,
    paymentMethod: "PAIEMENT_LIVRAISON",
    channel: "WHATSAPP",
    customerAlreadyConfirmed: alreadyConfirmed,
    shippingCost: 0,
    discountTotal: 0,
    currency: "MAD",
    notes: "",
    internalNotes: "",
    shippingAddressLine1: "",
    shippingAddressLine2: "",
    shippingCity: "",
    shippingRegion: "",
    shippingCountry: "",
    shippingPhone: "",
    items: [{ productId, quantity, unitPrice: 100, discount: 0 }],
  };
}

/** Logs in an EXISTING user (session cookie), for tests that create users first. */
async function loginAsTestUserAs(userId: string) {
  const { createSession } = await import("@/lib/auth/session");
  await createSession(userId);
}

// M3 — a tracked row the pre-read did not see must never be reserved
// unchecked. Reproduced by divergence: the pre-read checks W1 (stock there),
// the reservation lands on the order's REAL warehouse W2 (none there).
describe("reserveForConfirmation — rows unseen by the pre-read are held to physical stock", () => {
  it("a tracked line reaching an unchecked row is refused and rolled back (no silent overcommit)", async () => {
    const admin = await loginAs("ADMIN");
    const w2 = await prisma.warehouse.create({ data: { name: "Dépôt W2" } });
    const p = await product("M3-TRACKED", { onHand: 5 }); // W1: plenty
    const atW2 = await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: p.id, quantityOnHand: 0 } });
    const orderId = await nouvelle([{ productId: p.id, quantity: 1 }], w2.id);

    await expect(
      prisma.$transaction((tx) =>
        reserveForConfirmation(tx, {
          orderId,
          fulfillmentWarehouseId: warehouseId, // stale pre-read: W1
          lines: [{ productId: p.id, variationId: null, quantity: 1, product: { trackInventory: true }, variation: null }],
          confirmerUserId: admin.id,
        })
      )
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await reserved(atW2.id)).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { orderId } })).toBe(0);
  });

  it("an untracked product keeps its historical no-ceiling reservation", async () => {
    const admin = await loginAs("ADMIN");
    const w2 = await prisma.warehouse.create({ data: { name: "Dépôt W2" } });
    const p = await product("M3-FREE", { onHand: 5, tracked: false });
    const atW2 = await prisma.inventoryItem.create({ data: { warehouseId: w2.id, productId: p.id, quantityOnHand: 0 } });
    const orderId = await nouvelle([{ productId: p.id, quantity: 1 }], w2.id);

    await prisma.$transaction((tx) =>
      reserveForConfirmation(tx, {
        orderId,
        fulfillmentWarehouseId: warehouseId,
        lines: [{ productId: p.id, variationId: null, quantity: 1, product: { trackInventory: false }, variation: null }],
        confirmerUserId: admin.id,
      })
    );
    expect(await reserved(atW2.id)).toBe(1);
  });
});
