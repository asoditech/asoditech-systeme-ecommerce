import { describe, expect, it } from "vitest";
import { buildDateRangeQuery, dayParam, linkedDayBounds } from "@/lib/date-range-query";

/** A5 — the shared « Du / Au » control's pure rules (URL semantics unchanged). */
describe("dayParam", () => {
  it("keeps only YYYY-MM-DD", () => {
    expect(dayParam("2026-10-12")).toBe("2026-10-12");
    expect(dayParam("12/10/2026")).toBe("");
    expect(dayParam(undefined)).toBe("");
    expect(dayParam("2026-10-12T00:00")).toBe("");
  });
});

describe("linkedDayBounds — « Au » never before « Du »", () => {
  it("links min / max only when the other side is set", () => {
    expect(linkedDayBounds("2026-10-01", "2026-10-31")).toEqual({ fromMax: "2026-10-31", toMin: "2026-10-01" });
    expect(linkedDayBounds("", "2026-10-31")).toEqual({ fromMax: "2026-10-31", toMin: undefined });
    expect(linkedDayBounds("", "")).toEqual({ fromMax: undefined, toMin: undefined });
  });
});

describe("buildDateRangeQuery — same URLs as the former Livraison / période filters", () => {
  it("custom range: range=custom + the page's own param names, empty days dropped", () => {
    expect(buildDateRangeQuery({ range: "custom", from: "2026-10-01", to: "2026-10-31", defaultRange: "all" })).toBe(
      "dateFrom=2026-10-01&dateTo=2026-10-31&range=custom"
    );
    expect(buildDateRangeQuery({ range: "custom", from: "", to: "2026-10-31", defaultRange: "all" })).toBe("dateTo=2026-10-31&range=custom");
    expect(buildDateRangeQuery({ range: "custom", from: "2026-10-01", to: "", defaultRange: "all", fromParam: "from", toParam: "to" })).toBe(
      "from=2026-10-01&range=custom"
    );
  });

  it("presets: the page default is omitted, any other preset is kept; custom days are ignored", () => {
    expect(buildDateRangeQuery({ range: "all", from: "2026-10-01", to: "", defaultRange: "all" })).toBe("");
    expect(buildDateRangeQuery({ range: "7d", from: "2026-10-01", to: "", defaultRange: "all" })).toBe("range=7d");
    expect(buildDateRangeQuery({ range: "all", from: "", to: "", defaultRange: "this-month" })).toBe("range=all");
  });

  it("kept params come first; empty ones are dropped", () => {
    expect(buildDateRangeQuery({ range: "30d", from: "", to: "", defaultRange: "all", keep: { pageSize: "50", aexp: undefined } })).toBe(
      "pageSize=50&range=30d"
    );
  });
});
