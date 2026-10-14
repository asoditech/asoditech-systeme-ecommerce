import { describe, expect, it } from "vitest";
import {
  STORE_CLOCK_TOLERANCE_MS,
  heldOrderPaymentFailure,
  importedPaymentStatus,
  mixedRefundReviewReason,
  placeStoreEvent,
  refundCoverage,
  refundsCoverOrderTotal,
  storeOrderingRefusal,
  storePaymentRefreshNeeded,
  storeShipmentReportIsBehind,
} from "@/lib/integrations/shared/order-sync-rules";
import { hiddenOrderStatusOptions, unshippedFailedOrderProblem } from "@/lib/validation/order";
import { totalRefundedAmount } from "@/lib/integrations/woocommerce/mapper";
import { wcOrderSchema } from "@/lib/integrations/woocommerce/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Pure rules of the 2026-10-14 owner decisions (docs/decisions/order-sync-open-decisions.md). */

const T = new Date("2026-03-01T12:00:00.000Z");
const at = (ms: number) => new Date(T.getTime() + ms);

describe("§4 placeStoreEvent — 2-minute tolerance, inclusive boundaries, UTC epoch comparison", () => {
  it("tolerance is exactly 2 minutes", () => {
    expect(STORE_CLOCK_TOLERANCE_MS).toBe(120_000);
  });

  it.each([
    [-120_001, "stale"],
    [-120_000, "ambiguous"],
    [-1, "ambiguous"],
    [0, "ambiguous"],
    [1, "ambiguous"],
    [120_000, "ambiguous"],
    [120_001, "newer"],
  ] as const)("store − local = %d ms → %s", (diff, placement) => {
    expect(placeStoreEvent(at(diff), T)).toBe(placement);
  });

  it("timezone-independent: the same instant written with another offset compares equal", () => {
    expect(placeStoreEvent(new Date("2026-03-01T13:00:00+01:00"), T)).toBe("ambiguous");
    expect(placeStoreEvent(new Date("2026-03-01T13:02:01+01:00"), T)).toBe("newer");
  });

  it("missing or invalid times are unknown — never guessed", () => {
    expect(placeStoreEvent(null, T)).toBe("unknown");
    expect(placeStoreEvent(T, null)).toBe("unknown");
    expect(placeStoreEvent(new Date("pas-une-date"), T)).toBe("unknown");
  });

  it("never mutates the timestamps it compares", () => {
    const store = at(500_000);
    const local = new Date(T);
    placeStoreEvent(store, local);
    expect(store.getTime()).toBe(T.getTime() + 500_000);
    expect(local.getTime()).toBe(T.getTime());
  });
});

describe("§4 storeOrderingRefusal — stale vs review", () => {
  const confirmed = { status: "CONFIRMEE" as const, confirmedAt: T, cancelledAt: null };
  it("cancellation of a locally confirmed order", () => {
    expect(storeOrderingRefusal("C", "ANNULEE", confirmed, at(-300_000))).toMatchObject({ kind: "stale" });
    expect(storeOrderingRefusal("C", "ANNULEE", confirmed, at(60_000))).toMatchObject({ kind: "review" });
    expect(storeOrderingRefusal("C", "ANNULEE", confirmed, null)).toMatchObject({ kind: "review" });
    expect(storeOrderingRefusal("C", "ANNULEE", confirmed, at(300_000))).toBeNull();
  });
  it("store reopen of a locally cancelled order", () => {
    const cancelled = { status: "ANNULEE" as const, confirmedAt: null, cancelledAt: T };
    expect(storeOrderingRefusal("C", "NOUVELLE", cancelled, at(-300_000))).toMatchObject({ kind: "stale" });
    expect(storeOrderingRefusal("C", "NOUVELLE", cancelled, at(-60_000))).toMatchObject({ kind: "review" });
    expect(storeOrderingRefusal("C", "NOUVELLE", { ...cancelled, cancelledAt: null }, at(300_000))).toMatchObject({ kind: "review" });
    expect(storeOrderingRefusal("C", "NOUVELLE", cancelled, at(300_000))).toBeNull();
  });
  it("no local decision to protect → no refusal", () => {
    expect(storeOrderingRefusal("C", "ANNULEE", { status: "NOUVELLE", confirmedAt: null, cancelledAt: null }, null)).toBeNull();
  });
});

describe("§3 refundsCoverOrderTotal — integer cents, COMPLETE refunds only (filtered by the caller)", () => {
  it.each([
    [100, [100], true],
    [100, [60, 40], true],
    [100, [99.99], false],
    [100, [40], false],
    [100, [], false],
    [0.3, [0.1, 0.2], true], // 0.1 + 0.2 ≠ 0.3 in floats; equal in cents
    ["100.00", ["33.33", "33.33", "33.34"], true],
    [0, [0], false], // nothing paid → nothing to refund
  ] as const)("total %s, refunds %j → %s", (total, refunds, covered) => {
    expect(refundsCoverOrderTotal(total, [...refunds])).toBe(covered);
  });
});

describe("§1 payment failure rules", () => {
  it("new import: refunded wins, then the failure, then paid / pending", () => {
    expect(importedPaymentStatus({ paymentFailed: true, refundedStatus: false, paid: false })).toBe("ECHEC");
    expect(importedPaymentStatus({ paymentFailed: true, refundedStatus: true, paid: false })).toBe("REMBOURSE");
    expect(importedPaymentStatus({ paymentFailed: false, refundedStatus: false, paid: true })).toBe("PAYE");
    expect(importedPaymentStatus({ paymentFailed: false, refundedStatus: false, paid: false })).toBe("EN_ATTENTE");
  });
  it("held order: only EN_ATTENTE becomes ECHEC — never a recorded payment", () => {
    expect(heldOrderPaymentFailure("EN_ATTENTE")).toBe("ECHEC");
    for (const s of ["PAYE", "PARTIELLEMENT_PAYE", "REMBOURSE", "ECHEC"]) expect(heldOrderPaymentFailure(s)).toBeNull();
    expect(storePaymentRefreshNeeded(true, "EN_ATTENTE")).toBe(true);
    expect(storePaymentRefreshNeeded(true, "PAYE")).toBe(false);
    expect(storePaymentRefreshNeeded(false, "EN_ATTENTE")).toBe(false);
  });
  it("legacy guard: only a never-shipped ECHEC is refused", () => {
    expect(unshippedFailedOrderProblem({ status: "ECHEC", shippedAt: null })).toContain("jamais été expédiée");
    expect(unshippedFailedOrderProblem({ status: "ECHEC", shippedAt: T })).toBeNull();
    expect(unshippedFailedOrderProblem({ status: "EN_PREPARATION", shippedAt: null })).toBeNull();
  });
});

describe("§2 store shipment report behind ASODITECH", () => {
  it("at or past shipment: behind; before shipment: not", () => {
    for (const s of ["EXPEDIEE", "LIVREE", "RETOUR", "REMBOURSEE"] as const) expect(storeShipmentReportIsBehind(s)).toBe(true);
    for (const s of ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "ECHEC", "ANNULEE"] as const) expect(storeShipmentReportIsBehind(s)).toBe(false);
  });
});

describe("2026-10-14 bis — refund identity: store vs recorded by hand", () => {
  const store = (amount: number | string) => ({ amount, source: "WOOCOMMERCE" });
  const shopify = (amount: number | string) => ({ amount, source: "SHOPIFY" });
  const manual = (amount: number | string) => ({ amount, source: "INTERNE" });
  it.each([
    ["store only, full", [store(100)], "covered"],
    ["store only, partial", [store(99.99)], "partial"],
    ["manual only, full in parts", [manual(60), manual(40)], "covered"],
    ["store alone covers, manual extra", [shopify(100), manual(30)], "covered"],
    ["manual alone covers, store extra", [store(20), manual(100)], "covered"],
    ["only TOGETHER they reach the total → ambiguous (same money?)", [store(50), manual(50)], "ambiguous"],
    ["together still short → partial", [store(20), manual(30)], "partial"],
    ["cents: 33.33 + 33.33 + 33.34 store rows", [store("33.33"), store("33.33"), store("33.34")], "covered"],
    ["nothing", [], "partial"],
  ] as const)("%s", (_label, refunds, expected) => {
    expect(refundCoverage(100, [...refunds])).toBe(expected);
  });

  it("review reason only when both kinds exist, amounts in cents", () => {
    expect(mixedRefundReviewReason("C", [store(100)])).toBeNull();
    expect(mixedRefundReviewReason("C", [manual(100)])).toBeNull();
    expect(mixedRefundReviewReason("C", [store("0.10"), store("0.20"), manual(5)])).toContain("(0.30)");
    expect(mixedRefundReviewReason("C", [shopify(10), manual(5)])).toContain("même argent");
  });

  it("WooCommerce refunds are summed in cents, each refund id once", () => {
    const wc = (refunds: Array<{ id: number; total: string }>) =>
      wcOrderSchema.parse({ id: 1, number: "1", status: "refunded", date_created: "2026-03-01T11:00:00", total: "1.00", billing: {}, shipping: {}, line_items: [], refunds });
    expect(totalRefundedAmount(wc([{ id: 1, total: "-0.10" }, { id: 2, total: "-0.20" }]))).toBe(0.3);
    expect(totalRefundedAmount(wc([{ id: 1, total: "-40.00" }, { id: 1, total: "-40.00" }, { id: 2, total: "-60.00" }]))).toBe(100);
  });
});

describe("2026-10-14 bis — failed payment later paid: bulk refresh", () => {
  it("held ECHEC + store paid → refresh only with the opt-in on; a failure snapshot never counts as paid", () => {
    expect(storePaymentRefreshNeeded(false, "ECHEC", { storeReportsPaid: true, autoPaymentFromStore: true })).toBe(true);
    expect(storePaymentRefreshNeeded(false, "ECHEC", { storeReportsPaid: true, autoPaymentFromStore: false })).toBe(false);
    expect(storePaymentRefreshNeeded(false, "PAYE", { storeReportsPaid: true, autoPaymentFromStore: true })).toBe(false);
    expect(storePaymentRefreshNeeded(true, "ECHEC", { storeReportsPaid: true, autoPaymentFromStore: true })).toBe(false);
  });
});

describe("2026-10-14 bis — « Emballage » hidden for a legacy never-shipped ECHEC without reservation", () => {
  it("hidden only when never shipped AND nothing reserved", () => {
    expect(hiddenOrderStatusOptions({ status: "ECHEC", shippedAt: null }, 0)).toEqual(["EN_PREPARATION"]);
    expect(hiddenOrderStatusOptions({ status: "ECHEC", shippedAt: null }, 2)).toEqual([]);
    expect(hiddenOrderStatusOptions({ status: "ECHEC", shippedAt: T }, 0)).toEqual([]);
    expect(hiddenOrderStatusOptions({ status: "NOUVELLE", shippedAt: null }, 0)).toEqual([]);
  });

  it("the order page passes it to the status menu, which filters its options (server guard unchanged)", () => {
    const page = readFileSync(join(process.cwd(), "src/app/(protected)/commandes/[id]/page.tsx"), "utf8");
    const control = readFileSync(join(process.cwd(), "src/components/orders/order-status-control.tsx"), "utf8");
    expect(page).toMatch(/hiddenOrderStatusOptions\([\s\S]{0,200}orderReservedUnits\(prisma, order\.id\)/);
    expect(page).toMatch(/hiddenStatuses=\{hiddenStatuses\}/);
    expect(control).toMatch(/ORDER_STATUS_TRANSITIONS\[currentStatus\]\.filter\(\(s\) => !hiddenStatuses\.includes\(s\)\)/);
  });
});
