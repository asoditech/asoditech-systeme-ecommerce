import "server-only";

import type { Customer, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveActiveTenantIdForRawSql } from "@/lib/tenant/resolve";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { customerNameKey, customerPhoneKey } from "./identity";
import {
  allocateCustomerBarcode,
  CustomerBarcodeAllocationError,
  isCustomerBarcodeGranted,
  isCustomerBarcodeSwitchOn,
} from "./barcode-allocation";

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
export type FindOrCreateCustomerInput = Omit<Prisma.CustomerUncheckedCreateInput, "phoneKey" | "tenantId" | "barcode"> & {
  fullName: string;
  phone?: string | null;
};

/** A `barcode` unique clash at insert time (only possible if a code appeared
 * outside the counter, e.g. a concurrent restore) — the whole attempt is
 * retried, a bounded number of times. */
const MAX_INSERT_ATTEMPTS = 3;

/**
 * Automatic customer code (docs/adr/0060): assigned ONLY when a customer is
 * created here — never when one is reused (store re-imports and repeated
 * name + phone keep their code), never from the caller's input (a `barcode`
 * key is dropped), and only while the platform grant AND the tenant switch
 * are both on (./barcode-allocation.ts).
 */
export async function findOrCreateCustomer(
  input: FindOrCreateCustomerInput
): Promise<{ customer: Customer; reused: boolean }> {
  // Never trust a caller-supplied code, whatever its static type says.
  const { barcode: _ignoredBarcode, ...data } = input as FindOrCreateCustomerInput & { barcode?: unknown };
  void _ignoredBarcode;
  const phoneKey = customerPhoneKey(data.phone);
  const nameKey = customerNameKey(data.fullName);
  const switchOn = await isCustomerBarcodeSwitchOn();

  if ((!phoneKey || !nameKey) && !switchOn) {
    const customer = await prisma.customer.create({ data: { ...data, phoneKey } });
    return { customer, reused: false };
  }

  const tenantId = await resolveActiveTenantIdForRawSql("findOrCreateCustomer");
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        if (phoneKey && nameKey) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer:${tenantId}:${phoneKey}`}))`;
          const candidates = await tx.customer.findMany({
            where: { phoneKey },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          const match = candidates.find((c) => customerNameKey(c.fullName) === nameKey);
          if (match) return { customer: match, reused: true };
        }
        const barcode = switchOn && (await isCustomerBarcodeGranted(tx, tenantId)) ? await allocateCustomerBarcode(tx, tenantId) : null;
        const customer = await tx.customer.create({ data: { ...data, phoneKey, ...(barcode ? { barcode } : {}) } });
        return { customer, reused: false };
      });
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < MAX_INSERT_ATTEMPTS) continue;
      if (isUniqueConstraintError(error)) throw new CustomerBarcodeAllocationError();
      throw error;
    }
  }
}
