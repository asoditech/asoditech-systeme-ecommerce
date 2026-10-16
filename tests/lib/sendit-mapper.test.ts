import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertEnvelopeSuccess,
  buildCreateDeliveryBody,
  parseDeliveryDetail,
  parseDistricts,
  parseLabelsResponse,
  parseLoginResponse,
  parsePickupCities,
  parseStatusCatalogue,
  toDeliveryCities,
} from "@/lib/integrations/delivery/providers/sendit/mapper";
import {
  SENDIT_CREATE_BODY_KEYS,
  senditConfigSchema,
  senditCredentialsSchema,
} from "@/lib/integrations/delivery/providers/sendit/types";
import * as senditIndex from "@/lib/integrations/delivery/providers/sendit";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryMalformedResponseError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import type { CreateShipmentAdapterInput } from "@/lib/integrations/delivery/types";

const baseInput: CreateShipmentAdapterInput = {
  localShipmentId: "ship_local_1",
  orderNumber: "1042",
  recipientName: "  Amine Tazi ",
  addressLine1: "12 rue Hassan II",
  addressLine2: "Appt 4",
  city: "Casablanca",
  resolvedProviderCityId: "52",
  region: null,
  country: "MA",
  phone: " 0612345678 ",
  codAmount: 199,
  currency: "MAD",
  notes: "Appeler avant",
  parcelContents: "2× Tablier",
};

const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ success: true, message: "OK", data, ...extra });

describe("assertEnvelopeSuccess", () => {
  it("returns data on success", () => {
    expect(assertEnvelopeSuccess(ok({ a: 1 }))).toEqual({ a: 1 });
  });
  it("success=false → typed error with sanitized message", () => {
    const secret = "secretKEYvalue_abcdefghijklmnop";
    expect(() => assertEnvelopeSuccess({ success: false, message: `bad ${secret}`, data: null }, [secret])).toThrow(
      DeliveryUnavailableError
    );
    try {
      assertEnvelopeSuccess({ success: false, message: `bad ${secret}`, data: null }, [secret]);
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });
  it("non-envelope → malformed", () => {
    expect(() => assertEnvelopeSuccess("<html>")).toThrow(DeliveryMalformedResponseError);
    expect(() => assertEnvelopeSuccess({ data: {} })).toThrow(DeliveryMalformedResponseError);
    expect(() => assertEnvelopeSuccess(null)).toThrow(DeliveryMalformedResponseError);
  });
});

describe("buildCreateDeliveryBody", () => {
  const cfg = senditConfigSchema.parse({ pickupDistrictId: 46, allowOpen: 1, allowTry: 0 });

  it("uses only documented keys (exact set) and maps fields", () => {
    const body = buildCreateDeliveryBody(baseInput, cfg, "52", { amount: 199 });
    expect(Object.keys(body).sort()).toEqual(
      [
        "pickup_district_id",
        "district_id",
        "name",
        "amount",
        "address",
        "phone",
        "comment",
        "reference",
        "allow_open",
        "allow_try",
        "products_from_stock",
        "products",
      ].sort()
    );
    for (const k of Object.keys(body)) expect(SENDIT_CREATE_BODY_KEYS).toContain(k);
    expect(body).toEqual({
      pickup_district_id: 46,
      district_id: 52,
      name: "Amine Tazi",
      amount: 199,
      address: "12 rue Hassan II, Appt 4",
      phone: "0612345678",
      comment: "Appeler avant",
      reference: "1042",
      allow_open: 1,
      allow_try: 0,
      products_from_stock: 0,
      products: "2× Tablier",
    });
  });

  it("never includes undefined; omits unconfigured optional keys", () => {
    const body = buildCreateDeliveryBody(
      { ...baseInput, addressLine2: null, notes: "  ", parcelContents: null, phone: null },
      {},
      52,
      { amount: 0 }
    );
    expect(Object.values(body)).not.toContain(undefined);
    expect(Object.keys(body).sort()).toEqual(
      ["district_id", "name", "amount", "address", "phone", "comment", "reference", "products_from_stock", "products"].sort()
    );
    expect(body.comment).toBeNull();
    expect(body.products).toBe("");
    expect(body.phone).toBe("");
    expect(body.address).toBe("12 rue Hassan II");
    expect(body).not.toHaveProperty("packaging_id");
  });

  it("amount comes from the caller, never from codAmount", () => {
    expect(buildCreateDeliveryBody(baseInput, {}, 52, { amount: 50 }).amount).toBe(50);
  });

  it("adds exchange fields only when provided", () => {
    const body = buildCreateDeliveryBody(baseInput, {}, 52, { amount: 1, deliveryExchangeId: "DX123" });
    expect(body.option_exchange).toBe(1);
    expect(body.delivery_exchange_id).toBe("DX123");
  });

  it("rejects invalid district ids and amounts", () => {
    for (const bad of ["", "abc", "0", -1, 1.5, "12a"]) {
      expect(() => buildCreateDeliveryBody(baseInput, {}, bad as string, { amount: 1 })).toThrow(DeliveryConfigError);
    }
    for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => buildCreateDeliveryBody(baseInput, {}, 52, { amount })).toThrow(DeliveryConfigError);
    }
  });

  it("config schema accepts only 0|1 flags", () => {
    expect(senditConfigSchema.safeParse({ allowOpen: 2 }).success).toBe(false);
    expect(senditConfigSchema.safeParse({ allowTry: true }).success).toBe(false);
    expect(senditConfigSchema.safeParse({ pickupDistrictId: 1.5 }).success).toBe(false);
  });

  it("credentials schema requires both keys", () => {
    expect(senditCredentialsSchema.safeParse({ publicKey: "a", secretKey: "b" }).success).toBe(true);
    expect(senditCredentialsSchema.safeParse({ publicKey: "a", secretKey: " " }).success).toBe(false);
  });
});

describe("parseDeliveryDetail", () => {
  it("parses the documented fields", () => {
    const d = parseDeliveryDetail(
      ok({
        code: "DH12345",
        status: "PENDING",
        fee: "35.5",
        status_return: null,
        labelUrl: "https://app.sendit.ma/signed-files/label?sig=1",
        last_action_at: "2026-10-01 10:20:30",
        district: { id: 52, name: "Rabat" },
        products: [{ reference: "P1", code: "C", name: "X", quantity: 1 }],
      })
    );
    expect(d).toEqual({
      code: "DH12345",
      status: "PENDING",
      statusReturn: null,
      fee: 35.5,
      labelUrl: "https://app.sendit.ma/signed-files/label?sig=1",
      lastActionAt: "2026-10-01 10:20:30",
    });
  });

  it("missing code → malformed (never fabricated)", () => {
    expect(() => parseDeliveryDetail(ok({ status: "PENDING" }))).toThrow(DeliveryMalformedResponseError);
    expect(() => parseDeliveryDetail(ok({ code: "  " }))).toThrow(DeliveryMalformedResponseError);
    expect(() => parseDeliveryDetail(ok(null))).toThrow(DeliveryMalformedResponseError);
  });

  it("non-https label URL is dropped", () => {
    expect(parseDeliveryDetail(ok({ code: "D1", labelUrl: "http://x/y" })).labelUrl).toBeNull();
    expect(parseDeliveryDetail(ok({ code: "D1", labelUrl: "javascript:alert(1)" })).labelUrl).toBeNull();
    expect(parseDeliveryDetail(ok({ code: "D1", labelUrl: "http://app.sendit.ma/l.pdf" })).labelUrl).toBeNull();
  });

  it("an https label URL off app.sendit.ma (spec host) is dropped", () => {
    for (const labelUrl of [
      "https://evil.example/l.pdf",
      "https://app.sendit.ma.evil.example/l.pdf",
      "https://user:pw@app.sendit.ma/l.pdf",
      "https://app.sendit.ma:8443/l.pdf",
    ]) {
      expect(parseDeliveryDetail(ok({ code: "D1", labelUrl })).labelUrl).toBeNull();
    }
  });

  it("keeps return status", () => {
    expect(parseDeliveryDetail(ok({ code: "D1", status: "CANCELED", status_return: "RETURN_STOCK" })).statusReturn).toBe(
      "RETURN_STOCK"
    );
  });
});

describe("parseLabelsResponse", () => {
  it("returns an https fileUrl", () => {
    const u = "https://app.sendit.ma/signed-files/cGRm?expires=1790000000&signature=x";
    expect(parseLabelsResponse(ok({ filePrint: true, fileUrl: u }))).toBe(u);
  });
  it("rejects an https fileUrl on another host", () => {
    expect(() => parseLabelsResponse(ok({ filePrint: true, fileUrl: "https://s.example/f.pdf" }))).toThrow(
      DeliveryMalformedResponseError
    );
  });
  it("rejects http / missing", () => {
    expect(() => parseLabelsResponse(ok({ filePrint: true, fileUrl: "http://s.example/f.pdf" }))).toThrow(
      DeliveryMalformedResponseError
    );
    expect(() => parseLabelsResponse(ok({ filePrint: false }))).toThrow(DeliveryMalformedResponseError);
  });
});

describe("parseDistricts / parsePickupCities", () => {
  it("parses string and numeric ids, prices, pagination", () => {
    const { districts, pagination } = parseDistricts(
      ok(
        [
          { id: "52", ville: "Rabat", name: "Rabat", arabic_name: "الرباط", price: "30", delais: "24h", pickup_district: 46 },
          { id: 7, ville: "Casablanca", name: "Maarif", price: 20 },
          { ville: "NoId" },
          { id: "9" },
        ],
        { total: 2, per_page: "50", current_page: 1, last_page: 1, next_page_url: null, prev_page_url: null }
      )
    );
    expect(districts).toEqual([
      { id: "52", name: "Rabat", ville: "Rabat", arabicName: "الرباط", price: 30, delais: "24h" },
      { id: "7", name: "Maarif", ville: "Casablanca", arabicName: null, price: 20, delais: null },
    ]);
    expect(pagination).toEqual({ total: 2, perPage: 50, currentPage: 1, lastPage: 1, hasNextPage: false });
    expect(toDeliveryCities(districts)).toEqual([
      { id: "52", name: "Rabat", region: null },
      { id: "7", name: "Maarif", region: "Casablanca" },
    ]);
  });

  it("non-array data → malformed", () => {
    expect(() => parseDistricts(ok({}))).toThrow(DeliveryMalformedResponseError);
  });

  it("pickup cities", () => {
    expect(parsePickupCities(ok([{ id: 46, name: "Casablanca", arabic_name: "الدار البيضاء" }, { id: 1 }]))).toEqual([
      { id: "46", name: "Casablanca", arabicName: "الدار البيضاء" },
    ]);
  });
});

describe("parseLoginResponse", () => {
  it("returns the token", () => {
    expect(
      parseLoginResponse({ success: true, message: "Connexion effectuée avec succès.", data: { token: "tok123", name: "a@b.c" } })
    ).toBe("tok123");
  });
  it("success=false → auth error", () => {
    expect(() => parseLoginResponse({ success: false, message: "x", data: null })).toThrow(DeliveryAuthError);
  });
  it("missing token → malformed, no token in message", () => {
    expect(() => parseLoginResponse(ok({ name: "a@b.c" }))).toThrow(DeliveryMalformedResponseError);
  });
});

describe("status catalogue", () => {
  it("parses the map", () => {
    expect(parseStatusCatalogue(ok({ PENDING: "En attente", DELIVERED: "Livré" }))).toEqual({
      PENDING: "En attente",
      DELIVERED: "Livré",
    });
  });
});

describe("module guarantees", () => {
  // Updated 2026-10-16: Sendit now has a client + adapter built from the
  // official spec (SENDIT_VERIFICATION changed accordingly). The pure
  // modules must still never touch the network — only client.ts may call
  // fetch (covered with stubbed fetch in sendit-client.test.ts).
  it("exports the verification flag and the remaining open questions", () => {
    expect(senditIndex.SENDIT_VERIFICATION).toBe("IMPLEMENTED_FROM_OFFICIAL_SPEC_NOT_LIVE_TESTED");
    expect(senditIndex.SENDIT_OPEN_QUESTIONS.length).toBeGreaterThanOrEqual(5);
  });

  it("only client.ts contains a fetch call", () => {
    const dir = join(process.cwd(), "src/lib/integrations/delivery/providers/sendit");
    for (const f of readdirSync(dir)) {
      if (f === "client.ts") continue;
      expect(readFileSync(join(dir, f), "utf8")).not.toMatch(/\bfetch\s*\(/);
    }
  });
});
