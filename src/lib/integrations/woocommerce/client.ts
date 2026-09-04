import "server-only";

import { z } from "zod";
import {
  errorForStatus,
  WooCommerceMalformedResponseError,
  WooCommerceTimeoutError,
  WooCommerceUnavailableError,
} from "./errors";
import {
  wcOrderSchema,
  wcProductCategorySchema,
  wcProductSchema,
  wcProductVariationSchema,
  type WcListMeta,
  type WcOrder,
  type WcProduct,
  type WcProductCategory,
  type WcProductVariation,
} from "./types";

export interface WooCommerceCredentials {
  consumerKey: string;
  consumerSecret: string;
}

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const PER_PAGE = 50;
/** Hard ceiling on pages fetched in a single sync run — a safety bound, not
 * a business limit; a store with more than this many items needs a
 * dedicated background/queued sync design this phase doesn't build. */
const MAX_PAGES = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin, centralized WooCommerce REST API v3 client. Every network call in
 * the adapter goes through here — auth, base URL, headers, timeout, retry,
 * and response-shape validation are handled once, not scattered across
 * Server Actions. See docs/adr/0010-woocommerce-integration.md.
 *
 * `storeUrl` must already be validated (validateStoreUrl()) by the caller
 * — this class does not re-check SSRF safety, since the URL may need to be
 * re-validated at a slightly different point in the call chain (e.g. right
 * before a scheduled sync) than where the client is constructed.
 */
export class WooCommerceClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(storeUrl: string, credentials: WooCommerceCredentials) {
    this.baseUrl = `${storeUrl.replace(/\/+$/, "")}/wp-json/wc/v3`;
    // HTTP Basic Auth over HTTPS, as documented for server-to-server use —
    // never query-string credentials (they'd end up in access logs, proxy
    // logs, and Referer headers).
    this.authHeader = `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64")}`;
  }

  private async requestRaw(path: string, init?: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: this.authHeader,
            Accept: "application/json",
            ...(init?.body ? { "Content-Type": "application/json" } : {}),
            ...init?.headers,
          },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (response.status === 429 || response.status >= 500) {
          if (attempt < MAX_RETRIES - 1) {
            const retryAfter = Number(response.headers.get("retry-after"));
            const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
            await sleep(delay);
            continue;
          }
        }
        return response;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error;
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new WooCommerceTimeoutError("La boutique WooCommerce n'a pas répondu à temps.");
        }
        // Network-level failure (DNS, TLS, connection refused) — retry with
        // backoff, same as a 5xx.
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
      }
    }
    if (lastError) {
      throw new WooCommerceUnavailableError("Impossible de joindre la boutique WooCommerce.");
    }
    throw new WooCommerceUnavailableError("Impossible de joindre la boutique WooCommerce.");
  }

  private async requestJson<T>(schema: z.ZodType<T>, path: string, init?: RequestInit): Promise<T> {
    const response = await this.requestRaw(path, init);
    if (!response.ok) {
      throw errorForStatus(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WooCommerceMalformedResponseError("Réponse invalide reçue de la boutique WooCommerce.");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new WooCommerceMalformedResponseError(
        "La réponse de la boutique WooCommerce ne correspond pas au format attendu."
      );
    }
    return parsed.data;
  }

  private async requestPage<T>(
    schema: z.ZodType<T>,
    path: string,
    page: number
  ): Promise<{ items: T; meta: WcListMeta }> {
    const separator = path.includes("?") ? "&" : "?";
    const response = await this.requestRaw(`${path}${separator}page=${page}&per_page=${PER_PAGE}`);
    if (!response.ok) {
      throw errorForStatus(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WooCommerceMalformedResponseError("Réponse invalide reçue de la boutique WooCommerce.");
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new WooCommerceMalformedResponseError(
        "La réponse de la boutique WooCommerce ne correspond pas au format attendu."
      );
    }
    const totalPages = Number(response.headers.get("x-wp-totalpages") ?? "1");
    const total = Number(response.headers.get("x-wp-total") ?? "0");
    return { items: parsed.data, meta: { totalPages: Number.isFinite(totalPages) ? totalPages : 1, total } };
  }

  /**
   * Real authenticated request — the only thing allowed to mark a
   * connection CONNECTE. Confirms connectivity + credentials only: an
   * authenticated `/orders` call has to come back as a JSON array. It
   * deliberately does NOT validate the shape of each order — a live
   * store's historical orders routinely carry plugin-specific field
   * quirks that the order-by-order import tolerates (skips + counts), and
   * those must not make the whole connection report as broken.
   */
  async testConnection(): Promise<void> {
    await this.requestPage(z.array(z.unknown()), "/orders", 1);
  }

  async *listAllProducts(): AsyncGenerator<WcProduct[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, meta } = await this.requestPage(z.array(wcProductSchema), "/products", page);
      yield items;
      if (page >= meta.totalPages) return;
    }
  }

  async *listAllProductCategories(): AsyncGenerator<WcProductCategory[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, meta } = await this.requestPage(z.array(wcProductCategorySchema), "/products/categories", page);
      yield items;
      if (page >= meta.totalPages) return;
    }
  }

  async *listAllProductVariations(productId: number): AsyncGenerator<WcProductVariation[]> {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { items, meta } = await this.requestPage(
        z.array(wcProductVariationSchema),
        `/products/${productId}/variations`,
        page
      );
      yield items;
      if (page >= meta.totalPages) return;
    }
  }

  /**
   * `startPage` lets a caller resume a paged scan instead of always
   * starting over at page 1 — see WooCommerce's `syncOrders`, which
   * persists how far it got so a Vercel Hobby-tier function (a hard
   * ~10s wall clock) doesn't have to re-fetch and re-skip every earlier
   * page on every run just to reach the work still to do. Each page is
   * parsed order-by-order: a single order the schema can't read (a
   * plugin-specific field shape, a value WooCommerce returned in an
   * unexpected type) is reported back as `unparsable` and left out,
   * instead of failing the whole import.
   */
  async *listAllOrders(
    startPage = 1
  ): AsyncGenerator<{ orders: WcOrder[]; unparsable: number; page: number; totalPages: number }> {
    for (let page = Math.max(1, startPage); page <= MAX_PAGES; page++) {
      const { items, meta } = await this.requestPage(z.array(z.unknown()), "/orders", page);
      const orders: WcOrder[] = [];
      let unparsable = 0;
      for (const item of items) {
        const parsed = wcOrderSchema.safeParse(item);
        if (parsed.success) orders.push(parsed.data);
        else unparsable++;
      }
      yield { orders, unparsable, page, totalPages: meta.totalPages };
      if (page >= meta.totalPages) return;
    }
  }

  async getOrder(id: number): Promise<WcOrder> {
    return this.requestJson(wcOrderSchema, `/orders/${id}`);
  }

  /** System → WooCommerce stock push. `variationId` targets a specific variation instead of the parent product. */
  async updateStock(productId: number, quantity: number, variationId?: number): Promise<void> {
    const path = variationId ? `/products/${productId}/variations/${variationId}` : `/products/${productId}`;
    const response = await this.requestRaw(path, {
      method: "PUT",
      body: JSON.stringify({ manage_stock: true, stock_quantity: quantity }),
    });
    if (!response.ok) {
      throw errorForStatus(response.status);
    }
  }
}
