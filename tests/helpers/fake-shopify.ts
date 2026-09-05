import { vi } from "vitest";

/**
 * A minimal in-memory fake Shopify Admin GraphQL API, driven purely by
 * fetch mocking — no real network call ever leaves the process. Unlike
 * WooCommerce's REST fake server (routed by URL path), every GraphQL
 * request POSTs to the same endpoint, so this routes by inspecting the
 * `query` string for a distinguishing marker. See
 * docs/adr/0011-shopify-integration.md.
 */
export const FAKE_SHOP_DOMAIN = "https://boutique-test.myshopify.com";
export const FAKE_ACCESS_TOKEN = "shpat_test_1234567890";

export interface FakeLocation {
  id: string;
  name: string;
  isActive: boolean;
}

export interface FakeInventoryLevel {
  locationId: string;
  available: number;
}

export interface FakeVariant {
  id: string;
  title: string;
  sku: string | null;
  price: string;
  inventoryItemId: string;
  tracked: boolean;
  levels: FakeInventoryLevel[];
}

export interface FakeProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  descriptionHtml?: string | null;
  variants: FakeVariant[];
}

export interface FakeOrder {
  id: string;
  name: string;
  createdAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  cancelledAt?: string | null;
  cancelReason?: string | null;
  customer?: { id: string; email?: string | null; firstName?: string | null; lastName?: string | null; phone?: string | null } | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  paymentGatewayNames?: string[];
  shippingAddress?: Record<string, string | null> | null;
  billingAddress?: Record<string, string | null> | null;
  total: number;
  subtotal: number;
  discounts?: number;
  shipping?: number;
  refundedTotal?: number;
  lineItems: {
    id: string;
    title: string;
    sku?: string | null;
    quantity: number;
    productId?: string | null;
    variantId?: string | null;
    unitPrice: number;
    discountedTotal: number;
    originalTotal: number;
  }[];
  refunds?: { id: string; createdAt: string; note?: string | null; total: number }[];
}

export interface FakeShopifyState {
  locations: FakeLocation[];
  products: FakeProduct[];
  orders: FakeOrder[];
  stockUpdates: { inventoryItemId: string; locationId: string; quantity: number }[];
}

export function emptyFakeShopifyStore(): FakeShopifyState {
  return { locations: [], products: [], orders: [], stockUpdates: [] };
}

function money(amount: number) {
  return { shopMoney: { amount: amount.toFixed(2), currencyCode: "MAD" } };
}

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

function serializeOrder(o: FakeOrder) {
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    displayFinancialStatus: o.displayFinancialStatus,
    displayFulfillmentStatus: o.displayFulfillmentStatus,
    cancelledAt: o.cancelledAt ?? null,
    cancelReason: o.cancelReason ?? null,
    customer: o.customer ?? null,
    email: o.email ?? null,
    phone: o.phone ?? null,
    note: o.note ?? null,
    paymentGatewayNames: o.paymentGatewayNames ?? [],
    shippingAddress: o.shippingAddress ?? null,
    billingAddress: o.billingAddress ?? null,
    currentTotalPriceSet: money(o.total),
    subtotalPriceSet: money(o.subtotal),
    totalDiscountsSet: money(o.discounts ?? 0),
    totalShippingPriceSet: money(o.shipping ?? 0),
    totalRefundedSet: money(o.refundedTotal ?? 0),
    lineItems: {
      nodes: o.lineItems.map((li) => ({
        id: li.id,
        title: li.title,
        sku: li.sku ?? null,
        quantity: li.quantity,
        variant: li.variantId ? { id: li.variantId } : null,
        product: li.productId ? { id: li.productId } : null,
        originalUnitPriceSet: money(li.unitPrice),
        discountedTotalSet: money(li.discountedTotal),
        originalTotalSet: money(li.originalTotal),
      })),
    },
    refunds: (o.refunds ?? []).map((r) => ({ id: r.id, createdAt: r.createdAt, note: r.note ?? null, totalRefundedSet: money(r.total) })),
  };
}

function serializeProduct(p: FakeProduct) {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    descriptionHtml: p.descriptionHtml ?? null,
    variants: {
      nodes: p.variants.map((v) => ({
        id: v.id,
        title: v.title,
        sku: v.sku,
        price: v.price,
        inventoryItem: {
          id: v.inventoryItemId,
          tracked: v.tracked,
          inventoryLevels: {
            nodes: v.levels.map((lvl) => ({
              location: { id: lvl.locationId },
              quantities: [{ name: "available", quantity: lvl.available }],
            })),
          },
        },
      })),
    },
  };
}

export function installFakeShopifyServer(state: FakeShopifyState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.["X-Shopify-Access-Token"];
      if (auth !== FAKE_ACCESS_TOKEN) {
        return new Response("{}", { status: 401 });
      }

      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query: string = body.query ?? "";
      const variables: Record<string, unknown> = body.variables ?? {};

      if (query.includes("mutation SetQuantities")) {
        const input = variables.input as { quantities: { inventoryItemId: string; locationId: string; quantity: number }[] };
        for (const q of input.quantities) state.stockUpdates.push(q);
        return jsonResponse({ inventorySetQuantities: { userErrors: [] } });
      }

      if (query.includes("query GetOrder")) {
        const order = state.orders.find((o) => o.id === variables.id);
        return jsonResponse({ order: order ? serializeOrder(order) : null });
      }

      if (query.includes("locations(")) {
        return jsonResponse({
          locations: { nodes: state.locations.map((l) => ({ id: l.id, name: l.name, isActive: l.isActive })), pageInfo: { hasNextPage: false, endCursor: null } },
        });
      }

      if (query.includes("query Products")) {
        return jsonResponse({
          products: {
            nodes: state.products.map(serializeProduct),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }

      if (query.includes("query GetProduct")) {
        const product = state.products.find((p) => p.id === variables.id);
        return jsonResponse({ product: product ? serializeProduct(product) : null });
      }

      if (query.includes("query Orders")) {
        const q = variables.q as string | undefined;
        let orders = state.orders;
        if (q) {
          const match = q.match(/created_at:>='([^']+)'/);
          if (match) orders = orders.filter((o) => o.createdAt >= match[1]);
        }
        return jsonResponse({ orders: { nodes: orders.map(serializeOrder), pageInfo: { hasNextPage: false, endCursor: null } } });
      }

      return jsonResponse({});
    })
  );
}
