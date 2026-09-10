import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { runAiToolAction } from "@/actions/ai";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";

describe("runAiToolAction — RBAC enforcement", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("rejects a user without ai.use entirely", async () => {
    await loginAsTestUser({ role: "WAREHOUSE" }); // no ai.use
    await expect(runAiToolAction("orders-today")).rejects.toThrow(/non autorisé/i);
  });

  it("runs an unrestricted-beyond-ai.use tool for a CONFIRMATION agent", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const result = await runAiToolAction("orders-today");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toMatch(/commande/i);
  });

  it("refuses a finance tool for a CONFIRMATION agent — the AI is not a way around finance.view", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const result = await runAiToolAction("profit-today");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/permission/i);
  });

  it("refuses the delivery performance tool for a CONFIRMATION agent", async () => {
    await loginAsTestUser({ role: "CONFIRMATION" });
    const result = await runAiToolAction("deliveries-in-transit");
    expect(result.ok).toBe(false);
  });

  it("runs a finance tool for an OWNER and returns a real figure", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const customer = await prisma.customer.create({ data: { fullName: "Client" } });
    const product = await prisma.product.create({
      data: { name: "P", sku: `S-${Math.random()}`, price: 100, cost: 40, status: "ACTIF" },
    });
    await prisma.order.create({
      data: {
        customerId: customer.id,
        status: "LIVREE",
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
            costSnapshot: 40,
          },
        },
      },
    });

    const result = await runAiToolAction("revenue-today");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answer).toContain("100");
  });

  it("records an ai.query audit event only on an authorised run", async () => {
    const confirmationUser = await loginAsTestUser({ role: "CONFIRMATION" });
    await runAiToolAction("profit-today"); // refused
    const afterRefused = await prisma.auditEvent.count({ where: { action: "ai.query" } });
    expect(afterRefused).toBe(0);

    await runAiToolAction("orders-today"); // allowed
    const events = await prisma.auditEvent.findMany({ where: { action: "ai.query" } });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(confirmationUser.id);
  });

  it("returns a friendly error for an unknown tool id", async () => {
    await loginAsTestUser({ role: "OWNER" });
    const result = await runAiToolAction("nope");
    expect(result.ok).toBe(false);
  });
});
