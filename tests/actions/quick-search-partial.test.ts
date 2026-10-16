import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { quickSearchAction } from "@/actions/search";
import { customerPhoneKey } from "@/lib/customers/identity";
import { DEFAULT_TENANT_ID, resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";

/**
 * ⌘K partial matching: the beginning of a visible order number, a
 * formatted / partial phone (normalized phoneKey) and the beginning of a
 * customer code — never another tenant's rows, at most 5 per group.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant-b-quick-partial";
let seq = 910_000;

async function order(tenantId: string, displayNumber: number | null, opts: { orderNumber?: number; placedMinutesAgo?: number } = {}) {
  const customer = await prismaBase.customer.create({ data: { tenantId, fullName: `Client ${tenantId} ${displayNumber}` } });
  return prismaBase.order.create({
    data: {
      tenantId,
      customerId: customer.id,
      subtotal: 100,
      total: 100,
      orderNumber: opts.orderNumber ?? ++seq,
      displayNumber,
      placedAt: new Date(Date.now() - (opts.placedMinutesAgo ?? 0) * 60_000),
    },
  });
}

async function customer(tenantId: string, fullName: string, phone: string | null, barcode: string | null = null) {
  return prismaBase.customer.create({ data: { tenantId, fullName, phone, phoneKey: phone ? customerPhoneKey(phone) : null, barcode } });
}

const hits = async (q: string, type: string) => (await quickSearchAction(q)).filter((r) => r.type === type).map((r) => r.id);

beforeEach(async () => {
  await resetDb();
  await prismaBase.tenant.create({ data: { id: B, name: "Client B", slug: B } });
});
afterEach(async () => {
  await resetDb();
});

describe("⌘K — partial order number", () => {
  it("« 14 » / « CMD-00014 » find 14, 140, 1401 (exact first), never 41 or another tenant's 140", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const o14 = await order(A, 14, { placedMinutesAgo: 100 });
    const o140 = await order(A, 140, { placedMinutesAgo: 1 });
    const o1401 = await order(A, 1401, { placedMinutesAgo: 2 });
    const o41 = await order(A, 41);
    await order(B, 140);
    expect(await hits("14", "order")).toEqual([o14.id, o140.id, o1401.id]);
    // « CMD-00014 » is order 14 exactly (existing rule), then the padded
    // prefix « 00014x » = 140–149; 1401 (« 001401 ») is not a match.
    expect(await hits("CMD-00014", "order")).toEqual([o14.id, o140.id]);
    // « CMD-0000 » (a number being typed): the padded « 0000xx » = 1–99, newest first.
    expect(await hits("CMD-0000", "order")).toEqual([o41.id, o14.id]);
  });

  it("a legacy order without displayNumber is matched on the number it shows", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const legacy = await order(A, null, { orderNumber: 7_771 });
    await order(A, 9, { orderNumber: 7_772 }); // hidden global number 7772 never matches
    expect(await hits("777", "order")).toEqual([legacy.id]);
  });

  it("phones are not read as order-number prefixes; at most 5 orders", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    await order(A, 612345678);
    expect(await hits("0612345678", "order")).toEqual([]);
    for (let i = 0; i < 7; i++) await order(A, 50 + i);
    expect(await hits("5", "order")).toEqual([]); // under 2 characters: no search at all
    expect((await hits("CMD-00005", "order")).length).toBe(5);
  });
});

describe("⌘K — customers by partial phone and customer code", () => {
  it("formatted / international / partial phone finds the customer through phoneKey", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const sara = await customer(A, "Sara Amrani", "06 12 34 56 78");
    await customer(B, "Sara B", "06 12 34 56 78");
    for (const q of ["+212 612 34", "0612345678", "34 56 78"]) {
      expect(await hits(q, "customer"), q).toEqual([sara.id]);
    }
  });

  it("the beginning of a customer code (« CL-0000 », any case) finds it; another tenant's code never", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    const c1 = await customer(A, "Karim", null, "CL-000012");
    await customer(B, "Other", null, "CL-000013");
    expect(await hits("cl-00001", "customer")).toEqual([c1.id]);
    expect(await hits("CL-000012", "customer")).toEqual([c1.id]);
    expect(await hits("CL-000013", "customer")).toEqual([]);
  });

  it("at most 5 customers", async () => {
    await loginAsTestUser({ role: "ADMIN" });
    for (let i = 0; i < 7; i++) await customer(A, `Nadia ${i}`, null);
    expect(await hits("nadia", "customer")).toHaveLength(5);
  });
});
