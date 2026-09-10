/**
 * Maps the current app path to a support context: a human label, the
 * business area, an optional entity the user is looking at (an order /
 * shipment), the AI quick-actions worth featuring, and the default
 * "signaler un problème" category. Pure and synchronous — the widget calls
 * it on every navigation, and the tests exercise it directly.
 *
 * It never runs a query or duplicates business logic; the featured action
 * ids simply point at existing controlled AI tools (src/lib/ai/tools.ts).
 */

export type SupportArea =
  | "dashboard"
  | "orders"
  | "delivery"
  | "catalogue"
  | "finance"
  | "generic";

export interface SupportContext {
  area: SupportArea;
  /** Short French label for the current screen, e.g. "cette commande". */
  label: string;
  /** The record the user is viewing, when the URL identifies one. */
  entity?: { type: "Order" | "Shipment"; id: string };
  /** AI quick-action tool ids to feature first, in order. Filtered against
   * the user's permissions before display. */
  featuredActionIds: string[];
  /** Pre-selected category for the "Signaler un problème" form. */
  reportCategory: string;
}

const CID = "[a-z0-9]{20,}"; // a cuid-ish id segment

/** Strip a trailing slash and any query/hash, keep the pathname. */
function cleanPath(pathname: string): string {
  const path = pathname.split(/[?#]/)[0];
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

export function resolveSupportContext(pathname: string): SupportContext {
  const path = cleanPath(pathname || "/");

  const orderMatch = path.match(new RegExp(`^/commandes/(${CID})$`, "i"));
  if (orderMatch) {
    return {
      area: "orders",
      label: "cette commande",
      entity: { type: "Order", id: orderMatch[1] },
      featuredActionIds: ["orders-today", "late-orders", "top-products-today"],
      reportCategory: "commande",
    };
  }

  const shipmentMatch = path.match(
    new RegExp(`^/livraison/(?:suivi|factures)/(${CID})$`, "i"),
  );
  if (shipmentMatch) {
    return {
      area: "delivery",
      label: "cette expédition",
      entity: { type: "Shipment", id: shipmentMatch[1] },
      featuredActionIds: ["deliveries-in-transit", "delivery-performance", "returns-this-month"],
      reportCategory: "livraison",
    };
  }

  if (path === "/tableau-de-bord" || path === "/") {
    return {
      area: "dashboard",
      label: "le tableau de bord",
      featuredActionIds: ["profit-today", "revenue-today", "orders-today"],
      reportCategory: "autre",
    };
  }

  if (path.startsWith("/commandes") || path.startsWith("/confirmation") || path.startsWith("/clients")) {
    return {
      area: "orders",
      label: "les commandes",
      featuredActionIds: ["orders-today", "late-orders", "top-products-today"],
      reportCategory: "commande",
    };
  }

  if (path.startsWith("/livraison")) {
    return {
      area: "delivery",
      label: "la livraison",
      featuredActionIds: ["deliveries-in-transit", "delivery-performance", "returns-this-month"],
      reportCategory: "livraison",
    };
  }

  if (
    path.startsWith("/produits") ||
    path.startsWith("/stock") ||
    path.startsWith("/inventaires") ||
    path.startsWith("/transferts") ||
    path.startsWith("/entrepots")
  ) {
    return {
      area: "catalogue",
      label: "le catalogue et le stock",
      featuredActionIds: ["low-stock", "top-products-today", "top-product"],
      reportCategory: "stock",
    };
  }

  if (
    path.startsWith("/finance") ||
    path.startsWith("/depenses") ||
    path.startsWith("/rapports") ||
    path.startsWith("/analyses") ||
    path.startsWith("/commissions")
  ) {
    return {
      area: "finance",
      label: "les finances",
      featuredActionIds: ["revenue-today", "profit-today", "delivery-spend-month", "marketing-spend"],
      reportCategory: "finance",
    };
  }

  return {
    area: "generic",
    label: "ASODITECH",
    featuredActionIds: ["profit-today", "orders-today", "deliveries-in-transit", "low-stock"],
    reportCategory: "autre",
  };
}

/**
 * The pre-filled WhatsApp / problem-report message. Carries the company
 * name and the current screen (and order reference when on an order) so
 * support has context — never a credential, token or raw payload.
 */
export function buildSupportMessage(input: {
  companyName?: string | null;
  context: SupportContext;
  pageUrl?: string | null;
}): string {
  const company = input.companyName?.trim() || "ASODITECH";
  const lines = [`Bonjour, j'ai besoin d'aide concernant ${company}.`];
  lines.push(`Écran : ${input.context.label}.`);
  if (input.context.entity) {
    const kind = input.context.entity.type === "Order" ? "Commande" : "Expédition";
    lines.push(`${kind} : ${input.context.entity.id}.`);
  }
  if (input.pageUrl) lines.push(`Page : ${input.pageUrl}`);
  return lines.join("\n");
}
