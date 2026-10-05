/**
 * New order « Livraison & traitement » prefill from the selected customer.
 *
 * Only THIS order's fields are filled — they stay editable and are never
 * written back to the customer record. A field the operator typed by hand is
 * never overwritten: a field is (re)filled only when it is empty or still
 * holds exactly what the previous prefill put there (switching customer).
 */
export interface ShippingFields {
  address: string;
  city: string;
  phone: string;
}

type PrefillSource = {
  phone?: string | null;
  city?: string | null;
  addresses?: { addressLine1: string; city: string; phone: string | null }[];
  defaultAddress?: { addressLine1: string; city: string; phone: string | null } | null;
};

/** The customer's delivery values: the default saved address first, then the customer's own city/phone. */
export function customerShippingDefaults(customer: PrefillSource): ShippingFields {
  const address = customer.defaultAddress ?? customer.addresses?.[0] ?? null;
  return {
    address: address?.addressLine1?.trim() ?? "",
    city: (address?.city ?? customer.city ?? "").trim(),
    phone: (address?.phone ?? customer.phone ?? "").trim(),
  };
}

export function applyShippingPrefill(
  current: ShippingFields,
  lastPrefill: ShippingFields,
  defaults: ShippingFields
): ShippingFields {
  const pick = (key: keyof ShippingFields) => {
    const untouched = current[key] === "" || current[key] === lastPrefill[key];
    return untouched ? defaults[key] : current[key];
  };
  return { address: pick("address"), city: pick("city"), phone: pick("phone") };
}
