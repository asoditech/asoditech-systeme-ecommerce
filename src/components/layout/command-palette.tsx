"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Users, Package, ShoppingCart, LayoutDashboard, Store, Truck, ScanSearch, Printer, PackagePlus } from "lucide-react";
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

const TYPE_ICON = { customer: Users, product: Package, order: ShoppingCart, sale: Store, supplier: Truck } as const;
const ACTION_ICON = { open: Package, trace: ScanSearch, label: Printer, receive: PackagePlus } as const;

export function CommandPalette({ permissions }: { permissions: Set<Permission> }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<QuickSearchResult[]>([]);
  const [isPending, startTransition] = React.useTransition();
  const router = useRouter();

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
    if (query.trim().length < 2) return;
    const timeout = setTimeout(() => {
      startTransition(async () => {
        setResults(await quickSearchAction(query));
      });
    }, 200);
    return () => clearTimeout(timeout);
  }, [query]);
  // Query too short for a server round-trip — don't show stale results from a longer query.
  const visibleResults = query.trim().length >= 2 ? results : [];
  // A product with server-computed actions gets its own group (one row per
  // action, reachable with the arrow keys like any other entry); every other
  // result stays a single row. The actions are already permission-filtered by
  // quickSearchAction, and each target page re-checks on the server.
  const rowResults = visibleResults.filter((r) => !r.actions?.length);
  const productGroups = visibleResults.filter((r) => r.actions?.length);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  const links = QUICK_LINKS.filter((l) =>
    Array.isArray(l.permission) ? l.permission.some((p) => permissions.has(p)) : permissions.has(l.permission)
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
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder="Rechercher un client, un produit, une commande..."
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          {query.trim().length >= 2 && !isPending && visibleResults.length === 0 && (
            <CommandEmpty>Aucun résultat.</CommandEmpty>
          )}
          {productGroups.map((r) => (
            <CommandGroup key={`${r.type}-${r.id}`} heading={`${r.title} · ${r.subtitle}`}>
              {r.actions!.map((a) => {
                const Icon = ACTION_ICON[a.kind];
                return (
                  // Same leading text for every action of the product, so the
                  // palette's own filter keeps (and keeps ordering) the group as one.
                  <CommandItem key={a.kind} value={`${r.title} ${r.subtitle} — ${a.label}`} onSelect={() => go(a.href)}>
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
                  <CommandItem key={`${r.type}-${r.id}`} onSelect={() => go(r.href)}>
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
          {links.length > 0 && (
            <CommandGroup heading="Navigation rapide">
              {links.map((l) => (
                <CommandItem key={l.href} onSelect={() => go(l.href)}>
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
