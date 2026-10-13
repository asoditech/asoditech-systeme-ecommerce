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
  WooCommerceApiError,
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

  it("distinguishes a rejected key from a stripped Authorization header on 401", async () => {
    // WooCommerce received the credentials and rejected them.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "woocommerce_rest_authentication_error" }, { status: 401 }))
    );
    let client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(/refusés par la boutique/i);

    // WooCommerce saw an anonymous request — the server never forwarded the header.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "woocommerce_rest_cannot_view" }, { status: 401 }))
    );
    client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(/n'a pas reçu les identifiants|Authorization/i);
  });

  it("maps 404 to WooCommerceNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, { status: 404 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).rejects.toThrow(WooCommerceNotFoundError);
  });

  it("a 404 keeps WooCommerce's validated slug (product deleted vs wrong URL), never its text, same message", async () => {
    const notFound = async (body: string) => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404, headers: { "content-type": "application/json" } })));
      const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
      return (await client.getProduct(42).catch((e: unknown) => e)) as WooCommerceNotFoundError;
    };
    const deleted = await notFound(JSON.stringify({ code: "woocommerce_rest_product_invalid_id", message: "ID <b>non valide</b>.", data: { status: 404 } }));
    expect(deleted).toBeInstanceOf(WooCommerceNotFoundError);
    expect(deleted.remoteCode).toBe("woocommerce_rest_product_invalid_id");
    expect(deleted.message).toBe("Ressource introuvable sur la boutique WooCommerce — vérifiez l'URL de la boutique.");
    expect((await notFound(JSON.stringify({ code: "rest_no_route" }))).remoteCode).toBe("rest_no_route");
    expect((await notFound("<html>404</html>")).remoteCode).toBeUndefined();
    expect((await notFound(JSON.stringify({ code: "<script>alert(1)</script>" }))).remoteCode).toBeUndefined();
  });

  it("keeps a 4xx rejection's status, WooCommerce slug and a bounded message (WooCommerceApiError), without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ code: "product_invalid_sku", message: `<p>Invalid or duplicated SKU.</p>${" pad".repeat(200)}` }, { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "ck_secret_key", consumerSecret: "cs_secret" });
    const error = await client.testConnection().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WooCommerceApiError);
    const api = error as WooCommerceApiError;
    expect(api).toMatchObject({ code: "API_ERROR", status: 400, remoteCode: "product_invalid_sku", message: "SKU déjà utilisé sur la boutique." });
    expect(api.remoteMessage?.startsWith("Invalid or duplicated SKU.")).toBe(true);
    expect(api.remoteMessage!.length).toBeLessThanOrEqual(201);
    expect(api.message).not.toMatch(/ck_secret_key|cs_secret|Basic/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an empty or non-JSON 4xx body still yields a WooCommerceApiError with the status (never a JSON parse error)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Not Acceptable</html>", { status: 406 })));
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    const error = (await client.testConnection().catch((e: unknown) => e)) as WooCommerceApiError;
    expect(error).toBeInstanceOf(WooCommerceApiError);
    expect(error).toMatchObject({ status: 406, remoteCode: undefined, remoteMessage: undefined });
    expect(error.message).toBe("La boutique WooCommerce a refusé la requête (HTTP 406).");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 400 })));
    await expect(client.testConnection()).rejects.toThrow("La boutique WooCommerce a refusé la requête (HTTP 400).");
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
    for await (const { items } of client.listAllProducts()) {
      for (const p of items) collected.push(p.id);
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

  it("testConnection() does not fail over a real store's quirky order field shapes", async () => {
    // A live store whose plugins return money as numbers and attach extra
    // blocks — the strict order schema would reject this, but a connection
    // check must not.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([{ id: 42, total: 199.9, meta_data: [{ key: "x", value: { nested: true } }] }], {
          headers: { "x-wp-totalpages": "1" },
        })
      )
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("listAllOrders() yields the readable orders and counts the unreadable ones instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          [
            baseOrder(1, { total: "50.00" }),
            baseOrder(2, { total: 75 }), // money as a number — must still parse
            { id: 3, garbage: true }, // unreadable — missing required fields
          ],
          { headers: { "x-wp-totalpages": "1" } }
        )
      )
    );
    const client = new WooCommerceClient("https://boutique.example", { consumerKey: "a", consumerSecret: "b" });

    const seen: number[] = [];
    let unreadable = 0;
    for await (const { orders, unparsable } of client.listAllOrders()) {
      for (const o of orders) seen.push(o.id);
      unreadable += unparsable;
    }
    expect(seen).toEqual([1, 2]);
    expect(unreadable).toBe(1);
  });
});

function baseOrder(id: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    number: String(id),
    status: "processing",
    currency: "MAD",
    date_created: "2026-01-01T00:00:00",
    customer_id: 0,
    total: "0.00",
    billing: {},
    shipping: {},
    line_items: [],
    ...extra,
  };
}

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
