import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getDashboardData, isDashboardPeriod } from "@/lib/queries/dashboard";
import { displayOrderRecipient } from "@/lib/format";
import { resetDb } from "../helpers/db";

/**
 * Client feedback #5: the dashboard order lists showed the wrong customer
 * — the shared `Customer.fullName` instead of each order's own
 * `shippingName` snapshot (ADR 0030). Two WooCommerce orders billed under
 * one account must each display their own recipient.
 */
describe("getDashboardData — per-order recipient", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  it("keeps each order's own shippingName, never one shared customer name", async () => {
    const account = await prisma.customer.create({ data: { fullName: "Ayoub (compte)" } });
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: 100, status: "ACTIF" },
    });

    for (const name of ["Mohamed Alaoui", "Sara Bennani"]) {
      await prisma.order.create({
        data: {
          customerId: account.id,
          shippingName: name,
          status: "NOUVELLE",
          subtotal: 100,
          total: 100,
          currency: "MAD",
          placedAt: new Date(),
          items: {
            create: {
              productId: product.id,
              nameSnapshot: "P",
              skuSnapshot: "S",
              unitPrice: 100,
              quantity: 1,
              total: 100,
              costSnapshot: null,
            },
          },
        },
      });
    }

    const data = await getDashboardData("mois");

    const recentNames = data.recentOrders.map((o) => displayOrderRecipient(o)).sort();
    expect(recentNames).toEqual(["Mohamed Alaoui", "Sara Bennani"]);

    const actionNames = data.ordersRequiringAction.map((o) => displayOrderRecipient(o)).sort();
    expect(actionNames).toEqual(["Mohamed Alaoui", "Sara Bennani"]);

    // The shared account name must never be what a row displays.
    expect(recentNames).not.toContain("Ayoub (compte)");
  });

  it("falls back to the customer name for a pre-snapshot order", async () => {
    const account = await prisma.customer.create({ data: { fullName: "Client Historique" } });
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: 50, status: "ACTIF" },
    });
    await prisma.order.create({
      data: {
        customerId: account.id,
        shippingName: null,
        status: "NOUVELLE",
        subtotal: 50,
        total: 50,
        currency: "MAD",
        placedAt: new Date(),
        items: {
          create: {
            productId: product.id,
            nameSnapshot: "P",
            skuSnapshot: "S",
            unitPrice: 50,
            quantity: 1,
            total: 50,
            costSnapshot: null,
          },
        },
      },
    });

    const data = await getDashboardData("mois");
    expect(data.recentOrders.map((o) => displayOrderRecipient(o))).toEqual(["Client Historique"]);
  });
});

/**
 * Dashboard date filter — "Aujourd'hui" / "Hier" alongside the existing
 * month/quarter/year options.
 */
describe("getDashboardData — day-scoped periods", () => {
  beforeEach(async () => await resetDb());
  afterEach(async () => await resetDb());

  async function orderOn(placedAt: Date, total: number) {
    const customer = await prisma.customer.create({ data: { fullName: "C" } });
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: total, cost: 1, status: "ACTIF" },
    });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
        subtotal: total,
        total,
        currency: "MAD",
        placedAt,
        items: {
          create: {
            productId: product.id,
            nameSnapshot: "P",
            skuSnapshot: "S",
            unitPrice: total,
            quantity: 1,
            total,
            costSnapshot: 1,
          },
        },
      },
    });
  }

  it("isDashboardPeriod accepts the known keys and rejects others", () => {
    for (const k of ["jour", "hier", "mois", "trimestre", "annee"]) {
      expect(isDashboardPeriod(k)).toBe(true);
    }
    expect(isDashboardPeriod("semaine")).toBe(false);
    expect(isDashboardPeriod(undefined)).toBe(false);
  });

  it("'jour' counts only today's orders, 'hier' only yesterday's", async () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
    const lastWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 12);

    await orderOn(today, 100);
    await orderOn(yesterday, 200);
    await orderOn(yesterday, 50);
    await orderOn(lastWeek, 999);

    const jour = await getDashboardData("jour");
    expect(jour.finance.ordersCount).toBe(1);
    expect(jour.finance.revenue).toBe(100);

    const hier = await getDashboardData("hier");
    expect(hier.finance.ordersCount).toBe(2);
    expect(hier.finance.revenue).toBe(250);
  });
});
