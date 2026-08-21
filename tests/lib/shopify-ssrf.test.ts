import { describe, expect, it } from "vitest";
import { validateShopDomain, InvalidShopDomainError } from "@/lib/integrations/shopify/ssrf";

describe("validateShopDomain", () => {
  it("expands a bare shop name to the full myshopify.com origin", async () => {
    const result = await validateShopDomain("mon-magasin");
    expect(result).toBe("https://mon-magasin.myshopify.com");
  });

  it("accepts a full myshopify.com domain without a scheme", async () => {
    const result = await validateShopDomain("mon-magasin.myshopify.com");
    expect(result).toBe("https://mon-magasin.myshopify.com");
  });

  it("accepts a full https:// URL", async () => {
    const result = await validateShopDomain("https://mon-magasin.myshopify.com");
    expect(result).toBe("https://mon-magasin.myshopify.com");
  });

  it("rejects a plain HTTP URL", async () => {
    await expect(validateShopDomain("http://mon-magasin.myshopify.com")).rejects.toThrow(InvalidShopDomainError);
  });

  it("rejects a URL carrying embedded credentials", async () => {
    await expect(validateShopDomain("https://user:pass@mon-magasin.myshopify.com")).rejects.toThrow(InvalidShopDomainError);
  });

  it("rejects a custom/connected domain that isn't *.myshopify.com", async () => {
    await expect(validateShopDomain("https://www.maboutique.com")).rejects.toThrow(InvalidShopDomainError);
    await expect(validateShopDomain("maboutique.com")).rejects.toThrow(InvalidShopDomainError);
  });

  it("rejects an empty value", async () => {
    await expect(validateShopDomain("")).rejects.toThrow(InvalidShopDomainError);
    await expect(validateShopDomain("   ")).rejects.toThrow(InvalidShopDomainError);
  });

  it("rejects a crafted subdomain that merely ends with .myshopify.com", async () => {
    // "internal.corp" is not a valid single-label Shopify shop name — the
    // shop-name regex (no dots) rejects it even though the raw string
    // technically ends with the required suffix.
    await expect(validateShopDomain("internal.corp.myshopify.com")).rejects.toThrow(InvalidShopDomainError);
  });

  it("rejects a shop name with invalid characters", async () => {
    await expect(validateShopDomain("mon magasin")).rejects.toThrow(InvalidShopDomainError);
    await expect(validateShopDomain("-leading-dash")).rejects.toThrow(InvalidShopDomainError);
  });
});
