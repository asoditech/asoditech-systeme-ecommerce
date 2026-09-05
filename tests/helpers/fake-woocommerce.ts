import { vi } from "vitest";

/**
 * A minimal in-memory fake WooCommerce REST API, driven purely by fetch
 * mocking — no real network call ever leaves the process. Used so the
 * sync engine and Server Actions can be tested end-to-end against the
 * real test database (per this repo's convention) without depending on a
 * live WooCommerce store. See docs/adr/0010-woocommerce-integration.md.
 *
 * The store URL used in these tests ("https://example.com") is a real,
 * stable, publicly-resolvable domain (IANA-reserved for documentation) so
 * validateStoreUrl()'s SSRF/DNS check passes for real — only the actual
 * HTTP request is intercepted, not DNS resolution.
 */
export const FAKE_STORE_URL = "https://example.com";
export const FAKE_CONSUMER_KEY = "ck_test_1234567890";
export const FAKE_CONSUMER_SECRET = "cs_test_0987654321";

export interface FakeCategory {
  id: number;
  name: string;
  slug: string;
  parent?: number;
  description?: string | null;
}

export interface FakeVariation {
  id: number;
  sku: string;
  regular_price: string;
  price?: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  attributes: { name: string; option: string }[];
}

export interface FakeProduct {
  id: number;
  name: string;
  slug: string;
  sku: string;
  status: string;
  type: string;
  description?: string | null;
  regular_price: string;
  sale_price?: string | null;
  price?: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status?: string;
  categories: { id: number; name: string; slug: string }[];
  /** The WC-shape list of variation ids (what wcProductSchema actually reads). */
  variations?: number[];
  /** Fake-server-only: the full variation records served by the variations sub-endpoint. */
  variationList?: FakeVariation[];
}

export interface FakeOrder {
  id: number;
  number: string;
  status: string;
  currency?: string;
  date_created: string;
  date_paid?: string | null;
  customer_id: number;
  total: string;
  total_tax?: string;
  shipping_total?: string;
  discount_total?: string;
  payment_method?: string | null;
  billing: Record<string, string | null>;
  shipping?: Record<string, string | null>;
  line_items: {
    id: number;
    name: string;
    product_id?: number | null;
    variation_id?: number | null;
    sku?: string | null;
    quantity: number;
    price: string;
    subtotal: string;
    total: string;
  }[];
  refunds?: { id: number; reason?: string | null; total: string }[];
}

export interface FakeStoreState {
  categories: FakeCategory[];
  products: FakeProduct[];
  orders: FakeOrder[];
  stockUpdates: { path: string; body: unknown }[];
  orderUpdates: { orderId: number; body: unknown }[];
}

function paginate<T>(items: T[], page: number, perPage: number): { items: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { items: items.slice(start, start + perPage), totalPages };
}

function jsonResponse(body: unknown, totalPages = 1, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-wp-totalpages": String(totalPages) },
  });
}

/** Installs the fake fetch. Call in beforeEach; call vi.unstubAllGlobals() in afterEach. */
export function installFakeWooCommerceServer(state: FakeStoreState) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      const expectedAuth = `Basic ${Buffer.from(`${FAKE_CONSUMER_KEY}:${FAKE_CONSUMER_SECRET}`).toString("base64")}`;
      if (auth !== expectedAuth) {
        return jsonResponse({ code: "woocommerce_rest_authentication_error", message: "Invalid signature" }, 1, 401);
      }

      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const path = url.pathname.replace("/wp-json/wc/v3", "");
      const method = init?.method ?? "GET";

      const variationMatch = path.match(/^\/products\/(\d+)\/variations\/?(\d+)?$/);
      if (variationMatch && method === "GET" && !variationMatch[2]) {
        const productId = Number(variationMatch[1]);
        const product = state.products.find((p) => p.id === productId);
        const { items, totalPages } = paginate(product?.variationList ?? [], page, perPage);
        return jsonResponse(items, totalPages);
      }
      if (variationMatch && method === "PUT" && variationMatch[2]) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        state.stockUpdates.push({ path, body });
        return jsonResponse({ id: Number(variationMatch[2]) });
      }

      const productMatch = path.match(/^\/products\/(\d+)$/);
      if (productMatch && method === "PUT") {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        state.stockUpdates.push({ path, body });
        return jsonResponse({ id: Number(productMatch[1]) });
      }

      if (path === "/products/categories") {
        const { items, totalPages } = paginate(state.categories, page, perPage);
        return jsonResponse(items, totalPages);
      }

      if (path === "/products") {
        const { items, totalPages } = paginate(state.products, page, perPage);
        return jsonResponse(items, totalPages);
      }

      if (path === "/orders") {
        const after = url.searchParams.get("after");
        const filtered = after ? state.orders.filter((o) => o.date_created >= after) : state.orders;
        const { items, totalPages } = paginate(filtered, page, perPage);
        return jsonResponse(items, totalPages);
      }

      const orderMatch = path.match(/^\/orders\/(\d+)$/);
      if (orderMatch && method === "GET") {
        const order = state.orders.find((o) => o.id === Number(orderMatch[1]));
        return order ? jsonResponse(order) : jsonResponse({ message: "not found" }, 1, 404);
      }
      if (orderMatch && method === "PUT") {
        const orderId = Number(orderMatch[1]);
        const body = init?.body ? JSON.parse(init.body as string) : {};
        state.orderUpdates.push({ orderId, body });
        return jsonResponse({ id: orderId });
      }

      return jsonResponse({ message: "not found" }, 1, 404);
    })
  );
}

export function emptyFakeStore(): FakeStoreState {
  return { categories: [], products: [], orders: [], stockUpdates: [], orderUpdates: [] };
}
