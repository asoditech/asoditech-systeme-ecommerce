import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { cityMatchKey, filterCities } from "@/lib/delivery-cities";
import { CityInput } from "@/components/delivery/city-input";

/**
 * City field UI polish — pure filtering + form compatibility (no database).
 * The data side (which carrier, cache, free-text fallback) is covered by
 * tests/actions/delivery-city-suggestions.test.ts and is unchanged.
 */

const CITIES = ["Agadir", "Casablanca", "Fès", "Kénitra", "Rabat", "Salé", "Tanger", "Témara", "Tétouan"];

describe("filterCities", () => {
  it("empty query → the list as is (capped)", () => {
    expect(filterCities(CITIES, "")).toEqual(CITIES);
    expect(filterCities(CITIES, "  ", 3)).toEqual(["Agadir", "Casablanca", "Fès"]);
  });
  it("accent- and case-insensitive; names starting with the text come first", () => {
    expect(filterCities(CITIES, "fes")).toEqual(["Fès"]);
    expect(filterCities(CITIES, "te")).toEqual(["Témara", "Tétouan"]);
    expect(filterCities(CITIES, "ra")).toEqual(["Rabat", "Kénitra", "Témara"]); // starts-with first, then contains
    expect(filterCities(CITIES, "SAL")).toEqual(["Salé"]);
  });
  it("no match → empty (the UI then shows « Aucune ville trouvée » and keeps the typed text)", () => {
    expect(filterCities(CITIES, "Paris")).toEqual([]);
  });
  it("never renders more than the limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => `Ville ${i}`);
    expect(filterCities(many, "ville")).toHaveLength(50);
  });
  it("match key strips accents and case", () => {
    expect(cityMatchKey("  Témara ")).toBe("temara");
  });
});

describe("CityInput — same form value as before", () => {
  it("uncontrolled: keeps the field name and initial value (customer form / shipping-address dialog)", () => {
    const html = renderToStaticMarkup(createElement(CityInput, { id: "city", name: "city", defaultValue: "Rabat" }));
    expect(html).toContain('name="city"');
    expect(html).toContain('value="Rabat"');
    expect(html).toContain('id="city"');
  });
  it("controlled: shows the given value (order form); no dropdown before the city list is known", () => {
    const html = renderToStaticMarkup(createElement(CityInput, { id: "ord-city", value: "Fès", onValueChange: () => {} }));
    expect(html).toContain('value="Fès"');
    expect(html).not.toContain('role="listbox"');
    expect(html).not.toContain('role="combobox"');
  });
});
