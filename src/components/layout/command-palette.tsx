"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Users, Package, ShoppingCart, LayoutDashboard, Store, Truck, ScanSearch, Printer, PackagePlus, Undo2, FileText, Radar } from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { quickSearchAction, type QuickSearchResult } from "@/actions/search";
import type { Permission } from "@/lib/auth/permissions";
import { createLatestGate } from "@/lib/latest-request";
import { normalizeForSearch } from "@/lib/navigation/page-search";

const QUICK_LINKS: { label: string; href: string; permission: Permission | Permission[] }[] = [
  { label: "Tableau de bord", href: "/tableau-de-bord", permission: "dashboard.view" },
  // Visible to either side (docs/adr/0038/0040): a user who can only create
  // one of the two (e.g. an Offline-only seller) still sees this entry, and
  // the page itself skips the choice for them — see /operations/nouvelle.
  { label: "Nouvelle opération", href: "/operations/nouvelle", permission: ["orders.create", "sales.create"] },
  { label: "File de confirmation", href: "/confirmation", permission: "orders.confirm" },
  { label: "Nouveau client", href: "/clients/nouveau", permission: "customers.create" },
  { label: "Nouveau produit", href: "/produits/nouveau", permission: "products.create" },
];

const TYPE_ICON = { customer: Users, product: Package, order: ShoppingCart, sale: Store, supplier: Truck, return: Undo2, page: FileText, shipment: Radar } as const;

/**
 * The quick links shown for a query — the server results are already
 * matched (cmdk's own filter is OFF, see below), so these few static entries
 * are matched here, ignoring case and accents. No query → all of them.
 */
function matchQuickLinks<T extends { label: string }>(links: readonly T[], query: string): T[] {
  const q = normalizeForSearch(query);
  return q ? links.filter((l) => normalizeForSearch(l.label).includes(q)) : [...links];
}
const ACTION_ICON = { open: Package, trace: ScanSearch, label: Printer, receive: PackagePlus } as const;

export function CommandPalette({ permissions }: { permissions: Set<Permission> }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<QuickSearchResult[]>([]);
  const [isPending, startTransition] = React.useTransition();
  const router = useRouter();
  // Only the newest query's answer is ever shown (src/lib/latest-request.ts).
  const gate = React.useRef(createLatestGate());

  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  React.useEffect(() => {
    // Closed dialog or query too short: drop any answer still in flight.
    if (!open || query.trim().length < 2) {
      gate.current.cancel();
      return;
    }
    const timeout = setTimeout(() => {
      const ticket = gate.current.next();
      startTransition(async () => {
        const found = await quickSearchAction(query);
        if (gate.current.isLatest(ticket)) setResults(found);
      });
    }, 200);
    return () => clearTimeout(timeout);
  }, [query, open]);
  // Query too short for a server round-trip — don't show stale results from a longer query.
  const visibleResults = query.trim().length >= 2 ? results : [];
  // A product with server-computed actions gets its own group (one row per
  // action, reachable with the arrow keys like any other entry); every other
  // result stays a single row. The actions are already permission-filtered by
  // quickSearchAction, and each target page re-checks on the server.
  const rowResults = visibleResults.filter((r) => !r.actions?.length && r.type !== "page" && r.type !== "shipment");
  const pageResults = visibleResults.filter((r) => r.type === "page");
  const shipmentResults = visibleResults.filter((r) => r.type === "shipment");
  const productGroups = visibleResults.filter((r) => r.actions?.length);

  function go(href: string) {
    gate.current.cancel();
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  const links = matchQuickLinks(
    QUICK_LINKS.filter((l) => (Array.isArray(l.permission) ? l.permission.some((p) => permissions.has(p)) : permissions.has(l.permission))),
    query
  );

  return (
    <>
      {/* Icon-only on narrow screens (a full-width search bar here would
          crowd out the theme toggle/notification bell next to it) — the
          full search-bar-with-label form only appears from `sm:` up. */}
      <Button
        variant="outline"
        size="icon"
        className="shrink-0 text-muted-foreground sm:hidden"
        onClick={() => setOpen(true)}
        aria-label="Rechercher"
      >
        <Search className="size-4" />
      </Button>
      <Button
        variant="outline"
        className="hidden h-8 w-64 shrink-0 justify-start gap-2 px-2.5 text-muted-foreground sm:flex"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span className="text-sm">Rechercher...</span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium sm:inline-block">
          ⌘K
        </kbd>
      </Button>
      {/* shouldFilter={false}: every server result is already a match — some
          by a field the row doesn't show (customer e-mail, sale barcode,
          variation SKU…), which cmdk's own text filter would wrongly hide. */}
      <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
        <CommandInput
          placeholder="Rechercher une page, un client, un produit, une commande, un n° de suivi…"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {query.trim().length >= 2 && isPending && (
            <p className="px-3 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
              Recherche…
            </p>
          )}
          {query.trim().length >= 2 && !isPending && visibleResults.length === 0 && (
            <CommandEmpty>Aucun résultat.</CommandEmpty>
          )}
          {pageResults.length > 0 && (
            <CommandGroup heading="Pages">
              {pageResults.map((r) => (
                <CommandItem key={`page-${r.href}`} value={`page ${r.href}`} onSelect={() => go(r.href)}>
                  <FileText className="size-4" />
                  <span>{r.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.subtitle}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {productGroups.map((r) => (
            <CommandGroup key={`${r.type}-${r.id}`} heading={`${r.title} · ${r.subtitle}`}>
              {r.actions!.map((a) => {
                const Icon = ACTION_ICON[a.kind];
                return (
                  // A unique value per row: cmdk tracks the highlighted row by it.
                  <CommandItem key={a.kind} value={`${r.type}-${r.id}-${a.kind}`} onSelect={() => go(a.href)}>
                    <Icon className="size-4" />
                    <span>{a.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ))}
          {rowResults.length > 0 && (
            <CommandGroup heading="Résultats">
              {rowResults.map((r) => {
                const Icon = TYPE_ICON[r.type];
                return (
                  <CommandItem key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}`} onSelect={() => go(r.href)}>
                    <Icon className="size-4" />
                    <div className="flex flex-col">
                      <span>{r.title}</span>
                      <span className="text-xs text-muted-foreground">{r.subtitle}</span>
                    </div>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          )}
          {shipmentResults.length > 0 && (
            <CommandGroup heading="Expéditions">
              {shipmentResults.map((r) => (
                <CommandItem key={`shipment-${r.id}`} value={`shipment-${r.id}`} onSelect={() => go(r.href)}>
                  <Radar className="size-4" />
                  <div className="flex flex-col">
                    <span>{r.title}</span>
                    <span className="text-xs text-muted-foreground">{r.subtitle}</span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {links.length > 0 && (
            <CommandGroup heading="Navigation rapide">
              {links.map((l) => (
                <CommandItem key={l.href} value={`link ${l.href}`} onSelect={() => go(l.href)}>
                  <LayoutDashboard className="size-4" />
                  {l.label}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
