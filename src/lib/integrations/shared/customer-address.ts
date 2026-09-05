import "server-only";

import { prisma } from "@/lib/prisma";

export interface ImportedShippingAddress {
  addressLine1: string | null;
  addressLine2?: string | null;
  city: string | null;
  region?: string | null;
  country?: string | null;
  phone?: string | null;
}

/**
 * Upserts a `CustomerAddress` from an imported order's shipping snapshot —
 * without this, a WooCommerce/Shopify customer's page showed "Aucune
 * adresse enregistrée" even though every order they ever placed clearly
 * carried one (the address lived only on the Order row, never copied into
 * the customer's own address book). Never overwrites an existing address
 * — this app's address book is otherwise a manually curated list — only
 * adds a new entry when this exact line1+city isn't already on file for
 * the customer, and marks it default when it's their first recorded one.
 */
export async function upsertCustomerAddressFromOrder(
  customerId: string,
  address: ImportedShippingAddress
): Promise<void> {
  if (!address.addressLine1 || !address.city) return;

  const already = await prisma.customerAddress.findFirst({
    where: { customerId, addressLine1: address.addressLine1, city: address.city },
    select: { id: true },
  });
  if (already) return;

  const hasAny = await prisma.customerAddress.findFirst({ where: { customerId }, select: { id: true } });

  await prisma.customerAddress.create({
    data: {
      customerId,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2 ?? null,
      city: address.city,
      region: address.region ?? null,
      country: address.country?.trim() || "Maroc",
      phone: address.phone ?? null,
      isDefault: !hasAny,
    },
  });
}
