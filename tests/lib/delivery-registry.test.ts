import { describe, expect, it, beforeEach } from "vitest";
import {
  registerDeliveryProvider,
  getDeliveryProvider,
  listDeliveryProviders,
  assertCapability,
  __resetDeliveryProviderRegistryForTests,
} from "@/lib/integrations/delivery/registry";
import { DeliveryUnsupportedCapabilityError } from "@/lib/integrations/delivery/errors";
import { referenceDeliveryProvider, REFERENCE_PROVIDER_KEY } from "../helpers/reference-delivery-provider";

describe("delivery provider registry", () => {
  beforeEach(() => {
    __resetDeliveryProviderRegistryForTests();
  });

  it("starts empty in a fresh process (no production adapter registered)", () => {
    expect(listDeliveryProviders()).toHaveLength(0);
    expect(getDeliveryProvider("anything")).toBeUndefined();
  });

  it("registers and retrieves an adapter by key", () => {
    registerDeliveryProvider(referenceDeliveryProvider);
    expect(getDeliveryProvider(REFERENCE_PROVIDER_KEY)).toBe(referenceDeliveryProvider);
    expect(listDeliveryProviders().map((p) => p.key)).toEqual([REFERENCE_PROVIDER_KEY]);
  });

  it("refuses to register the same key twice", () => {
    registerDeliveryProvider(referenceDeliveryProvider);
    expect(() => registerDeliveryProvider(referenceDeliveryProvider)).toThrow();
  });

  it("assertCapability passes for a declared capability", () => {
    expect(() => assertCapability(referenceDeliveryProvider, "CREATE_SHIPMENT")).not.toThrow();
  });

  it("assertCapability throws a typed error for an undeclared capability (never a silent fake success)", () => {
    const limitedAdapter = { ...referenceDeliveryProvider, capabilities: ["FETCH_STATUS"] as const };
    expect(() => assertCapability(limitedAdapter, "CREATE_SHIPMENT")).toThrow(DeliveryUnsupportedCapabilityError);
  });
});
