import { describe, expect, it } from "vitest";
import { DeliveryConfigError, DeliveryMalformedResponseError } from "@/lib/integrations/delivery/errors";
import {
  buildCreateShipmentPayload,
  buildTrackingUrl,
  mapAramexStatus,
  parseCalculateRateResponse,
  parseCreateShipmentResponse,
  parseTrackingResponse,
} from "@/lib/integrations/delivery/providers/aramex/mapper";
import { aramexConfigSchema } from "@/lib/integrations/delivery/providers/aramex/types";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

const config = aramexConfigSchema.parse({
  shipperName: "ASODITECH",
  shipperPhone: "0522000000",
  shipperLine1: "12 Rue de l'Industrie",
  shipperCity: "Casablanca",
  shipperCountryCode: "MA",
  productType: "OND",
});

const input: CreateShipmentAdapterInput = {
  localShipmentId: "ship_1",
  orderNumber: "1042",
  recipientName: "Amine Tazi",
  addressLine1: "12 rue Hassan II",
  addressLine2: "Appt 3",
  city: "Rabat",
  resolvedProviderCityId: null,
  region: null,
  country: "MA",
  phone: "0612345678",
  codAmount: 250,
  currency: "MAD",
  notes: "Livrer le matin",
  parcelContents: "1× Tablier",
};

interface TestPayload {
  Shipments: Array<{
    Shipper: { AccountNumber: string; PartyAddress: { City: string } };
    Consignee: {
      PartyAddress: { City: string; Line2: string };
      Contact: { PersonName: string };
    };
    Details: {
      ProductType: string;
      Services: string;
      CashOnDeliveryAmount: { Value: number; CurrencyCode: string };
      DescriptionOfGoods: string;
    };
    ForeignHAWB: string;
  }>;
}

describe("aramex mapper — buildCreateShipmentPayload", () => {
  it("builds a shipment with shipper, consignee and COD details", () => {
    const payload = buildCreateShipmentPayload({
      input,
      config,
      accountNumber: "20016",
      accountCountryCode: "MA",
    }) as unknown as TestPayload;

    const shipment = payload.Shipments[0];
    expect(shipment.Shipper.AccountNumber).toBe("20016");
    expect(shipment.Shipper.PartyAddress.City).toBe("Casablanca");
    expect(shipment.Consignee.PartyAddress.City).toBe("Rabat");
    expect(shipment.Consignee.PartyAddress.Line2).toBe("Appt 3");
    expect(shipment.Consignee.Contact.PersonName).toBe("Amine Tazi");
    expect(shipment.Details.ProductType).toBe("OND");
    expect(shipment.Details.Services).toBe("CODS");
    expect(shipment.Details.CashOnDeliveryAmount).toEqual({ Value: 250, CurrencyCode: "MAD" });
    expect(shipment.Details.DescriptionOfGoods).toBe("1× Tablier");
    expect(shipment.ForeignHAWB).toBe("ship_1");
  });

  it("omits COD service when there is no cash to collect", () => {
    const payload = buildCreateShipmentPayload({
      input: { ...input, codAmount: null },
      config,
      accountNumber: "20016",
      accountCountryCode: "MA",
    }) as unknown as TestPayload;
    expect(payload.Shipments[0].Details.Services).toBe("");
    expect(payload.Shipments[0].Details.CashOnDeliveryAmount.Value).toBe(0);
  });

  it("throws a typed config error when the shipper address is incomplete", () => {
    const partial = aramexConfigSchema.parse({ shipperName: "ASODITECH" });
    expect(() =>
      buildCreateShipmentPayload({ input, config: partial, accountNumber: "20016", accountCountryCode: "MA" })
    ).toThrow(DeliveryConfigError);
  });

  it("rejects a negative COD amount", () => {
    expect(() =>
      buildCreateShipmentPayload({
        input: { ...input, codAmount: -5 },
        config,
        accountNumber: "20016",
        accountCountryCode: "MA",
      })
    ).toThrow(DeliveryConfigError);
  });
});

describe("aramex mapper — response parsing", () => {
  it("extracts the AWB and a tracking URL from a CreateShipments response", () => {
    const parsed = parseCreateShipmentResponse(
      {
        HasErrors: false,
        Shipments: [{ ID: "44175881212", ShipmentNumber: "44175881212", HasErrors: false }],
      },
      config
    );
    expect(parsed.externalId).toBe("44175881212");
    expect(parsed.trackingNumber).toBe("44175881212");
    expect(parsed.trackingUrl).toContain("ShipmentNumber=44175881212");
  });

  it("throws when a per-shipment error is present", () => {
    expect(() =>
      parseCreateShipmentResponse(
        {
          HasErrors: false,
          Shipments: [{ HasErrors: true, Notifications: [{ Code: "ERR", Message: "Invalid product type" }] }],
        },
        config
      )
    ).toThrow(DeliveryMalformedResponseError);
  });

  it("reads the current status from the last tracking update (array form)", () => {
    const parsed = parseTrackingResponse(
      {
        HasErrors: false,
        TrackingResults: [
          {
            Key: "44175881212",
            Value: [
              { UpdateCode: "SH014", UpdateDescription: "Shipment picked up" },
              { UpdateCode: "SH006", UpdateDescription: "Delivered" },
            ],
          },
        ],
      },
      "44175881212",
      config
    );
    expect(parsed.rawStatus).toBe("Delivered");
    expect(parsed.trackingUrl).toContain("44175881212");
  });

  it("throws when the waybill is reported non-existing", () => {
    expect(() =>
      parseTrackingResponse(
        { HasErrors: false, NonExistingWaybills: ["44175881212"] },
        "44175881212",
        config
      )
    ).toThrow(DeliveryMalformedResponseError);
  });

  it("reads a total amount from CalculateRate, or null when absent", () => {
    expect(parseCalculateRateResponse({ TotalAmount: { Value: "35.50", CurrencyCode: "MAD" } })).toBe(35.5);
    expect(parseCalculateRateResponse({ HasErrors: false })).toBeNull();
  });
});

describe("aramex mapper — status vocabulary", () => {
  it("maps known descriptions and codes, and returns null for the unknown", () => {
    expect(mapAramexStatus("Delivered")).toBe("LIVRE");
    expect(mapAramexStatus("Out for delivery")).toBe("EN_TRANSIT");
    expect(mapAramexStatus("Returned to Shipper")).toBe("RETOURNE");
    expect(mapAramexStatus("SH006")).toBe("LIVRE");
    expect(mapAramexStatus("Some brand-new Aramex phrase")).toBeNull();
  });

  it("builds an https tracking URL", () => {
    expect(buildTrackingUrl("123", config)).toMatch(/^https:\/\//);
  });
});
