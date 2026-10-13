import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
const { WooCommerceStoreSettings } = await import("@/components/integrations/woocommerce-store-settings");

/** The two per-connection choices on the WooCommerce card: wording, defaults, consequences. */
describe("WooCommerce card — remote deletion and inventory owner settings", () => {
  const render = (remoteDeletionMode: "manual" | "auto", inventoryOwner: "ASODITECH" | "STORE") =>
    renderToStaticMarkup(createElement(WooCommerceStoreSettings, { remoteDeletionMode, inventoryOwner }));
  const checked = (html: string) =>
    [...html.matchAll(/<input [^>]*>/g)].map((m) => m[0]).filter((tag) => tag.includes('checked=""')).map((tag) => tag.match(/value="([^"]+)"/)?.[1]);

  it("shows both questions with their French options, the current choices checked", () => {
    const html = render("manual", "ASODITECH");
    expect(html).toContain("Que faire lorsqu’un produit est supprimé de la boutique ?");
    expect(html).toContain("Me demander avant de dissocier");
    expect(html).toContain("Dissocier automatiquement");
    expect(html).toContain("Qui gère le stock des produits importés ?");
    expect(html).toContain("Ma boutique en ligne");
    expect(checked(html)).toEqual(["manual", "ASODITECH"]);
    expect(checked(render("auto", "STORE"))).toEqual(["auto", "STORE"]);
  });

  it("explains the consequences: product and history kept, automatic only on confirmed deletion, no stock rewritten", () => {
    const html = render("manual", "ASODITECH");
    expect(html).toContain("uniquement quand la boutique confirme que le produit n&#x27;existe plus");
    expect(html).toContain("son stock, ses mouvements et ses commandes sont conservés");
    expect(html).toContain("ne supprime, ne remet à zéro et ne modifie aucun stock existant");
  });

  it("is rendered on the card for integrations.manage only, from the fail-safe readers", () => {
    const card = readFileSync(join(process.cwd(), "src/components/integrations/woocommerce-card.tsx"), "utf8");
    expect(card).toContain("<WooCommerceStoreSettings remoteDeletionMode={remoteDeletionModeOf(config)} inventoryOwner={inventoryOwnerOf(config)} />");
    expect(card.slice(card.indexOf("{canManage && hasCredentials && ("), card.indexOf("<WooCommerceStoreSettings"))).not.toContain(")}");
  });
});
