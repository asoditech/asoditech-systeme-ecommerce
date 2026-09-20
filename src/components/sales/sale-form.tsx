"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ScanBarcode, Trash2, AlertTriangle } from "lucide-react";
import { createSaleAction, lookupForSaleAction, type SaleLookupResult } from "@/actions/sales";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/** True below Tailwind's `sm` breakpoint. Server/first render = false (no hydration mismatch). */
function useNarrowScreen() {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia("(max-width: 639px)");
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    },
    () => window.matchMedia("(max-width: 639px)").matches,
    () => false
  );
}

interface Line {
  key: string;
  productId: string;
  variationId: string | null;
  label: string;
  sku: string;
  quantity: number;
  /** Catalogue price the server would use; sent only when the seller changed it. */
  defaultPrice: number;
  unitPrice: number;
  discount: number;
  available: number;
}
interface Pay {
  key: string;
  method: string;
  amount: number;
}

/**
 * In-store sale screen (docs/adr/0040): scan or type a barcode / reference /
 * name, adjust quantity, take payment, confirm. The server re-resolves every
 * price, re-checks AVAILABLE stock (on-hand − reserved) under a row lock and
 * rejects the whole sale atomically if anything is short — this screen's
 * availability numbers are guidance, never the authority. One idempotency key
 * per sale attempt makes a double-click or retry create ONE sale.
 */
export function SaleForm({
  channels,
  locationsByChannel,
  canOverridePrice,
}: {
  channels: { id: string; name: string }[];
  locationsByChannel: Record<string, { id: string; name: string }[]>;
  canOverridePrice: boolean;
}) {
  const router = useRouter();
  const narrow = useNarrowScreen();
  const [isPending, startTransition] = useTransition();
  const idempotencyKey = useRef<string>(crypto.randomUUID());
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [warehouseId, setWarehouseId] = useState(locationsByChannel[channels[0]?.id ?? ""]?.[0]?.id ?? "");
  const [customerLabel, setCustomerLabel] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SaleLookupResult[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [payments, setPayments] = useState<Pay[]>([]);

  const locations = locationsByChannel[channelId] ?? [];
  const total = lines.reduce((s, l) => s + Math.max(0, l.unitPrice * l.quantity - l.discount), 0);
  const paid = payments.reduce((s, p) => s + p.amount, 0);

  function addUnit(h: SaleLookupResult) {
    if (!h.tracked) return toast.error("Cet article n'est pas suivi en stock à cet emplacement.");
    if (h.available <= 0) return toast.error("Aucun stock disponible pour cet article.");
    const u = h.unit;
    const key = u.variationId ? `v:${u.variationId}` : `p:${u.productId}`;
    setLines((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        if (existing.quantity + 1 > h.available) {
          toast.error(`Stock disponible : ${h.available}.`);
          return prev;
        }
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key, productId: u.productId, variationId: u.variationId, label: `${u.name}${u.variantLabel ? ` — ${u.variantLabel}` : ""}`, sku: u.sku, quantity: 1, defaultPrice: u.price, unitPrice: u.price, discount: 0, available: h.available }];
    });
    setHits([]);
    setQuery("");
  }

  async function search() {
    if (!query.trim() || !channelId || !warehouseId) return;
    const found = await lookupForSaleAction({ query, salesChannelId: channelId, warehouseId });
    if (found.length === 0) return toast.error("Aucun article trouvé sur ce canal.");
    // A scanner types the code then presses Enter → exact hit goes straight into the cart.
    if (found.length === 1 && found[0].unit.matchedBy !== "partial") addUnit(found[0]);
    else setHits(found);
  }

  function submit() {
    if (lines.length === 0) return toast.error("Ajoutez au moins un article.");
    if (Math.abs(paid - total) > 0.005) return toast.error("Le total des paiements doit être égal au total de la vente.");
    startTransition(async () => {
      const r = await createSaleAction({
        salesChannelId: channelId,
        warehouseId,
        idempotencyKey: idempotencyKey.current,
        customerLabel,
        lines: lines.map((l) => ({
          productId: l.variationId ? null : l.productId,
          variationId: l.variationId,
          quantity: l.quantity,
          // Only send a price when the seller changed it — otherwise the server decides.
          unitPrice: l.unitPrice !== l.defaultPrice ? l.unitPrice : null,
          discount: l.discount,
        })),
        payments: payments.map((p) => ({ method: p.method as "ESPECES", amount: p.amount })),
      });
      if (r.ok) {
        toast.success(r.data.duplicate ? "Vente déjà enregistrée." : "Vente enregistrée.");
        idempotencyKey.current = crypto.randomUUID();
        router.push(`/ventes/${r.data.id}`);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <div className="grid gap-4 pb-14 sm:pb-0 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-4">
        <Card>
          <CardContent className="grid gap-3 pt-6 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sale-channel">Canal</Label>
              <select
                id="sale-channel"
                className={selectClass}
                value={channelId}
                onChange={(e) => {
                  setChannelId(e.target.value);
                  setWarehouseId(locationsByChannel[e.target.value]?.[0]?.id ?? "");
                  setLines([]);
                }}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sale-wh">Emplacement</Label>
              <select id="sale-wh" className={selectClass} value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines([]); }}>
                {locations.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sale-customer">Client (optionnel)</Label>
              <Input id="sale-customer" value={customerLabel} onChange={(e) => setCustomerLabel(e.target.value)} placeholder="Passage" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-[15px]">Articles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={narrow ? "Code-barres, réf., nom…" : "Scanner un code-barres ou saisir référence / nom…"}
                aria-label="Rechercher un article"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void search();
                  }
                }}
              />
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={search}>
                <ScanBarcode className="size-4" />
                Chercher
              </Button>
            </div>
            {hits.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {hits.map((h) => (
                  <li key={`${h.unit.productId}-${h.unit.variationId}`}>
                    <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-50" disabled={!h.tracked || h.available <= 0} onClick={() => addUnit(h)}>
                      <span>
                        {h.unit.name}
                        {h.unit.variantLabel && <span className="text-muted-foreground"> — {h.unit.variantLabel}</span>}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">{h.unit.primaryBarcode ?? h.unit.sku}</span>
                      </span>
                      <span className="text-xs">
                        {h.tracked ? `${h.available} dispo · ${formatCurrency(String(h.unit.price))}` : "non suivi ici"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {lines.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Le panier est vide.</p>
            ) : (
              <div className="divide-y rounded-md border">
                {lines.map((l) => (
                  <div key={l.key} className="grid items-center gap-2 p-3 sm:grid-cols-[1fr_6rem_8rem_7rem_2rem]">
                    <div>
                      <div className="text-sm font-medium">{l.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">{l.sku} · dispo {l.available}</div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2 sm:contents">
                      <div className="space-y-1">
                        <span className="block text-[11px] text-muted-foreground sm:hidden">Quantité</span>
                        <Input type="number" min={1} max={l.available} value={l.quantity} aria-label="Quantité" onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(x.available, Math.max(1, Number(e.target.value) || 1)) } : x)))} />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-[11px] text-muted-foreground sm:hidden">Prix unitaire</span>
                        <Input type="number" min={0} step="0.01" value={l.unitPrice} disabled={!canOverridePrice} aria-label="Prix unitaire" title={canOverridePrice ? undefined : "Modification du prix non autorisée"} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, unitPrice: Math.max(0, Number(e.target.value) || 0) } : x)))} />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-[11px] text-muted-foreground sm:hidden">Remise</span>
                        <Input type="number" min={0} step="0.01" value={l.discount} disabled={!canOverridePrice} aria-label="Remise" placeholder="Remise" title={canOverridePrice ? undefined : "Remise non autorisée"} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, discount: Math.max(0, Number(e.target.value) || 0) } : x)))} />
                      </div>
                    </div>
                    <Button type="button" variant="ghost" size="icon" className="justify-self-end sm:justify-self-auto" aria-label="Retirer" onClick={() => setLines((p) => p.filter((x) => x.key !== l.key))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-[15px]">Paiement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-baseline justify-between gap-2 pr-10 sm:pr-0">
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="text-xl font-semibold tabular-nums sm:text-2xl">{formatCurrency(String(total))}</span>
          </div>
          {payments.map((p) => (
            <div key={p.key} className="flex gap-2">
              <select className={selectClass} value={p.method} onChange={(e) => setPayments((prev) => prev.map((x) => (x.key === p.key ? { ...x, method: e.target.value } : x)))}>
                {Object.entries(CASH_PAYMENT_METHOD_LABELS).map(([k, lab]) => (
                  <option key={k} value={k}>{lab}</option>
                ))}
              </select>
              <Input type="number" min={0} step="0.01" value={p.amount} aria-label="Montant" onChange={(e) => setPayments((prev) => prev.map((x) => (x.key === p.key ? { ...x, amount: Math.max(0, Number(e.target.value) || 0) } : x)))} />
              <Button type="button" variant="ghost" size="icon" aria-label="Retirer le paiement" onClick={() => setPayments((prev) => prev.filter((x) => x.key !== p.key))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={total <= 0} onClick={() => setPayments([{ key: crypto.randomUUID(), method: "ESPECES", amount: total }])}>
              Tout en espèces
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPayments((p) => [...p, { key: crypto.randomUUID(), method: "CARTE", amount: Math.max(0, total - paid) }])}>
              + Paiement
            </Button>
          </div>
          {Math.abs(paid - total) > 0.005 && lines.length > 0 && (
            <p className="flex items-center gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="size-3.5" />
              Reste à encaisser : {formatCurrency(String(total - paid))}
            </p>
          )}
          <Button type="button" className="w-full" size="lg" disabled={isPending || lines.length === 0} onClick={submit}>
            {isPending ? "Enregistrement..." : "Valider la vente"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
