import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { resetDb } from "../helpers/db";

/**
 * Batch 17 — settings persistence audit. `getReportBusinessInfo` is the one
 * shared resolver every order-number-prefix / low-stock-threshold consumer
 * now reads from (report letterheads, the /commandes pages, the dashboard,
 * the new-product form) — a regression here silently breaks all of them at
 * once, so it gets its own direct coverage.
 */
describe("getReportBusinessInfo", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterEach(async () => {
    await resetDb();
  });

  it("returns safe defaults when the tenant has no BusinessSettings row yet", async () => {
    const info = await getReportBusinessInfo();
    expect(info).toMatchObject({
      companyName: "ASODITECH",
      country: "Maroc",
      currency: "MAD",
      orderNumberPrefix: "CMD",
      lowStockDefaultThreshold: 5,
    });
  });

  it("returns the tenant's persisted orderNumberPrefix and lowStockDefaultThreshold once saved", async () => {
    await prisma.businessSettings.create({
      data: { companyName: "Ma Boutique", orderNumberPrefix: "ORD", lowStockDefaultThreshold: 12 },
    });
    const info = await getReportBusinessInfo();
    expect(info.orderNumberPrefix).toBe("ORD");
    expect(info.lowStockDefaultThreshold).toBe(12);
    expect(info.companyName).toBe("Ma Boutique");
  });

  it("falls back to CMD / 5 for an empty-string or missing prefix/threshold, never blank", async () => {
    await prisma.businessSettings.create({ data: { orderNumberPrefix: "" } });
    const info = await getReportBusinessInfo();
    expect(info.orderNumberPrefix).toBe("CMD");
  });
});
