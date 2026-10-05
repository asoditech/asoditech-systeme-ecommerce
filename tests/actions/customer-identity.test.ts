import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
import { createCustomerForOrderAction, searchCustomersForOrderAction } from "@/actions/orders";
import { createSaleCustomerAction, findSaleCustomersByPhoneAction } from "@/actions/sales";
import { quickSearchAction } from "@/actions/search";
import { customerPhoneKey } from "@/lib/customers/identity";
import { customerVisibilityWhere } from "@/lib/customers/visibility";
import { listCustomers, getCustomerDetail } from "@/lib/queries/customers";
import { getCurrentUser } from "@/lib/auth/session";
import { resetDb, setTestBusinessMode, DEFAULT_TENANT_ID } from "../helpers/db";
import { loginAsTestUser, grantChannelAccess, ensureDefaultOnlineChannelFor } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Customer identity (normalized name + phoneKey), its one entry point
 * findOrCreateCustomer, the derived visibility filter and the sale-form
 * client lookup. Pure normalization rules: tests/lib/customer-identity.test.ts.
 */

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("migration backfill — SQL gives the same phoneKey as customerPhoneKey()", () => {
  it("every phone format", async () => {
    const phones = [
      "0612345678", "+212612345678", "212612345678", "06 12 34 56 78", "06-12-34-56-78", "00212612345678",
      "+212 6 12 34 56 78", "612345678", " 06.12.34.56.78 ", "0522123456", "0700000000", "+33612345678",
      "0033 6 12 34 56 78", "12345", "abc", "06123", "0812345678", "+2126123", "06 12 34 56 78 99", "", "   ",
      "(06) 12/34/56/78", "+1 415 555 2671", "0612345678 ext", "2126123456789",
    ];
    for (const [i, phone] of phones.entries()) {
      await prismaBase.customer.create({ data: { tenantId: DEFAULT_TENANT_ID, fullName: `C${i}`, phone } });
    }
    const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261006120000_customer_phone_key/migration.sql"), "utf8");
    const update = sql.slice(sql.indexOf('UPDATE "customers"'));
    await prismaBase.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(update);
    });
    const rows = await prismaBase.customer.findMany({ select: { phone: true, phoneKey: true } });
    expect(rows).toHaveLength(phones.length);
    for (const r of rows) expect(r.phoneKey, JSON.stringify(r.phone)).toBe(customerPhoneKey(r.phone));
  });
});

describe("findOrCreateCustomer through the Clients form", () => {
  it("same name + same phone (any format) → the existing customer, untouched; otherwise a new one", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const first = await createCustomerAction(fd({ fullName: "Youness Ayoub", phone: "0612345678", city: "Rabat" }));
    expect(first.ok && first.data.reused).toBe(false);
    if (!first.ok) return;
    expect(first.data.phoneKey).toBe("212612345678");

    const again = await createCustomerAction(fd({ fullName: "  youness  AYOUB ", phone: "+212 6 12 34 56 78", city: "Fès" }));
    expect(again.ok && again.data.reused).toBe(true);
    expect(again.ok && again.data.id).toBe(first.data.id);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: first.data.id } })).city).toBe("Rabat");

    const otherName = await createCustomerAction(fd({ fullName: "Karim Ayoub", phone: "0612345678" }));
    const otherPhone = await createCustomerAction(fd({ fullName: "Youness Ayoub", phone: "0699999999" }));
    expect(otherName.ok && otherName.data.reused).toBe(false);
    expect(otherPhone.ok && otherPhone.data.reused).toBe(false);

    // No / invalid phone → never matched.
    await createCustomerAction(fd({ fullName: "Sans Tel" }));
    await createCustomerAction(fd({ fullName: "Sans Tel" }));
    await createCustomerAction(fd({ fullName: "Tel Faux", phone: "123" }));
    await createCustomerAction(fd({ fullName: "Tel Faux", phone: "123" }));
    expect(await prisma.customer.count()).toBe(7);
    expect(await prisma.auditEvent.count({ where: { action: "customer.created" } })).toBe(7);
  });

  it("concurrent identical requests create ONE customer", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => createCustomerAction(fd({ fullName: "Sara Amrani", phone: "0611223344" })))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await prisma.customer.count()).toBe(1);
  });

  it("editing a customer's phone recomputes phoneKey", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const c = await createCustomerAction(fd({ fullName: "Amine", phone: "0612345678" }));
    if (!c.ok) throw new Error(c.error);
    await updateCustomerAction(fd({ id: c.data.id, fullName: "Amine", phone: "+33 6 12 34 56 78" }));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.data.id } })).phoneKey).toBe("33612345678");
    await updateCustomerAction(fd({ id: c.data.id, fullName: "Amine", phone: "" }));
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.data.id } })).phoneKey).toBeNull();
  });
});

describe("order form quick-create", () => {
  it("reuses the same name + phone with its saved address; a new name is a new customer", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const a = await createCustomerForOrderAction({ fullName: "Sara Amrani", phone: "0611223344", city: "Rabat", addressLine1: "1 Rue X" });
    if (!a.ok) throw new Error(a.error);
    const b = await createCustomerForOrderAction({ fullName: "sara amrani", phone: "06 11 22 33 44", city: "Fès", addressLine1: "2 Rue Y" });
    if (!b.ok) throw new Error(b.error);
    expect(b.data.id).toBe(a.data.id);
    expect(b.data.defaultAddress).toEqual({ addressLine1: "1 Rue X", city: "Rabat", phone: "0611223344" });
    expect(await prisma.customerAddress.count()).toBe(1);

    const c = await createCustomerForOrderAction({ fullName: "Nadia Amrani", phone: "0611223344" });
    expect(c.ok && c.data.id).not.toBe(a.data.id);
  });
});

describe("customer visibility", () => {
  beforeEach(async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
  });

  async function seedActivity() {
    const online = await ensureDefaultOnlineChannelFor();
    const otherOnline = await prismaBase.salesChannel.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Autre boutique", kind: "ONLINE" } });
    const store = await prismaBase.salesChannel.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Magasin", kind: "OFFLINE" } });
    const wh = await prismaBase.warehouse.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Boutique" } });
    const mk = (fullName: string) => prismaBase.customer.create({ data: { tenantId: DEFAULT_TENANT_ID, fullName, phone: null } });
    const onMine = await mk("Client En Ligne");
    const onNull = await mk("Client Sans Canal");
    const onOther = await mk("Client Autre Boutique");
    const inStore = await mk("Client Magasin");
    const fresh = await mk("Client Nouveau");
    const order = (customerId: string, salesChannelId: string | null) =>
      prismaBase.order.create({ data: { tenantId: DEFAULT_TENANT_ID, customerId, salesChannelId, subtotal: 1, total: 1 } });
    await order(onMine.id, online.id);
    await order(onNull.id, null);
    await order(onOther.id, otherOnline.id);
    await prismaBase.sale.create({
      data: { tenantId: DEFAULT_TENANT_ID, salesChannelId: store.id, warehouseId: wh.id, idempotencyKey: "k-cust-1", subtotal: 1, total: 1, customerId: inStore.id },
    });
    return { onMine, onNull, onOther, inStore, fresh, store };
  }
  const names = async (where: object) =>
    (await prisma.customer.findMany({ where, select: { fullName: true }, orderBy: { fullName: "asc" } })).map((c) => c.fullName);

  it("OWNER / ADMIN / MANAGER see every customer", async () => {
    await seedActivity();
    for (const role of ["ADMIN", "MANAGER"] as const) {
      mockCookieStore.clear();
      await loginAsTestUser({ role });
      const user = (await getCurrentUser())!;
      expect(await names(customerVisibilityWhere(user))).toHaveLength(5);
    }
  });

  it("CONFIRMATION / SUPPORT: customers active on their channels + customers with no activity", async () => {
    const s = await seedActivity();
    for (const role of ["CONFIRMATION", "SUPPORT"] as const) {
      mockCookieStore.clear();
      await loginAsTestUser({ role });
      const user = (await getCurrentUser())!;
      expect(await names(customerVisibilityWhere(user))).toEqual(["Client En Ligne", "Client Nouveau", "Client Sans Canal"]);
    }

    // Applied on every surface.
    const user = (await getCurrentUser())!;
    const list = await listCustomers({ scope: customerVisibilityWhere(user) });
    expect(list.total).toBe(3);
    expect(await getCustomerDetail(s.inStore.id, customerVisibilityWhere(user))).toBeNull();
    expect(await getCustomerDetail(s.onMine.id, customerVisibilityWhere(user))).not.toBeNull();
    expect((await quickSearchAction("Client")).filter((r) => r.type === "customer")).toHaveLength(3);

    // A user given the store channel also sees that store's customers.
    await grantChannelAccess(user.id, s.store.id);
    const withStore = (await getCurrentUser())!;
    expect(await names(customerVisibilityWhere(withStore))).toContain("Client Magasin");
  });

  it("ONLINE_ONLY tenant: no channel scope exists, everyone with customers.view sees every customer", async () => {
    await seedActivity();
    await setTestBusinessMode("ONLINE_ONLY");
    await loginAsTestUser({ role: "CONFIRMATION" });
    const user = (await getCurrentUser())!;
    expect(await names(customerVisibilityWhere(user))).toHaveLength(5);
  });

  it("the order form's customer search is filtered too", async () => {
    await seedActivity();
    await loginAsTestUser({ role: "CONFIRMATION" });
    expect((await searchCustomersForOrderAction("Client")).map((c) => c.fullName).sort()).toEqual([
      "Client En Ligne",
      "Client Nouveau",
      "Client Sans Canal",
    ]);
  });
});

describe("order form customer search — name OR (partial) phone", () => {
  it("finds by name, by 4–5 digits and by the full number in any format; returns the default address for the prefill", async () => {
    const admin = await loginAsTestUser({ role: "ADMIN" });
    const sara = await prisma.customer.create({
      data: { fullName: "Sara Amrani", phone: "06 12 34 56 78", phoneKey: "212612345678", createdById: admin.id, city: "Fès" },
    });
    await prisma.customerAddress.create({ data: { customerId: sara.id, addressLine1: "1 Rue X", city: "Rabat", phone: "0612345678", isDefault: true } });
    await prisma.customer.create({ data: { fullName: "Karim Bennani", phone: "0699887766", phoneKey: "212699887766" } });

    const names = async (q: string) => (await searchCustomersForOrderAction(q)).map((c) => c.fullName).sort();
    expect(await names("sara")).toEqual(["Sara Amrani"]);
    expect(await names("3456")).toEqual(["Sara Amrani"]); // stored as "06 12 34 56 78"
    expect(await names("45678")).toEqual(["Sara Amrani"]);
    expect(await names("0612345678")).toEqual(["Sara Amrani"]);
    expect(await names("+212 612 34 56 78")).toEqual(["Sara Amrani"]);
    expect(await names("9988")).toEqual(["Karim Bennani"]);
    expect(await names("5555")).toEqual([]);

    const [hit] = await searchCustomersForOrderAction("3456");
    expect(hit.addresses).toEqual([{ addressLine1: "1 Rue X", city: "Rabat", phone: "0612345678" }]);
    expect(await prisma.customer.count()).toBe(2); // a search never creates
  });

  it("partial phone search still honours customer visibility", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    const store = await prismaBase.salesChannel.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Magasin", kind: "OFFLINE" } });
    const wh = await prismaBase.warehouse.create({ data: { tenantId: DEFAULT_TENANT_ID, name: "Boutique" } });
    const inStore = await prismaBase.customer.create({ data: { tenantId: DEFAULT_TENANT_ID, fullName: "Client Magasin", phone: "0611223344", phoneKey: "212611223344" } });
    await prismaBase.sale.create({
      data: { tenantId: DEFAULT_TENANT_ID, salesChannelId: store.id, warehouseId: wh.id, idempotencyKey: "k-cust-2", subtotal: 1, total: 1, customerId: inStore.id },
    });
    await prismaBase.customer.create({ data: { tenantId: DEFAULT_TENANT_ID, fullName: "Client Libre", phone: "0611223399", phoneKey: "212611223399" } });
    await loginAsTestUser({ role: "CONFIRMATION" });
    expect((await searchCustomersForOrderAction("112233")).map((c) => c.fullName)).toEqual(["Client Libre"]);
  });
});

describe("sale form client — exact phone only", () => {
  beforeEach(async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
  });

  it("finds by the full number in any format, shows a masked phone, never partial", async () => {
    const owner = await loginAsTestUser({ role: "ADMIN" });
    await prisma.customer.create({ data: { fullName: "Sara Amrani", phone: "0611223344", phoneKey: "212611223344", createdById: owner.id } });
    await prisma.customer.create({ data: { fullName: "Nadia Amrani", phone: "+212611223344", phoneKey: "212611223344" } });

    const hit = await findSaleCustomersByPhoneAction("06 11 22 33 44");
    expect(hit.ok && hit.data.map((c) => [c.fullName, c.maskedPhone])).toEqual([
      ["Sara Amrani", "••••••44"],
      ["Nadia Amrani", "••••••44"],
    ]);
    expect(JSON.stringify(hit)).not.toContain("0611223344");

    expect((await findSaleCustomersByPhoneAction("0611")).ok).toBe(false);
    expect((await findSaleCustomersByPhoneAction("Sara")).ok).toBe(false);
    const none = await findSaleCustomersByPhoneAction("0699999999");
    expect(none.ok && none.data).toEqual([]);
  });

  it("create reuses the same name + phone; needs a name and a valid phone", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const a = await createSaleCustomerAction({ fullName: "Sara Amrani", phone: "0611223344" });
    const b = await createSaleCustomerAction({ fullName: "SARA amrani", phone: "+212 611 22 33 44" });
    expect(a.ok && b.ok && a.data.id === b.data.id).toBe(true);
    expect(await prisma.customer.count()).toBe(1);
    expect((await createSaleCustomerAction({ fullName: "X", phone: "0611223344" })).ok).toBe(false);
    expect((await createSaleCustomerAction({ fullName: "Karim", phone: "123" })).ok).toBe(false);
  });

  it("a user without sales.create cannot look customers up", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(findSaleCustomersByPhoneAction("0611223344")).rejects.toThrow(/non autorisé/i);
  });
});
