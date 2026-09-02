import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getConnectedCommercePlatforms, resolveExternalProductEditUrl } from "@/lib/integrations/shared/product-management-url";
import { resetDb } from "../helpers/db";

/**
 * Phase 28 — docs/adr/0017-product-management-boundary.md. Every URL here
 * must be built only from trusted Integration config + the product's own
 * externalId, never guessed. See src/lib/integrations/shared/
 * product-management-url.ts's own doc comment for the full rationale.
 */
describe("getConnectedCommercePlatforms", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("returns nothing when no integration is configured", async () => {
    expect(await getConnectedCommercePlatforms()).toEqual([]);
  });

  it("excludes a provider that is only CONFIGURE (saved, unverified) — not genuinely connected", async () => {
    await prisma.integration.create({
      data: { provider: "WOOCOMMERCE", status: "CONFIGURE", config: { siteUrl: "https://maboutique.com" } },
    });
    expect(await getConnectedCommercePlatforms()).toEqual([]);
  });

  it("includes a real create URL for a connected WooCommerce store", async () => {
    await prisma.integration.create({
      data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://maboutique.com" } },
    });
    const platforms = await getConnectedCommercePlatforms();
    expect(platforms).toEqual([
      { provider: "WOOCOMMERCE", label: "WooCommerce", createUrl: "https://maboutique.com/wp-admin/post-new.php?post_type=product" },
    ]);
  });

  it("includes a real create URL for a connected Shopify store", async () => {
    await prisma.integration.create({
      data: { provider: "SHOPIFY", status: "CONNECTE", config: { shopDomain: "https://mon-magasin.myshopify.com" } },
    });
    const platforms = await getConnectedCommercePlatforms();
    expect(platforms).toEqual([
      { provider: "SHOPIFY", label: "Shopify", createUrl: "https://mon-magasin.myshopify.com/admin/products/new" },
    ]);
  });

  it("offers both platforms, never guessing which one the operator means, when both are connected", async () => {
    await prisma.integration.create({
      data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://maboutique.com" } },
    });
    await prisma.integration.create({
      data: { provider: "SHOPIFY", status: "CONNECTE", config: { shopDomain: "https://mon-magasin.myshopify.com" } },
    });
    const platforms = await getConnectedCommercePlatforms();
    expect(platforms).toHaveLength(2);
    expect(platforms.map((p) => p.provider).sort()).toEqual(["SHOPIFY", "WOOCOMMERCE"]);
  });

  it("excludes a connected integration with no resolvable site config, rather than emitting a broken URL", async () => {
    await prisma.integration.create({ data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: {} } });
    expect(await getConnectedCommercePlatforms()).toEqual([]);
  });
});

describe("resolveExternalProductEditUrl", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("returns null for an internal product — nothing external to link to", async () => {
    expect(await resolveExternalProductEditUrl({ source: "INTERNE", externalId: null })).toBeNull();
  });

  it("returns null when externalId is missing, even for an external source", async () => {
    expect(await resolveExternalProductEditUrl({ source: "WOOCOMMERCE", externalId: null })).toBeNull();
  });

  it("builds the real WordPress admin edit URL from the numeric WooCommerce post id", async () => {
    await prisma.integration.create({
      data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: { siteUrl: "https://maboutique.com" } },
    });
    const url = await resolveExternalProductEditUrl({ source: "WOOCOMMERCE", externalId: "501" });
    expect(url).toBe("https://maboutique.com/wp-admin/post.php?post=501&action=edit");
  });

  it("builds the real Shopify admin edit URL from the trailing numeric segment of the product gid", async () => {
    await prisma.integration.create({
      data: { provider: "SHOPIFY", status: "CONNECTE", config: { shopDomain: "https://mon-magasin.myshopify.com" } },
    });
    const url = await resolveExternalProductEditUrl({ source: "SHOPIFY", externalId: "gid://shopify/Product/789456" });
    expect(url).toBe("https://mon-magasin.myshopify.com/admin/products/789456");
  });

  it("returns null — never a guessed URL — when the integration is disconnected", async () => {
    await prisma.integration.create({
      data: { provider: "WOOCOMMERCE", status: "ERREUR", config: { siteUrl: "https://maboutique.com" } },
    });
    expect(await resolveExternalProductEditUrl({ source: "WOOCOMMERCE", externalId: "501" })).toBeNull();
  });

  it("returns null when there is no integration row for the product's source at all", async () => {
    expect(await resolveExternalProductEditUrl({ source: "SHOPIFY", externalId: "gid://shopify/Product/1" })).toBeNull();
  });

  it("returns null when the stored config has no usable site identity", async () => {
    await prisma.integration.create({ data: { provider: "WOOCOMMERCE", status: "CONNECTE", config: {} } });
    expect(await resolveExternalProductEditUrl({ source: "WOOCOMMERCE", externalId: "501" })).toBeNull();
  });
});
