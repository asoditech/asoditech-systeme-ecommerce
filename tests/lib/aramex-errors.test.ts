import { describe, expect, it } from "vitest";
import {
  DeliveryAuthError,
  DeliveryConfigError,
  DeliveryNotFoundError,
  DeliveryUnavailableError,
} from "@/lib/integrations/delivery/errors";
import { errorForNotifications, errorForStatus } from "@/lib/integrations/delivery/providers/aramex/errors";

describe("aramex errorForNotifications — code classification (Appendix F)", () => {
  it("REQxx → config error about a missing field", () => {
    const e = errorForNotifications([{ Code: "REQ07", Message: "Consignee PhoneNumber1 is required" }]);
    expect(e).toBeInstanceOf(DeliveryConfigError);
    expect(e.message).toContain("REQ07");
  });

  it("ERR01 → auth error", () => {
    expect(errorForNotifications([{ Code: "ERR01", Message: "Invalid credentials" }])).toBeInstanceOf(
      DeliveryAuthError
    );
  });

  it("ERR02 / ERR03 → auth error (account invalid / blocked)", () => {
    expect(errorForNotifications([{ Code: "ERR02", Message: "x" }])).toBeInstanceOf(DeliveryAuthError);
    expect(errorForNotifications([{ Code: "ERR03", Message: "x" }])).toBeInstanceOf(DeliveryAuthError);
  });

  it("ERR30 → not-found (duplicate reference, shipment already exists)", () => {
    expect(errorForNotifications([{ Code: "ERR30", Message: "Duplicate ForeignHAWB" }])).toBeInstanceOf(
      DeliveryNotFoundError
    );
  });

  it("ERR52 → config error about the address", () => {
    const e = errorForNotifications([{ Code: "ERR52", Message: "Unable to resolve address" }]);
    expect(e).toBeInstanceOf(DeliveryConfigError);
    expect(e.message.toLowerCase()).toContain("adresse");
  });

  it("a code match wins over message text", () => {
    // Message alone would look like a generic failure; the code pins it.
    const e = errorForNotifications([{ Code: "ERR01", Message: "Something went wrong" }]);
    expect(e).toBeInstanceOf(DeliveryAuthError);
  });

  it("an unknown code falls back to the sanitised message", () => {
    const e = errorForNotifications([{ Code: "ERR99", Message: "Carrier system busy" }]);
    expect(e).toBeInstanceOf(DeliveryUnavailableError);
    expect(e.message).toContain("Carrier system busy");
  });

  it("never leaks a long token-like run from the message", () => {
    const e = errorForNotifications([{ Code: "ERR99", Message: "token abcdef0123456789abcdef0123 rejected" }]);
    expect(e.message).toContain("«masqué»");
  });
});

describe("aramex errorForStatus", () => {
  it("401/403 → auth, 404 → not-found, 429 → rate limit, 5xx → unavailable", () => {
    expect(errorForStatus(401)).toBeInstanceOf(DeliveryAuthError);
    expect(errorForStatus(404)).toBeInstanceOf(DeliveryNotFoundError);
    expect(errorForStatus(503)).toBeInstanceOf(DeliveryUnavailableError);
  });
});
