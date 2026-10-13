import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormActions } from "@/components/form-section";
import { IntegrationsFooter } from "@/components/layout/integrations-footer";

/**
 * Shared form action bar + site footer layout. `<main>` (app-shell) is an
 * `overflow-y-auto` box the window scrolls past, so a sticky `bottom-11`
 * FormActions pinned against main's own bottom and always covered the
 * form's last 44px (measured in the browser: order, product and reception
 * forms). The fixed footer's `md:left-64` left a gap with a collapsed sidebar.
 * jsdom has no layout, so these pin the structure that causes / prevents it.
 */

const rootClasses = (html: string) => (html.match(/^<(\w+)[^>]*class="([^"]*)"/)?.[2] ?? "").split(/\s+/);
const PINNING = /^(?:[a-z0-9]+:)*(?:sticky|fixed|absolute|bottom-|-bottom-|inset-|top-|left-|right-)/;

describe("FormActions", () => {
  // `children: null` only satisfies the props type — the buttons passed below replace it.
  const props: ComponentProps<typeof FormActions> = { context: createElement("span", null, "Total 0,00 MAD"), children: null };
  const html = renderToStaticMarkup(
    createElement(
      FormActions,
      props,
      createElement("button", { type: "button" }, "Annuler"),
      createElement("button", { type: "submit" }, "Créer la commande")
    )
  );

  it("stays in the normal flow: no sticky/fixed positioning or inset that could pin it over the fields above", () => {
    const classes = rootClasses(html);
    expect(classes).toContain("flex");
    expect(classes.filter((c) => PINNING.test(c))).toEqual([]);
  });

  it("keeps its content and action order: context first, then Annuler, then the primary action last", () => {
    expect(html.indexOf("Total 0,00 MAD")).toBeLessThan(html.indexOf("Annuler"));
    expect(html.indexOf("Annuler")).toBeLessThan(html.indexOf("Créer la commande"));
    expect(html).toContain('type="submit"');
  });

  it("still stacks on narrow screens and goes side by side from sm up", () => {
    expect(rootClasses(html)).toEqual(expect.arrayContaining(["flex-col", "sm:flex-row", "sm:justify-between"]));
  });

  it("is still the action bar of the order, product and reception forms (same labels)", () => {
    const consumers: [string, string][] = [
      ["src/components/orders/order-form.tsx", "Créer la commande"],
      ["src/components/products/product-form.tsx", "Créer le produit"],
      ["src/components/purchases/reception-form.tsx", "Créer le brouillon"],
    ];
    for (const [file, label] of consumers) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).toMatch(/import \{[^}]*\bFormActions\b[^}]*\} from "@\/components\/form-section"/);
      expect(source, file).toContain("<FormActions");
      expect(source, file).toContain(label);
    }
  });
});

describe("IntegrationsFooter", () => {
  const classes = rootClasses(renderToStaticMarkup(createElement(IntegrationsFooter)));

  it("is sticky at the bottom of the content column, not fixed with a hard-coded sidebar offset", () => {
    expect(classes).toEqual(expect.arrayContaining(["sticky", "bottom-0"]));
    expect(classes).not.toContain("fixed");
    expect(classes.filter((c) => /(?:^|:)(?:left-|inset-x-|ml-|pl-)/.test(c))).toEqual([]);
  });

  it("is rendered inside the content column (SidebarShell children), after <main>", () => {
    const shell = readFileSync(join(process.cwd(), "src/components/layout/app-shell.tsx"), "utf8");
    const open = shell.indexOf("<SidebarShell");
    const close = shell.indexOf("</SidebarShell>");
    const footer = shell.indexOf("<IntegrationsFooter");
    expect(footer).toBeGreaterThan(shell.indexOf("</main>"));
    expect(footer).toBeGreaterThan(open);
    expect(footer).toBeLessThan(close);
  });
});
