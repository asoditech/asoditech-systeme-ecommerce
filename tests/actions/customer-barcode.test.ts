import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, prismaBase } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
import { updateCustomerBarcodeSettingAction } from "@/actions/settings";
import { setTenantCustomerBarcodeGrantAction } from "@/actions/tenants";
import { createProductAction } from "@/actions/products";
import { addBarcodeAction } from "@/actions/catalog";
import { findSaleCustomerByCodeAction, createSaleCustomerAction } from "@/actions/sales";
import { searchCustomersForOrderAction } from "@/actions/orders";
import { quickSearchAction } from "@/actions/search";
import { findOrCreateCustomer } from "@/lib/customers/find-or-create";
import { listCustomers } from "@/lib/queries/customers";
import { buildTenantBackup } from "@/lib/backup/export";
import { inspectBackup, restoreTenantBackup } from "@/lib/backup/import";
import { DEFAULT_TENANT_ID, resetDb, setTestBusinessMode } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

/**
 * Automatic customer codes « CL-000001 » (docs/adr/0060): platform grant,
 * tenant switch, generation in findOrCreateCustomer, stability, uniqueness,
 * reserved product pattern, search / sale picker lookup, backup/restore.
 */

const TENANT_B = "tenant-b-codes";

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function grant(tenantId = DEFAULT_TENANT_ID, granted = true) {
  await prismaBase.tenant.update({ where: { id: tenantId }, data: { customerBarcodesGranted: granted } });
}

async function setSwitch(enabled: boolean, tenantId = DEFAULT_TENANT_ID) {
  await runWithTenant(tenantId, "test", () =>
    prisma.businessSettings.upsert({ where: { tenantId }, update: { customerBarcodeEnabled: enabled }, create: { customerBarcodeEnabled: enabled } })
  );
}

async function enable(tenantId = DEFAULT_TENANT_ID) {
  await grant(tenantId);
  await setSwitch(true, tenantId);
}

let phoneSeq = 0;
async function newCustomer(name = "Client", phone?: string) {
  phoneSeq += 1;
  const result = await createCustomerAction(fd({ fullName: `${name} ${phoneSeq}`, phone: phone ?? `06${String(10000000 + phoneSeq).slice(-8)}` }));
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

beforeEach(async () => {
  await resetDb();
  mockCookieStore.clear();
  phoneSeq = 0;
});
afterEach(async () => {
  await resetDb();
  mockCookieStore.clear();
});

describe("defaults and grant", () => {
  it("off by default: no tenant is granted, the switch is off, a new customer gets no code", async () => {
    await loginAsTestUser({ role: "OWNER" });
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).customerBarcodesGranted).toBe(false);
    const c = await newCustomer();
    expect(c.barcode).toBeNull();
  });

  it("the switch alone is not enough: without the platform grant no code is generated", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await setSwitch(true); // e.g. restored from an old backup
    expect((await newCustomer()).barcode).toBeNull();
  });

  it("the tenant cannot enable it without the grant (server-side), but can once granted", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const refused = await updateCustomerBarcodeSettingAction(fd({ customerBarcodeEnabled: "on" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/pas activés pour votre entreprise/);

    await grant();
    const ok = await updateCustomerBarcodeSettingAction(fd({ customerBarcodeEnabled: "on" }));
    expect(ok.ok).toBe(true);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "settings.updated" }, orderBy: { createdAt: "desc" } });
    expect(audit.newValue).toMatchObject({ customerBarcodeEnabled: true });
    expect((await newCustomer()).barcode).toBe("CL-000001");
  });

  it("the tenant switch needs settings.manage", async () => {
    await grant();
    await loginAsTestUser({ role: "MANAGER" });
    await expect(updateCustomerBarcodeSettingAction(fd({ customerBarcodeEnabled: "on" }))).rejects.toThrow(/non autorisé/i);
  });

  it("only a platform admin can grant/revoke — a tenant OWNER cannot grant itself", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });
    await expect(setTenantCustomerBarcodeGrantAction(fd({ tenantId: DEFAULT_TENANT_ID, granted: "true" }))).rejects.toThrow(/non autorisé/i);
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).customerBarcodesGranted).toBe(false);
  });

  it("platform grant then revoke: audited; revoke switches the tenant setting off, stops new codes, keeps existing ones", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: true });
    expect((await setTenantCustomerBarcodeGrantAction(fd({ tenantId: DEFAULT_TENANT_ID, granted: "true" }))).ok).toBe(true);
    await setSwitch(true);
    const first = await newCustomer();
    expect(first.barcode).toBe("CL-000001");

    expect((await setTenantCustomerBarcodeGrantAction(fd({ tenantId: DEFAULT_TENANT_ID, granted: "false" }))).ok).toBe(true);
    const settings = await prisma.businessSettings.findFirstOrThrow();
    expect(settings.customerBarcodeEnabled).toBe(false);
    expect((await newCustomer()).barcode).toBeNull();
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: first.id } })).barcode).toBe("CL-000001");

    const audits = await prismaBase.auditEvent.findMany({ where: { action: "tenant.customer_barcode_grant_changed" }, orderBy: { createdAt: "asc" } });
    expect(audits.map((a) => a.newValue)).toEqual([{ customerBarcodesGranted: true }, { customerBarcodesGranted: false }]);
  });
});

describe("generation", () => {
  it("sequential codes CL-000001, CL-000002, … and expansion past six digits", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    expect((await newCustomer()).barcode).toBe("CL-000001");
    expect((await newCustomer()).barcode).toBe("CL-000002");
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { nextCustomerBarcodeNumber: 999999 } });
    expect((await newCustomer()).barcode).toBe("CL-999999");
    expect((await newCustomer()).barcode).toBe("CL-1000000");
  });

  it("customers without a phone are generated too (transactional path)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const r = await createCustomerAction(fd({ fullName: "Sans Téléphone" }));
    expect(r.ok && r.data.barcode).toBe("CL-000001");
  });

  it("20 parallel creations get 20 distinct codes, no gap", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const created = await Promise.all(Array.from({ length: 20 }, (_, i) => newCustomer(`Parallèle ${i}`)));
    const codes = created.map((c) => c.barcode);
    expect(new Set(codes).size).toBe(20);
    expect([...codes].sort()).toEqual(Array.from({ length: 20 }, (_, i) => `CL-${String(i + 1).padStart(6, "0")}`));
  });

  it("disable then re-enable continues the sequence (never reuses a number)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    expect((await newCustomer()).barcode).toBe("CL-000001");
    await setSwitch(false);
    expect((await newCustomer()).barcode).toBeNull();
    await setSwitch(true);
    expect((await newCustomer()).barcode).toBe("CL-000002");
  });

  it("skips numbers already used by a product SKU, a variation SKU or a product barcode (any case)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    // Pre-existing identifiers (e.g. imported from a store) written directly.
    const p1 = await prisma.product.create({ data: { name: "P1", sku: "CL-000001", price: 1, status: "ACTIF" } });
    const parent = await prisma.product.create({ data: { name: "P2", sku: "PARENT-2", price: 1, status: "ACTIF" } });
    await prisma.productVariation.create({ data: { productId: parent.id, sku: "cl-000002", price: 1, attributes: {} } });
    const p3 = await prisma.product.create({ data: { name: "P3", sku: "P3", price: 1, status: "ACTIF" } });
    await prisma.barcode.create({ data: { code: "CL-000003", productId: p3.id } });
    expect((await newCustomer()).barcode).toBe("CL-000004");
    expect(p1.sku).toBe("CL-000001"); // merchant data untouched
  });

  it("never accepts a code from the caller", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const { customer } = await findOrCreateCustomer({ fullName: "Forgé", phone: "0611111111", barcode: "CL-999999" } as never);
    expect(customer.barcode).toBe("CL-000001");
  });
});

describe("stability", () => {
  it("a reused customer (same name + phone) keeps its code; no new number is consumed", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const first = await createCustomerAction(fd({ fullName: "Amine Tazi", phone: "0612345678" }));
    const again = await createCustomerAction(fd({ fullName: "Amine Tazi", phone: "+212 6 12 34 56 78" }));
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) {
      expect(again.data.reused).toBe(true);
      expect(again.data.id).toBe(first.data.id);
      expect(again.data.barcode).toBe("CL-000001");
    }
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).nextCustomerBarcodeNumber).toBe(2);
  });

  it("WooCommerce / Shopify re-imports (same customer through findOrCreateCustomer) keep the original code", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const woo1 = await findOrCreateCustomer({ fullName: "Sara Idrissi", phone: "0622222222", source: "WOOCOMMERCE", externalId: "wc-7" });
    const woo2 = await findOrCreateCustomer({ fullName: "Sara Idrissi", phone: "0622222222", source: "WOOCOMMERCE", externalId: "wc-7" });
    const shop = await findOrCreateCustomer({ fullName: "Sara Idrissi", phone: "0622222222", source: "SHOPIFY", externalId: "sh-9" });
    expect(woo1.customer.barcode).toBe("CL-000001");
    expect(woo2.reused && shop.reused).toBe(true);
    expect([woo2.customer.barcode, shop.customer.barcode]).toEqual(["CL-000001", "CL-000001"]);
  });

  it("editing a customer never sets, replaces or clears the code", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const c = await newCustomer("Edit");
    const r = await updateCustomerAction(fd({ id: c.id, fullName: "Edit Renamed", phone: "0633333333", country: "Maroc", barcode: "CL-424242" }));
    expect(r.ok).toBe(true);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).barcode).toBe(c.barcode);
  });
});

describe("tenant isolation", () => {
  it("two tenants both start at CL-000001; lookups never cross tenants", async () => {
    await prismaBase.tenant.create({ data: { id: TENANT_B, name: "B", slug: TENANT_B } });
    await setTestBusinessMode("ONLINE_AND_OFFLINE", TENANT_B);
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const a = await newCustomer("A");
    await loginAsTestUser({ role: "OWNER", tenantId: TENANT_B });
    await enable(TENANT_B);
    const b = await newCustomer("B");
    expect([a.barcode, b.barcode]).toEqual(["CL-000001", "CL-000001"]);

    // In tenant B, the code resolves to B's customer only.
    const found = await findSaleCustomerByCodeAction("CL-000001");
    expect(found.ok && found.data.customer?.id).toBe(b.id);
    const listed = await listCustomers({ q: "CL-000001" });
    expect(listed.customers.map((c) => c.id)).toEqual([b.id]);
  });
});

describe("search and customer pickers", () => {
  it("global search, order-form search and the customer list find a customer by exact code (scanner-normalised)", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const c = await newCustomer("Trouvable");
    const order = await searchCustomersForOrderAction("cl-000001");
    expect(order.map((r) => r.id)).toContain(c.id);
    const quick = await quickSearchAction("CL)ààààà&");
    expect(JSON.stringify(quick)).toContain(c.id);
    expect((await listCustomers({ q: "CL-000001" })).customers.map((r) => r.id)).toEqual([c.id]);
  });

  it("the in-store sale picker selects by code, reports a layout mismatch, and finds nothing for an unknown code", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    const sale = await createSaleCustomerAction({ fullName: "Client Magasin", phone: "0644444444" });
    expect(sale.ok).toBe(true);
    const exact = await findSaleCustomerByCodeAction("CL-000001");
    expect(exact.ok && exact.data.customer?.fullName).toBe("Client Magasin");
    const swapped = await findSaleCustomerByCodeAction("CL)ààààà&");
    expect(swapped.ok && swapped.data.layoutMismatch).toBe(true);
    expect(swapped.ok && swapped.data.customer?.fullName).toBe("Client Magasin");
    const unknown = await findSaleCustomerByCodeAction("CL-000999");
    expect(unknown.ok && unknown.data.customer).toBeNull();
  });
});

describe("no reservation of product identifiers (docs/adr/0061 removed it)", () => {
  it("a product SKU or barcode of the form « CL-<digits> » is accepted; customer codes simply skip it", async () => {
    await setTestBusinessMode("ONLINE_AND_OFFLINE");
    await loginAsTestUser({ role: "OWNER" });
    const created = await createProductAction(fd({ name: "Produit CL", sku: "CL-000001", price: "10", barcode: "CL-000002" }));
    expect(created.ok).toBe(true);
    const product = await prisma.product.create({ data: { name: "P", sku: "OK-2", price: 1, status: "ACTIF" } });
    expect((await addBarcodeAction({ productId: product.id, code: "cl-5" })).ok).toBe(true);
    await enable();
    expect((await newCustomer()).barcode).toBe("CL-000003");
  });
});

describe("backup / restore", () => {
  it("codes survive a restore and the counter is moved past them", async () => {
    await loginAsTestUser({ role: "OWNER" });
    await enable();
    await newCustomer();
    await newCustomer();
    await newCustomer(); // CL-000003
    const backup = await buildTenantBackup({ tenantId: DEFAULT_TENANT_ID, createdByUserId: null });
    // Simulate a tenant whose counter was behind (e.g. restored onto a reset counter).
    await prismaBase.tenant.update({ where: { id: DEFAULT_TENANT_ID }, data: { nextCustomerBarcodeNumber: 1 } });

    await restoreTenantBackup({ activeTenantId: DEFAULT_TENANT_ID, inspected: inspectBackup(backup.container) });

    const codes = await runWithTenant(DEFAULT_TENANT_ID, "test", async () =>
      (await prisma.customer.findMany({ orderBy: { barcode: "asc" }, select: { barcode: true } })).map((c) => c.barcode)
    );
    expect(codes).toEqual(["CL-000001", "CL-000002", "CL-000003"]);
    expect((await prismaBase.tenant.findUniqueOrThrow({ where: { id: DEFAULT_TENANT_ID } })).nextCustomerBarcodeNumber).toBe(4);
    expect((await newCustomer()).barcode).toBe("CL-000004");
  });
});
