import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
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
