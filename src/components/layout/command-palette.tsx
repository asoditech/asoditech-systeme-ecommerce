"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Users, Package, ShoppingCart, LayoutDashboard } from "lucide-react";
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

const QUICK_LINKS: { label: string; href: string; permission: Permission }[] = [
  { label: "Tableau de bord", href: "/tableau-de-bord", permission: "dashboard.view" },
  { label: "Nouvelle commande", href: "/commandes/nouvelle", permission: "orders.create" },
  { label: "Nouveau client", href: "/clients/nouveau", permission: "customers.create" },
  { label: "Nouveau produit", href: "/produits/nouveau", permission: "products.create" },
];

const TYPE_ICON = { customer: Users, product: Package, order: ShoppingCart } as const;

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

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  const links = QUICK_LINKS.filter((l) => permissions.has(l.permission));

  return (
    <>
      <Button
        variant="outline"
        className="h-8 w-full max-w-64 justify-start gap-2 px-2.5 text-muted-foreground sm:w-64"
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
          {visibleResults.length > 0 && (
            <CommandGroup heading="Résultats">
              {visibleResults.map((r) => {
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
