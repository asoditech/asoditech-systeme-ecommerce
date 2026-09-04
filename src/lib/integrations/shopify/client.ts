import "server-only";

import { z } from "zod";
import {
  errorForStatus,
  ShopifyMalformedResponseError,
  ShopifyTimeoutError,
  ShopifyUnavailableError,
  ShopifyThrottledError,
  ShopifyUserError,
} from "./errors";
import {
  shopifyLocationsPageSchema,
  shopifyProductsPageSchema,
  shopifyOrdersPageSchema,
  shopifyOrderSchema,
  shopifyInventorySetQuantitiesResultSchema,
  type ShopifyLocation,
  type ShopifyProduct,
  type ShopifyOrder,
} from "./types";

const ORDER_FIELDS = `
  id name createdAt displayFinancialStatus displayFulfillmentStatus
  cancelledAt cancelReason
  customer { id email firstName lastName phone }
  email phone note paymentGatewayNames
  shippingAddress { firstName lastName address1 address2 city province country phone }
  billingAddress { firstName lastName address1 address2 city province country phone }
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }
  totalRefundedSet { shopMoney { amount currencyCode } }
  lineItems(first: 100) {
    nodes {
      id title sku quantity
      variant { id }
      product { id }
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      discountedTotalSet { shopMoney { amount currencyCode } }
      originalTotalSet { shopMoney { amount currencyCode } }
    }
  }
  refunds { id createdAt note totalRefundedSet { shopMoney { amount currencyCode } } }
`;

/**
 * The Admin API version this adapter targets — verified against Shopify's
 * official developer docs during Phase 21 as the current stable release
 * (quarterly cadence: YYYY-01/04/07/10). See
 * docs/adr/0011-shopify-integration.md.
 */
export const SHOPIFY_API_VERSION = "2026-07";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 50;
const INVENTORY_LEVELS_PER_VARIANT = 10;
/** Safety ceiling on pages fetched per sync run — not a business limit. */
const MAX_PAGES = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
}

/**
 * Thin, centralized Shopify Admin GraphQL API client (2026-07). REST is
 * legacy per Shopify's own docs as of October 2024 and mandatory-GraphQL
 * for new public apps since April 2025 — this adapter is built on GraphQL
 * throughout rather than mirroring WooCommerce's REST approach, per
 * Shopify's actual current API model. See
 * docs/adr/0011-shopify-integration.md.
 *
 * `shopDomain` must already be validated (validateShopDomain()) by the
 * caller.
 */
export class ShopifyClient {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor(shopDomain: string, accessToken: string) {
    this.endpoint = `${shopDomain.replace(/\/+$/, "")}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    this.accessToken = accessToken;
  }

  private async request<T>(schema: z.ZodType<T>, query: string, variables?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": this.accessToken,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof DOMException && error.name === "AbortError") {
          throw new ShopifyTimeoutError("Shopify n'a pas répondu à temps.");
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ShopifyUnavailableError("Impossible de joindre Shopify.");
      }
      clearTimeout(timeout);

      if (response.status === 429 || response.status >= 500) {
        if (attempt < MAX_RETRIES - 1) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
          await sleep(delay);
          continue;
        }
      }
      if (!response.ok) {
        throw errorForStatus(response.status);
      }

      let body: GraphQLResponse<unknown>;
      try {
        body = await response.json();
      } catch {
        throw new ShopifyMalformedResponseError("Réponse invalide reçue de Shopify.");
      }

      if (body.errors && body.errors.length > 0) {
        const throttled = body.errors.some((e) => e.extensions?.code === "THROTTLED");
        if (throttled) {
          if (attempt < MAX_RETRIES - 1) {
            // Shopify's own recommended backoff for a throttled GraphQL query is one second.
            await sleep(1000);
            continue;
          }
          throw new ShopifyThrottledError("Shopify a limité le nombre de requêtes. Réessayez dans un instant.");
        }
        const accessDenied = body.errors.some((e) => e.extensions?.code === "ACCESS_DENIED");
        if (accessDenied) {
          throw errorForStatus(403);
        }
        throw new ShopifyMalformedResponseError("Shopify a retourné une erreur inattendue pour cette requête.");
      }

      const parsed = schema.safeParse(body.data);
      if (!parsed.success) {
        throw new ShopifyMalformedResponseError("La réponse de Shopify ne correspond pas au format attendu.");
      }
      return parsed.data;
    }
    throw new ShopifyUnavailableError("Impossible de joindre Shopify.");
  }

  /** Real authenticated request — the only thing allowed to mark a connection CONNECTE. */
  async testConnection(): Promise<void> {
    await this.request(
      shopifyLocationsPageSchema,
      `query TestConnection { locations(first: 1) { nodes { id name isActive } pageInfo { hasNextPage endCursor } } }`
    );
  }

  async *listAllLocations(): AsyncGenerator<ShopifyLocation[]> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: z.infer<typeof shopifyLocationsPageSchema> = await this.request(
        shopifyLocationsPageSchema,
        `query Locations($cursor: String) {
           locations(first: ${PAGE_SIZE}, after: $cursor) {
             nodes { id name isActive }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { cursor }
      );
      yield result.locations.nodes;
      if (!result.locations.pageInfo.hasNextPage) return;
      cursor = result.locations.pageInfo.endCursor ?? null;
    }
  }

  async *listAllProducts(): AsyncGenerator<ShopifyProduct[]> {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: z.infer<typeof shopifyProductsPageSchema> = await this.request(
        shopifyProductsPageSchema,
        `query Products($cursor: String) {
           products(first: ${PAGE_SIZE}, after: $cursor) {
             nodes {
               id title handle status descriptionHtml
               variants(first: 100) {
                 nodes {
                   id title sku price
                   inventoryItem {
                     id tracked
                     inventoryLevels(first: ${INVENTORY_LEVELS_PER_VARIANT}) {
                       nodes { location { id } quantities(names: ["available"]) { name quantity } }
                     }
                   }
                 }
               }
             }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { cursor }
      );
      yield result.products.nodes;
      if (!result.products.pageInfo.hasNextPage) return;
      cursor = result.products.pageInfo.endCursor ?? null;
    }
  }

  /**
   * `startCursor` resumes a paged scan from a previously-yielded
   * `endCursor` instead of always starting at the newest order — see
   * WooCommerce's equivalent `startPage` param and `syncOrders` for why.
   * Each yielded page carries the cursor to resume *after* it, so a
   * caller that stops partway through can persist exactly where to pick
   * back up.
   */
  async *listAllOrders(
    startCursor?: string | null
  ): AsyncGenerator<{ orders: ShopifyOrder[]; endCursor: string | null; hasNextPage: boolean }> {
    let cursor: string | null = startCursor ?? null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: z.infer<typeof shopifyOrdersPageSchema> = await this.request(
        shopifyOrdersPageSchema,
        `query Orders($cursor: String) {
           orders(first: ${PAGE_SIZE}, after: $cursor, sortKey: CREATED_AT) {
             nodes { ${ORDER_FIELDS} }
             pageInfo { hasNextPage endCursor }
           }
         }`,
        { cursor }
      );
      const endCursor = result.orders.pageInfo.endCursor ?? null;
      yield { orders: result.orders.nodes, endCursor, hasNextPage: result.orders.pageInfo.hasNextPage };
      if (!result.orders.pageInfo.hasNextPage) return;
      cursor = endCursor;
    }
  }

  /**
   * Fetches a single order by its gid — used by the webhook route, which
   * receives only enough of a REST-shaped payload to identify the order
   * (see docs/adr/0011-shopify-integration.md on why the webhook body
   * itself is never mapped directly: its shape doesn't match the GraphQL
   * shape this client and the sync engine use everywhere else).
   */
  async getOrder(gid: string): Promise<ShopifyOrder | null> {
    const result = await this.request(
      z.object({ order: shopifyOrderSchema.nullable() }),
      `query GetOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
      { id: gid }
    );
    return result.order;
  }

  /**
   * System → Shopify inventory push (absolute set, not a delta) — the
   * mutation Shopify's own docs recommend "if calling on behalf of a
   * system that acts as the source of truth for inventory quantities",
   * which is exactly this system's role for products it owns
   * (source=SHOPIFY, already round-tripped from Shopify's own catalog).
   * Batches multiple (inventoryItemId, locationId, quantity) entries into
   * one mutation call.
   */
  async setInventoryQuantities(
    entries: { inventoryItemId: string; locationId: string; quantity: number }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    const result = await this.request(
      shopifyInventorySetQuantitiesResultSchema,
      `mutation SetQuantities($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) {
           userErrors { field message }
         }
       }`,
      {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: entries,
        },
      }
    );
    if (result.inventorySetQuantities.userErrors.length > 0) {
      throw new ShopifyUserError(
        `Shopify a refusé la mise à jour du stock : ${result.inventorySetQuantities.userErrors[0].message}`
      );
    }
  }
}
