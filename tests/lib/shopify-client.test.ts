import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyClient, SHOPIFY_API_VERSION } from "@/lib/integrations/shopify/client";
import {
  ShopifyAuthError,
  ShopifyPermissionError,
  ShopifyNotFoundError,
  ShopifyThrottledError,
  ShopifyTimeoutError,
  ShopifyUnavailableError,
  ShopifyMalformedResponseError,
  ShopifyUserError,
} from "@/lib/integrations/shopify/errors";

function gqlResponse(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify({ data }), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}
function gqlErrors(errors: { message: string; extensions?: { code?: string } }[]) {
  return new Response(JSON.stringify({ errors }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("ShopifyClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends the access token as X-Shopify-Access-Token, never in the URL", async () => {
    let capturedUrl = "";
    let capturedHeader: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        capturedUrl = url;
        capturedHeader = (init.headers as Record<string, string>)["X-Shopify-Access-Token"];
        return gqlResponse({ locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
      })
    );

    const client = new ShopifyClient("https://boutique.myshopify.com", "shpat_secret123");
    await client.testConnection();

    expect(capturedUrl).toBe(`https://boutique.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`);
    expect(capturedUrl).not.toContain("shpat_secret123");
    expect(capturedHeader).toBe("shpat_secret123");
  });

  it("testConnection() succeeds on a normal 200 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gqlResponse({ locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("maps HTTP 401 to ShopifyAuthError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyAuthError);
  });

  it("maps HTTP 404 to ShopifyNotFoundError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyNotFoundError);
  });

  it("maps a GraphQL ACCESS_DENIED error to ShopifyPermissionError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gqlErrors([{ message: "denied", extensions: { code: "ACCESS_DENIED" } }])));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyPermissionError);
  });

  it("maps a malformed (non-JSON) response to ShopifyMalformedResponseError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyMalformedResponseError);
  });

  it("maps a response that doesn't match the expected shape to ShopifyMalformedResponseError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gqlResponse({ not: "expected" })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyMalformedResponseError);
  });

  it("retries a THROTTLED GraphQL error and eventually succeeds", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls < 2) return gqlErrors([{ message: "Throttled", extensions: { code: "THROTTLED" } }]);
        return gqlResponse({ locations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
      })
    );
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("gives up after persistently exhausted THROTTLED responses with ShopifyThrottledError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => gqlErrors([{ message: "Throttled", extensions: { code: "THROTTLED" } }])));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyThrottledError);
  });

  it("gives up after repeated 5xx errors with ShopifyUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyUnavailableError);
  });

  it("wraps a network-level failure as ShopifyUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      })
    );
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.testConnection()).rejects.toThrow(ShopifyUnavailableError);
  });

  it("times out and throws ShopifyTimeoutError when Shopify never responds", async () => {
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
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    const promise = client.testConnection();
    const assertion = expect(promise).rejects.toThrow(ShopifyTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("paginates locations using pageInfo.hasNextPage/endCursor", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call++;
        if (call === 1) {
          return gqlResponse({
            locations: { nodes: [{ id: "gid://shopify/Location/1", name: "A", isActive: true }], pageInfo: { hasNextPage: true, endCursor: "cursor1" } },
          });
        }
        return gqlResponse({
          locations: { nodes: [{ id: "gid://shopify/Location/2", name: "B", isActive: true }], pageInfo: { hasNextPage: false, endCursor: null } },
        });
      })
    );
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    const names: string[] = [];
    for await (const page of client.listAllLocations()) {
      for (const l of page) names.push(l.name);
    }
    expect(names).toEqual(["A", "B"]);
    expect(call).toBe(2);
  });

  it("setInventoryQuantities() throws ShopifyUserError when Shopify reports userErrors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => gqlResponse({ inventorySetQuantities: { userErrors: [{ field: ["quantities", "0"], message: "Location not found" }] } }))
    );
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await expect(client.setInventoryQuantities([{ inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", quantity: 5 }])).rejects.toThrow(
      ShopifyUserError
    );
  });

  it("setInventoryQuantities() is a no-op for an empty entries array (no request sent)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new ShopifyClient("https://boutique.myshopify.com", "token");
    await client.setInventoryQuantities([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
