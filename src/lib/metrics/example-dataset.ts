import type { OrderStatus, ShipmentStatus } from "@prisma/client";
import {
  asPct,
  averageBasket,
  confirmationRatePct,
  countOutcomes,
  deliveryOutcomeRate,
  NON_REVENUE_ORDER_STATUSES,
  netRevenue,
  orderDeliveryOutcome,
} from "@/lib/metrics/formulas";

/**
 * ONE fictional shop (« Boutique Exemple », septembre) behind every worked
 * example of the analytics explanations (src/lib/metrics/analytics-
 * explanations.ts). Nothing here is tenant data. The figures are COMPUTED
 * with the same pure functions the analytics queries use
 * (src/lib/metrics/formulas.ts), so an example cannot drift from the code;
 * tests/lib/analytics-explanations.test.ts re-checks them by hand and against
 * the server-side helpers (durations, margins).
 */

export interface ExampleOrder {
  ref: string;
  status: OrderStatus;
  /** Lines: product, quantity, unit price (MAD). */
  lines: { product: ExampleProduct; qty: number; unitPrice: number }[];
  /** Delivery fee charged to the customer. */
  shippingFee: number;
  confirmed: boolean;
  /** Confirmation attempts recorded (dated in the period). */
  attempts: number;
  /** Current (latest real) shipment status, null = never shipped. */
  shipment: ShipmentStatus | null;
  /** COMPLETE refunds recorded on the order. */
  refund: number;
  /** Delivery cost recorded on its shipment(s). */
  deliveryCost: number;
}

export type ExampleProduct = "Sac Atlas" | "Foulard Rif" | "Ceinture Fès";

/** Unit purchase cost frozen on each line at the sale (costSnapshot). */
export const EXAMPLE_COSTS: Record<ExampleProduct, number> = { "Sac Atlas": 60, "Foulard Rif": 40, "Ceinture Fès": 50 };

const SAC = 135;
const FOULARD = 110;
const CEINTURE = 85;
const FEE = 30;

/** Ten Online orders, all PLACED in the period (the « cohorte »). */
export const EXAMPLE_ORDERS: ExampleOrder[] = [
  { ref: "CMD-101", status: "LIVREE", lines: [{ product: "Sac Atlas", qty: 2, unitPrice: SAC }], shippingFee: FEE, confirmed: true, attempts: 1, shipment: "LIVRE", refund: 0, deliveryCost: 35 },
  { ref: "CMD-102", status: "LIVREE", lines: [{ product: "Foulard Rif", qty: 2, unitPrice: FOULARD }], shippingFee: FEE, confirmed: true, attempts: 2, shipment: "LIVRE", refund: 0, deliveryCost: 35 },
  {
    ref: "CMD-103",
    status: "LIVREE",
    lines: [
      { product: "Sac Atlas", qty: 1, unitPrice: SAC },
      { product: "Foulard Rif", qty: 1, unitPrice: FOULARD },
      { product: "Ceinture Fès", qty: 1, unitPrice: CEINTURE },
    ],
    shippingFee: FEE,
    confirmed: true,
    attempts: 1,
    shipment: "LIVRE",
    refund: 85,
    deliveryCost: 35,
  },
  { ref: "CMD-104", status: "EXPEDIEE", lines: [{ product: "Ceinture Fès", qty: 2, unitPrice: CEINTURE }], shippingFee: FEE, confirmed: true, attempts: 1, shipment: "EN_TRANSIT", refund: 0, deliveryCost: 35 },
  { ref: "CMD-105", status: "ECHEC", lines: [{ product: "Sac Atlas", qty: 2, unitPrice: SAC }], shippingFee: FEE, confirmed: true, attempts: 1, shipment: "ECHEC", refund: 0, deliveryCost: 20 },
  { ref: "CMD-106", status: "RETOUR", lines: [{ product: "Foulard Rif", qty: 3, unitPrice: FOULARD }], shippingFee: FEE, confirmed: true, attempts: 1, shipment: "RETOURNE", refund: 330, deliveryCost: 20 },
  { ref: "CMD-107", status: "CONFIRMEE", lines: [{ product: "Sac Atlas", qty: 1, unitPrice: SAC }], shippingFee: FEE, confirmed: true, attempts: 1, shipment: null, refund: 0, deliveryCost: 0 },
  { ref: "CMD-108", status: "ANNULEE", lines: [{ product: "Foulard Rif", qty: 1, unitPrice: FOULARD }], shippingFee: FEE, confirmed: false, attempts: 2, shipment: null, refund: 0, deliveryCost: 0 },
  { ref: "CMD-109", status: "NOUVELLE", lines: [{ product: "Ceinture Fès", qty: 1, unitPrice: CEINTURE }], shippingFee: FEE, confirmed: false, attempts: 1, shipment: null, refund: 0, deliveryCost: 0 },
  { ref: "CMD-110", status: "NOUVELLE", lines: [{ product: "Sac Atlas", qty: 1, unitPrice: SAC }], shippingFee: FEE, confirmed: false, attempts: 0, shipment: null, refund: 0, deliveryCost: 0 },
];

export const orderTotal = (o: ExampleOrder) => o.lines.reduce((n, l) => n + l.qty * l.unitPrice, 0) + o.shippingFee;
const sum = (xs: number[]) => Math.round(xs.reduce((n, x) => n + x, 0) * 100) / 100;
const isRevenue = (o: ExampleOrder) => !NON_REVENUE_ORDER_STATUSES.includes(o.status);
const SHIPPED: OrderStatus[] = ["EXPEDIEE", "LIVREE", "ECHEC", "RETOUR", "REMBOURSEE"];

function compute() {
  const orders = EXAMPLE_ORDERS;
  const revenueOrders = orders.filter(isRevenue);
  const confirmed = orders.filter((o) => o.confirmed).length;
  const wentThrough = orders.filter((o) => o.confirmed || o.attempts > 0).length;
  const shippedOrders = orders.filter((o) => SHIPPED.includes(o.status) || o.shipment !== null);
  const outcomes = countOutcomes(shippedOrders.map((o) => orderDeliveryOutcome(o.status, o.shipment)));
  const inProgress = shippedOrders.length - outcomes.delivered - outcomes.failed - outcomes.returned;
  const finished = outcomes.delivered + outcomes.failed + outcomes.returned;
  const grossRevenue = sum(revenueOrders.map(orderTotal));
  const revenueRefunds = sum(revenueOrders.map((o) => o.refund));

  const products = (["Sac Atlas", "Foulard Rif", "Ceinture Fès"] as ExampleProduct[]).map((product) => {
    const lines = revenueOrders.flatMap((o) => o.lines.filter((l) => l.product === product).map((l) => ({ ...l, ref: o.ref })));
    const units = lines.reduce((n, l) => n + l.qty, 0);
    const revenue = sum(lines.map((l) => l.qty * l.unitPrice));
    const cost = units * EXAMPLE_COSTS[product];
    return { product, units, orders: new Set(lines.map((l) => l.ref)).size, revenue, cost, grossProfit: sum([revenue, -cost]) };
  });
  const cogs = sum(products.map((p) => p.cost));
  const net = netRevenue(grossRevenue, revenueRefunds);
  const expenses = 200;
  const deliveryCost = sum(orders.filter((o) => o.status !== "ANNULEE").map((o) => o.deliveryCost));
  const grossProfit = sum([net, -cogs]);
  const netProfit = sum([grossProfit, -expenses, -deliveryCost]);
  const margin = (p: number) => Math.round((p / net) * 1000) / 10;

  return {
    orders: orders.length,
    pending: orders.filter((o) => o.status === "NOUVELLE").length,
    confirmed,
    wentThroughConfirmation: wentThrough,
    neverCalled: orders.length - wentThrough,
    confirmationRate: confirmationRatePct(confirmed, wentThrough),
    cancelled: orders.filter((o) => o.status === "ANNULEE").length,
    cancelledBeforeConfirmation: orders.filter((o) => o.status === "ANNULEE" && !o.confirmed).length,
    shipped: shippedOrders.length,
    delivered: outcomes.delivered,
    failed: outcomes.failed,
    returned: outcomes.returned,
    inProgress,
    deliveryRate: asPct(deliveryOutcomeRate(outcomes)),
    failureRate: asPct(finished ? outcomes.failed / finished : null),
    returnRate: asPct(finished ? outcomes.returned / finished : null),
    revenueOrders: revenueOrders.length,
    grossRevenue,
    revenueRefunds,
    netRevenue: net,
    averageBasket: averageBasket(grossRevenue, revenueOrders.length),
    unitsSold: revenueOrders.reduce((n, o) => n + o.lines.reduce((m, l) => m + l.qty, 0), 0),
    deliveredRevenue: sum(orders.filter((o) => o.status === "LIVREE").map(orderTotal)),
    returnedValue: sum(orders.filter((o) => o.status === "RETOUR" || o.status === "REMBOURSEE").map(orderTotal)),
    refunded: sum(orders.map((o) => o.refund)),
    shippingFees: sum(revenueOrders.map((o) => o.shippingFee)),
    products,
    productRevenue: sum(products.map((p) => p.revenue)),
    /** CMD-106's return received in the period: 3 Foulard Rif (2 sellable, 1 damaged). */
    returnedUnits: { product: "Foulard Rif" as ExampleProduct, sellable: 2, damaged: 1 },
    finance: { revenue: net, cogs, grossProfit, grossMarginPct: margin(grossProfit), expenses, deliveryCost, netProfit, netMarginPct: margin(netProfit) },
  };
}

export const EXAMPLE = compute();

/** Confirmation attempts of the period, by outcome (11 in all; CMD-102, 108 and 109 add the non-confirming ones). */
export const EXAMPLE_ATTEMPTS = { CONFIRME: 7, PAS_DE_REPONSE: 3, ANNULE: 1 } as const;
export const EXAMPLE_ATTEMPTS_TOTAL = EXAMPLE_ATTEMPTS.CONFIRME + EXAMPLE_ATTEMPTS.PAS_DE_REPONSE + EXAMPLE_ATTEMPTS.ANNULE;

/** Durations (hours) — checked against the server's `durationOf` in the tests. */
export const EXAMPLE_DURATIONS = {
  /** placedAt → confirmedAt of three orders confirmed in the period. */
  confirmation: [2, 6, 1],
  /** confirmedAt → shippedAt of the shipped orders. */
  confirmedToShipped: [20, 28, 24, 16, 22, 34],
  /** shippedAt → deliveredAt of the delivered ones. */
  shippedToDelivered: [48, 72, 36],
} as const;

/** In-store (POS) sales of the period — never mixed with the Online orders above. */
export const EXAMPLE_STORE = {
  sales: [120, 80, 200],
  units: 5,
  /** Refund of a return RECEIVED in the period (whatever the sale's date). */
  refundsReceived: 80,
  byStore: [
    { name: "Magasin Casablanca", sales: 2, gross: 320 },
    { name: "Magasin Rabat", sales: 1, gross: 80 },
  ],
} as const;

/** Commission ledger entries of the period (flat amount per delivered order). */
export const EXAMPLE_COMMISSION = { agent: "Salma (agent fictif)", ratePerOrder: 10, earnedEntries: 3, reversedEntries: 1 } as const;
