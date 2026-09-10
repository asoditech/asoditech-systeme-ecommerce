import { describe, expect, it } from "vitest";
import { AI_TOOLS, aiToolsForRole, aiQuestionsForRole } from "@/lib/ai/tools";
import { hasPermission } from "@/lib/auth/permissions";

/**
 * The AI assistant / support widget must never be a way around RBAC: a
 * tool that surfaces money, delivery or customer data is only offered to a
 * role that already holds the matching permission.
 */
describe("aiToolsForRole — RBAC gating of AI questions", () => {
  it("every finance tool carries the finance.view permission", () => {
    const financeIds = ["revenue", "revenue-today", "profit", "profit-today", "marketing-spend", "delivery-spend-month"];
    for (const id of financeIds) {
      const tool = AI_TOOLS.find((t) => t.id === id);
      expect(tool, id).toBeDefined();
      expect(tool!.permission).toBe("finance.view");
    }
  });

  it("gives OWNER / ADMIN every tool", () => {
    expect(aiToolsForRole("OWNER")).toHaveLength(AI_TOOLS.length);
    expect(aiToolsForRole("ADMIN")).toHaveLength(AI_TOOLS.length);
  });

  it("hides finance questions from a CONFIRMATION agent", () => {
    const ids = aiToolsForRole("CONFIRMATION").map((t) => t.id);
    expect(ids).not.toContain("profit-today");
    expect(ids).not.toContain("revenue-today");
    expect(ids).not.toContain("marketing-spend");
    // …but keeps the order questions the role can answer.
    expect(ids).toContain("orders-today");
  });

  it("hides finance and customer questions from a WAREHOUSE user's list", () => {
    const ids = aiToolsForRole("WAREHOUSE").map((t) => t.id);
    expect(ids).not.toContain("profit-today");
    expect(ids).not.toContain("revenue");
    expect(ids).not.toContain("repeat-customers"); // no customers.view
    // WAREHOUSE does hold delivery.view + inventory.view.
    expect(ids).toContain("low-stock");
    expect(ids).toContain("deliveries-in-transit");
  });

  it("gives an ACCOUNTANT the finance questions but not, say, stock", () => {
    const ids = aiToolsForRole("ACCOUNTANT").map((t) => t.id);
    expect(ids).toContain("profit-today");
    expect(ids).not.toContain("low-stock"); // ACCOUNTANT has no inventory.view
  });

  it("aiToolsForRole matches hasPermission for every tool and role", () => {
    const roles = ["OWNER", "ADMIN", "MANAGER", "CONFIRMATION", "WAREHOUSE", "DELIVERY", "SUPPORT", "ACCOUNTANT"] as const;
    for (const role of roles) {
      for (const tool of AI_TOOLS) {
        const allowed = aiToolsForRole(role).some((t) => t.id === tool.id);
        const expected = !tool.permission || hasPermission(role, tool.permission);
        expect(allowed, `${role} / ${tool.id}`).toBe(expected);
      }
    }
  });

  it("aiQuestionsForRole returns a plain {id,label} list with no run closure", () => {
    const questions = aiQuestionsForRole("MANAGER");
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(Object.keys(q).sort()).toEqual(["id", "label"]);
    }
  });
});
