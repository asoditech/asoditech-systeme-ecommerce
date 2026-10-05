import "server-only";

import type { Customer, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveActiveTenantIdForRawSql } from "@/lib/tenant/resolve";
import { customerNameKey, customerPhoneKey } from "./identity";

/**
 * The ONE way a customer is found or created from a name + phone
 * (manual form, order form, offline sale, WooCommerce/Shopify import).
 *
 * Identity = normalized name + normalized phone (see ./identity.ts):
 *   same name + same phone → the existing customer is reused, untouched;
 *   anything else (other name, other phone, no/invalid phone, placeholder
 *   name) → a new customer.
 *
 * A per-(tenant, phoneKey) advisory lock makes two concurrent requests for
 * the same person (a double-click, two webhooks) resolve to one row. When
 * historical duplicates already exist, the oldest one is reused.
 */
export type FindOrCreateCustomerInput = Omit<Prisma.CustomerUncheckedCreateInput, "phoneKey" | "tenantId"> & {
  fullName: string;
  phone?: string | null;
};

export async function findOrCreateCustomer(
  input: FindOrCreateCustomerInput
): Promise<{ customer: Customer; reused: boolean }> {
  const phoneKey = customerPhoneKey(input.phone);
  const nameKey = customerNameKey(input.fullName);

  if (!phoneKey || !nameKey) {
    const customer = await prisma.customer.create({ data: { ...input, phoneKey } });
    return { customer, reused: false };
  }

  const tenantId = await resolveActiveTenantIdForRawSql("findOrCreateCustomer");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${tenantId}:${phoneKey}`}))`;
    const candidates = await tx.customer.findMany({
      where: { phoneKey },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const match = candidates.find((c) => customerNameKey(c.fullName) === nameKey);
    if (match) return { customer: match, reused: true };
    const customer = await tx.customer.create({ data: { ...input, phoneKey } });
    return { customer, reused: false };
  });
}
