import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createCustomerAction,
  updateCustomerAction,
  createCustomerAddressAction,
  deleteCustomerAddressAction,
  setCustomerBlacklistAction,
} from "@/actions/customers";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("createCustomerAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects an unauthenticated caller", async () => {
    await expect(createCustomerAction(formData({ fullName: "Amine" }))).rejects.toThrow(/non autorisé/i);
  });

  it("rejects a caller without customers.create permission", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    await expect(createCustomerAction(formData({ fullName: "Amine" }))).rejects.toThrow(/non autorisé/i);
  });

  it("creates a customer and records who created it", async () => {
    const user = await loginAsTestUser({ role: "SALES" });
    const result = await createCustomerAction(formData({ fullName: "Amine Tazi", phone: "0612345678" }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fullName).toBe("Amine Tazi");
      expect(result.data.createdById).toBe(user.id);
    }

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "customer.created" } });
    expect(audit.actorUserId).toBe(user.id);
  });

  it("treats blank optional fields as null, not empty strings", async () => {
    await loginAsTestUser({ role: "SALES" });
    const result = await createCustomerAction(formData({ fullName: "Amine", email: "", phone: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.email).toBeNull();
      expect(result.data.phone).toBeNull();
    }
  });

  it("rejects a missing full name with a field-level error", async () => {
    await loginAsTestUser({ role: "SALES" });
    const result = await createCustomerAction(formData({ fullName: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.fullName).toBeTruthy();
    }
  });
});

describe("updateCustomerAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("allows setting a manual customer segment", async () => {
    await loginAsTestUser({ role: "SALES" });
    const created = await createCustomerAction(formData({ fullName: "Amine" }));
    if (!created.ok) throw new Error("setup failed");

    const result = await updateCustomerAction(
      formData({ id: created.data.id, fullName: "Amine", segment: "VIP" })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.segment).toBe("VIP");
  });

  it("returns an error for a non-existent customer instead of throwing", async () => {
    await loginAsTestUser({ role: "SALES" });
    const result = await updateCustomerAction(formData({ id: "does-not-exist", fullName: "X" }));
    expect(result.ok).toBe(false);
  });
});

describe("deleteCustomerAddressAction — IDOR protection (audit fix)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("refuses to delete an address that belongs to a different customer than claimed", async () => {
    await loginAsTestUser({ role: "SALES" });
    const ownerCustomer = await createCustomerAction(formData({ fullName: "Client A" }));
    const otherCustomer = await createCustomerAction(formData({ fullName: "Client B" }));
    if (!ownerCustomer.ok || !otherCustomer.ok) throw new Error("setup failed");

    const address = await createCustomerAddressAction(
      formData({ customerId: ownerCustomer.data.id, addressLine1: "12 Rue Atlas", city: "Casablanca" })
    );
    if (!address.ok) throw new Error("setup failed");

    // Claim the address belongs to a different customer than it actually does.
    const result = await deleteCustomerAddressAction(
      formData({ id: address.data.id, customerId: otherCustomer.data.id })
    );
    expect(result.ok).toBe(false);

    const stillExists = await prisma.customerAddress.findUnique({ where: { id: address.data.id } });
    expect(stillExists).not.toBeNull();
  });

  it("deletes an address when the customerId matches its real owner", async () => {
    await loginAsTestUser({ role: "SALES" });
    const customer = await createCustomerAction(formData({ fullName: "Client A" }));
    if (!customer.ok) throw new Error("setup failed");
    const address = await createCustomerAddressAction(
      formData({ customerId: customer.data.id, addressLine1: "12 Rue Atlas", city: "Casablanca" })
    );
    if (!address.ok) throw new Error("setup failed");

    const result = await deleteCustomerAddressAction(
      formData({ id: address.data.id, customerId: customer.data.id })
    );
    expect(result.ok).toBe(true);

    const gone = await prisma.customerAddress.findUnique({ where: { id: address.data.id } });
    expect(gone).toBeNull();
  });
});

describe("createCustomerAddressAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects an address for a non-existent customer instead of throwing", async () => {
    await loginAsTestUser({ role: "SALES" });
    const result = await createCustomerAddressAction(
      formData({ customerId: "does-not-exist", addressLine1: "12 Rue Atlas", city: "Casablanca" })
    );
    expect(result.ok).toBe(false);
  });

  it("only one address is marked default at a time", async () => {
    await loginAsTestUser({ role: "SALES" });
    const customer = await createCustomerAction(formData({ fullName: "Client A" }));
    if (!customer.ok) throw new Error("setup failed");

    await createCustomerAddressAction(
      formData({ customerId: customer.data.id, addressLine1: "Adresse 1", city: "Casablanca", isDefault: "on" })
    );
    await createCustomerAddressAction(
      formData({ customerId: customer.data.id, addressLine1: "Adresse 2", city: "Rabat", isDefault: "on" })
    );

    const addresses = await prisma.customerAddress.findMany({ where: { customerId: customer.data.id } });
    expect(addresses.filter((a) => a.isDefault)).toHaveLength(1);
    expect(addresses.find((a) => a.isDefault)?.addressLine1).toBe("Adresse 2");
  });
});

describe("setCustomerBlacklistAction", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a caller without customers.edit permission", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    await expect(
      setCustomerBlacklistAction(formData({ id: customer.id, blacklisted: "true" }))
    ).rejects.toThrow(/non autorisé/i);
  });

  it("blacklists a customer with a reason, and records who did it and why", async () => {
    const user = await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });

    const result = await setCustomerBlacklistAction(
      formData({ id: customer.id, blacklisted: "true", reason: "3 commandes annulées" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isBlacklisted).toBe(true);
    expect(result.data.blacklistReason).toBe("3 commandes annulées");
    expect(result.data.blacklistedAt).not.toBeNull();

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "customer.blacklisted" } });
    expect(audit.actorUserId).toBe(user.id);
    expect(audit.metadata).toMatchObject({ reason: "3 commandes annulées" });
  });

  it("removing the flag clears the reason and timestamp too", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const customer = await prisma.customer.create({
      data: { fullName: "Client", isBlacklisted: true, blacklistedAt: new Date(), blacklistReason: "x" },
    });

    const result = await setCustomerBlacklistAction(formData({ id: customer.id, blacklisted: "false" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.isBlacklisted).toBe(false);
    expect(result.data.blacklistReason).toBeNull();
    expect(result.data.blacklistedAt).toBeNull();

    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "customer.unblacklisted" } });
    expect(audit).toBeTruthy();
  });

  it("rejects a non-existent customer", async () => {
    await loginAsTestUser({ role: "MANAGER" });
    const result = await setCustomerBlacklistAction(formData({ id: "does-not-exist", blacklisted: "true" }));
    expect(result.ok).toBe(false);
  });
});
