import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getDashboardData } from "@/lib/queries/dashboard";
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
