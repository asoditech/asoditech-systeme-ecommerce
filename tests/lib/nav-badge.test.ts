import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NavBadge } from "@/components/layout/nav-badge";

/** Soft UI sidebar count chip — presentational only, not wired to data (Step 1). */
describe("NavBadge", () => {
  const html = (props: Parameters<typeof NavBadge>[0]) => renderToStaticMarkup(createElement(NavBadge, props));

  it("renders nothing without a positive count", () => {
    for (const count of [undefined, null, 0, -3, Number.NaN]) expect(html({ count })).toBe("");
  });

  it("a rounded-square pastel chip with the count (peach by default), 99+ beyond 99", () => {
    expect(html({ count: 8 })).toMatch(/rounded-lg[^"]*bg-pastel-peach[^>]*>8</);
    expect(html({ count: 3, tone: "green" })).toContain("bg-pastel-green");
    expect(html({ count: 140 })).toContain(">99+<");
  });
});
