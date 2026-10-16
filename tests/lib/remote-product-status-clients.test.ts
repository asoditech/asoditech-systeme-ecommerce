import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient } from "@/lib/integrations/shopify/client";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import {
  ShopifyMalformedResponseError,
  ShopifyPermissionError,
  ShopifyThrottledError,
  ShopifyTimeoutError,
  ShopifyUnavailableError,
  ShopifyUserError,
} from "@/lib/integrations/shopify/errors";
import {
  WooCommerceMalformedResponseError,
  WooCommercePermissionError,
  WooCommerceRateLimitError,
  WooCommerceTimeoutError,
  WooCommerceUnavailableError,
} from "@/lib/integrations/woocommerce/errors";
import { checkShopifyProduct } from "@/lib/integrations/shopify/remote-deletion";

/**
 * The two status calls of the remote product lifecycle, against a mocked
 * fetch only (no store is ever contacted): reads may retry, the status
 * CHANGE is sent exactly once whatever happens.
 */

const shopify = () => new ShopifyClient("https://boutique.myshopify.com", "token");
const woo = () => new WooCommerceClient("https://boutique.example", { consumerKey: "ck", consumerSecret: "cs" });
const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
const wooProduct = (status: string) =>
  new Response(JSON.stringify({ id: 7, name: "P", slug: "p", type: "simple", status, sku: "P-1", price: "10", regular_price: "10", sale_price: "", description: "", categories: [], images: [], variations: [] }), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Shopify (Admin GraphQL 2026-07)", () => {
  it("getProductStatus: a deleted product is `null`, an existing one its status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gql({ product: null })));
    expect(await shopify().getProductStatus("gid://shopify/Product/1")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => gql({ product: { id: "gid://shopify/Product/1", status: "ARCHIVED" } })));
    expect(await shopify().getProductStatus("gid://shopify/Product/1")).toEqual({ id: "gid://shopify/Product/1", status: "ARCHIVED" });
  });

  it("setProductStatus sends productUpdate with the status only — never productDelete", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => gql({ productUpdate: { product: { id: "gid://shopify/Product/1", status: "ARCHIVED" }, userErrors: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await shopify().setProductStatus("gid://shopify/Product/1", "ARCHIVED")).toEqual({ id: "gid://shopify/Product/1", status: "ARCHIVED" });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.query).toContain("productUpdate(product: $product)");
    expect(body.query).not.toContain("productDelete");
    expect(body.variables).toEqual({ product: { id: "gid://shopify/Product/1", status: "ARCHIVED" } });
  });

  it.each([
    ["a 5xx", () => new Response("oops", { status: 502 }), ShopifyUnavailableError],
    ["a 429", () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }), ShopifyThrottledError],
    ["THROTTLED", () => new Response(JSON.stringify({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }), { status: 200 }), ShopifyThrottledError],
    ["a 403", () => new Response("{}", { status: 403 }), ShopifyPermissionError],
    ["an unreadable 2xx", () => new Response("<html>", { status: 200 }), ShopifyMalformedResponseError],
    ["userErrors", () => gql({ productUpdate: { product: null, userErrors: [{ field: ["id"], message: "Product does not exist" }] } }), ShopifyUserError],
  ])("setProductStatus: %s → one attempt only, typed error", async (_name, answer, ErrorType) => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    await expect(shopify().setProductStatus("gid://shopify/Product/1", "ARCHIVED")).rejects.toBeInstanceOf(ErrorType);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("setProductStatus: a network reset is not re-sent", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(shopify().setProductStatus("gid://shopify/Product/1", "ACTIVE")).rejects.toBeInstanceOf(ShopifyUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("setProductStatus: a timeout is reported as such, not re-sent", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(shopify().setProductStatus("gid://shopify/Product/1", "ARCHIVED")).rejects.toBeInstanceOf(ShopifyTimeoutError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checkShopifyProduct: null = deleted, a product = exists, any error or a malformed id = unknown", async () => {
    const id = "gid://shopify/Product/42";
    expect(await checkShopifyProduct({ getProductStatus: async () => null }, id)).toBe("deleted");
    expect(await checkShopifyProduct({ getProductStatus: async () => ({ id, status: "ARCHIVED" }) }, id)).toBe("exists");
    expect(await checkShopifyProduct({ getProductStatus: async () => ({ id, status: "DRAFT" }) }, id)).toBe("exists");
    expect(await checkShopifyProduct({ getProductStatus: async () => Promise.reject(new ShopifyThrottledError("x")) }, id)).toBe("unknown");
    expect(await checkShopifyProduct({ getProductStatus: async () => Promise.reject(new ShopifyPermissionError("x")) }, id)).toBe("unknown");
    expect(await checkShopifyProduct({ getProductStatus: async () => null }, "42")).toBe("unknown");
    expect(await checkShopifyProduct({ getProductStatus: async () => null }, "")).toBe("unknown");
    expect(await checkShopifyProduct(null, id)).toBe("unknown");
  });
});

describe("WooCommerce (REST v3)", () => {
  it("setProductStatus: PUT /products/{id} with the status only — never DELETE", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => wooProduct("draft"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await woo().setProductStatus(7, "draft");
    expect(result.status).toBe("draft");
    expect(fetchMock.mock.calls[0][0]).toBe("https://boutique.example/wp-json/wc/v3/products/7");
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ status: "draft" });
  });

  it.each([
    ["a 503", () => new Response("oops", { status: 503 }), WooCommerceUnavailableError],
    ["a 429", () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }), WooCommerceRateLimitError],
    ["a 403", () => new Response(JSON.stringify({ code: "woocommerce_rest_cannot_edit" }), { status: 403 }), WooCommercePermissionError],
    ["an unreadable 2xx", () => new Response("<html>", { status: 200 }), WooCommerceMalformedResponseError],
  ])("setProductStatus: %s → one attempt only, typed error", async (_name, answer, ErrorType) => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal("fetch", fetchMock);
    await expect(woo().setProductStatus(7, "draft")).rejects.toBeInstanceOf(ErrorType);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("setProductStatus: network reset and timeout are not re-sent", async () => {
    const network = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", network);
    await expect(woo().setProductStatus(7, "publish")).rejects.toBeInstanceOf(WooCommerceUnavailableError);
    expect(network).toHaveBeenCalledTimes(1);

    const timeout = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", timeout);
    await expect(woo().setProductStatus(7, "publish")).rejects.toBeInstanceOf(WooCommerceTimeoutError);
    expect(timeout).toHaveBeenCalledTimes(1);
  });
});
