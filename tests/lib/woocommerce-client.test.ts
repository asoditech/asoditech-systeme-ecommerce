import { afterEach, describe, expect, it, vi } from "vitest";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import {
  WooCommerceAuthError,
  WooCommercePermissionError,
  WooCommerceNotFoundError,
  WooCommerceRateLimitError,
  WooCommerceTimeoutError,
  WooCommerceUnavailableError,
  WooCommerceMalformedResponseError,
} from "@/lib/integrations/woocommerce/errors";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

describe("WooCommerceClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends HTTP Basic Auth built from the consumer key/secret, never in the URL", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedAuth = (init.headers as Record<string, string>).Authorization;
        return jsonResponse([], { headers: { "x-wp-totalpages": "1" } });
      })
    );

    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "ck_abc", consumerSecret: "cs_xyz" });
    await client.testConnection();

    expect(capturedUrl).not.toContain("ck_abc");
    expect(capturedUrl).not.toContain("cs_xyz");
    expect(capturedAuth).toBe(`Basic ${Buffer.from("ck_abc:cs_xyz").toString("base64")}`);
  });

  it("testConnection() succeeds on a 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([], { headers: { "x-wp-totalpages": "1" } })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("maps 401 to WooCommerceAuthError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ message: "bad" }, { status: 401 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceAuthError);
  });

  it("maps 403 to WooCommercePermissionError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 403 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommercePermissionError);
  });

  it("maps 404 to WooCommerceNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 404 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceNotFoundError);
  });

  it("maps a malformed (non-JSON) response body to WooCommerceMalformedResponseError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }))
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceMalformedResponseError);
  });

  it("maps a response that doesn't match the expected shape to WooCommerceMalformedResponseError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ not: "an array" })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceMalformedResponseError);
  });

  it("times out and throws WooCommerceTimeoutError when the store never responds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          })
      )
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });

    const promise = client.testConnection();
    const assertion = expect(promise).rejects.toThrow(WooCommerceTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("retries on 429 (respecting Retry-After) and eventually succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 2) return jsonResponse({}, { status: 429, headers: { "retry-after": "0" } });
        return jsonResponse([], { headers: { "x-wp-totalpages": "1" } });
      })
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("maps persistently exhausted 429 retries to WooCommerceRateLimitError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 429, headers: { "retry-after": "0" } })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceRateLimitError);
  });

  it("gives up after repeated 5xx errors with WooCommerceUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 500 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceUnavailableError);
  });

  it("wraps a network-level failure (DNS/connection refused) as WooCommerceUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceUnavailableError);
  });

  it("paginates using X-WP-TotalPages and stops at the last page", async () => {
    const pages = [
      [{ id: 1 }, { id: 2 }],
      [{ id: 3 }],
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const page = Number(new URL(url).searchParams.get("page"));
        return jsonResponse(
          pages[page - 1].map((p) => baseProduct(p.id)),
          { headers: { "x-wp-totalpages": "2" } }
        );
      })
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });

    const collected: number[] = [];
    for await (const page of client.listAllProducts()) {
      for (const p of page) collected.push(p.id);
    }
    expect(collected).toEqual([1, 2, 3]);
  });

  it("updateStock() sends a PUT with the quantity and targets the variation endpoint when given one", async () => {
    let capturedPath = "";
    let capturedMethod = "";
    let capturedBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedPath = new URL(url).pathname;
        capturedMethod = init.method ?? "";
        capturedBody = JSON.parse(init.body as string);
        return jsonResponse({});
      })
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await client.updateStock(10, 5, 20);
    expect(capturedMethod).toBe("PUT");
    expect(capturedPath).toBe("/wp-json/wc/v3/products/10/variations/20");
    expect(capturedBody).toMatchObject({ stock_quantity: 5 });
  });
});

function baseProduct(id: number) {
  return {
    id,
    name: `Produit ${id}`,
    slug: `produit-${id}`,
    sku: `SKU-${id}`,
    status: "publish",
    type: "simple",
    regular_price: "10.00",
    price: "10.00",
    manage_stock: false,
    stock_status: "instock",
    categories: [],
    variations: [],
  };
}
