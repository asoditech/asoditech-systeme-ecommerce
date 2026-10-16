"use client";

import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ScanBarcode, Trash2, AlertTriangle, ShoppingBasket, Banknote, Plus, CheckCircle2 } from "lucide-react";
import { UnitPickList } from "@/components/catalog/unit-pick-list";
import { useListboxNavigation } from "@/components/ui/use-listbox-navigation";
import { addPickedUnit, keepListAfterPick, unitLineKey, unitLineLabel, type PickSource } from "@/lib/catalog/picker-session";
import { createSaleAction, explainSaleScanMissAction, searchForSaleAction, type SaleCustomer, type SaleLookupResult } from "@/actions/sales";
import { scanCodeForMessage, withScanHint } from "@/lib/catalog/scan-input";
import { SaleCustomerPicker } from "@/components/sales/sale-customer-picker";
import { SALE_LOOKUP_MESSAGES } from "@/lib/sales/lookup-errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { BarcodeScanButton } from "@/components/barcode-scanner/barcode-scan-button";
import { LOOKUP_SCAN_FORMATS } from "@/lib/barcode-scanner/support";
import { useDismissOnOutside } from "@/lib/use-dismiss-on-outside";
import { formatCurrency } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";


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
  // null = « Passage » (walk-in, no customer record).
  const [customer, setCustomer] = useState<SaleCustomer | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SaleLookupResult[]>([]);
  // true while `hits` holds the empty-query initial list (see `browse`).
  const [browsing, setBrowsing] = useState(false);
  // Bumped on every dismissal, so a late initial-list response is dropped.
  const browseSeq = useRef(0);
  function closeBrowse() {
    browseSeq.current += 1;
    if (!browsing) return;
    setBrowsing(false);
    setHits([]);
  }
  // A press outside the field + list (or Escape) hides the list — initial list or search results.
  const pickerRef = useRef<HTMLDivElement>(null);
  useDismissOnOutside(pickerRef, hits.length > 0 || browsing, () => {
    browseSeq.current += 1;
    setBrowsing(false);
    setHits([]);
  });
  const [lines, setLines] = useState<Line[]>([]);
  const [payments, setPayments] = useState<Pay[]>([]);

  const locations = locationsByChannel[channelId] ?? [];
  const total = lines.reduce((s, l) => s + Math.max(0, l.unitPrice * l.quantity - l.discount), 0);
  const paid = payments.reduce((s, p) => s + p.amount, 0);

  // Shared picking session (src/lib/catalog/picker-session.ts, docs/adr/0061):
  // a click / keyboard pick keeps the list and the query (several articles in
  // a row, like the order form); a scan clears them for the next scan. Same
  // article again → +1, capped at the available stock (the sale's own rule).
  function closeList() {
    browseSeq.current += 1;
    setBrowsing(false);
    setHits([]);
    setQuery("");
  }

  function addUnit(h: SaleLookupResult, source: PickSource = "scan") {
    if (!h.tracked) return toast.error("Cet article n'est pas suivi en stock à cet emplacement.");
    if (h.available <= 0) return toast.error("Aucun stock disponible pour cet article.");
    const u = h.unit;
    const key = unitLineKey(u);
    const next = addPickedUnit(
      lines,
      key,
      () => ({ key, productId: u.productId, variationId: u.variationId, label: unitLineLabel(u), sku: u.sku, quantity: 1, defaultPrice: u.price, unitPrice: u.price, discount: 0, available: h.available }),
      { max: h.available }
    );
    if (next.outcome === "at_max") toast.error(`Stock disponible : ${h.available}.`);
    else setLines(next.lines);
    if (!keepListAfterPick(source)) closeList();
  }

  const unitNav = useListboxNavigation({
    id: "sale-unit",
    count: hits.length,
    onSelect: (i) => {
      const h = hits[i];
      if (h) addUnit(h, "keyboard");
    },
    onClose: () => closeList(),
  });

  // Search as you type (2+ characters, debounced) — same as the order form's
  // picker: shows matching articles, never adds one by itself; silent on
  // errors (Enter / « Chercher » report them).
  const liveSeq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !channelId || !warehouseId) return;
    const seq = ++liveSeq.current;
    const t = setTimeout(() => {
      searchForSaleAction({ query: q, salesChannelId: channelId, warehouseId })
        .then((r) => {
          if (r.ok && seq === liveSeq.current) setHits(r.data);
        })
        .catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query, channelId, warehouseId]);

  // `code` lets a caller (the camera scanner) feed a value straight through
  // without waiting on `setQuery`'s next render — the EXACT same lookup
  // (`lookupForSaleAction`) a hardware scanner's Enter key or the
  // "Chercher" button already use, never a second implementation.
  // One guarded entry point for both the typed/scanned search and the initial
  // list: an access problem is SHOWN (never hidden), a stale page asks for a
  // reload — the page itself never crashes on a failed lookup.
  async function runLookup(q: string): Promise<SaleLookupResult[] | null> {
    try {
      const result = await searchForSaleAction({ query: q, salesChannelId: channelId, warehouseId });
      if (!result.ok) {
        toast.error(result.error, { duration: 10_000 });
        return null;
      }
      return result.data;
    } catch {
      toast.error(SALE_LOOKUP_MESSAGES.stale, {
        duration: 15_000,
        action: { label: "Recharger", onClick: () => window.location.reload() },
      });
      return null;
    }
  }

  async function search(code?: string) {
    const q = (code ?? query).trim();
    if (!q) return;
    if (!channelId || !warehouseId) return toast.error("Choisissez un canal et un emplacement avant de scanner.");
    // Empty the field at once: a scanner's next code must never be appended
    // to this one (unknown code, no stock, slow lookup…). A typed search
    // that opens a pick list gets its text back below.
    liveSeq.current += 1; // supersedes a pending live search
    setQuery("");
    const found = await runLookup(q);
    if (!found) return;
    if (found.length === 0) return void notFound(q);
    // A scanner types the code then presses Enter → exact hit goes straight into the cart.
    if (found.length === 1 && found[0].unit.matchedBy !== "partial") addUnit(found[0], "scan");
    else {
      setQuery((current) => (current === "" ? q : current));
      setHits(found);
    }
  }

  // Nothing matched: say WHY when it is known — the code designates an article
  // this channel may not sell (server, tenant-scoped), or the code itself
  // looks garbled (keyboard layout, scanner prefix, web QR…: scan-input.ts).
  // The scanner DID read something: never reported as a scanner failure.
  async function notFound(q: string) {
    const shown = scanCodeForMessage(q);
    let detail = "";
    try {
      const r = await explainSaleScanMissAction({ query: q, salesChannelId: channelId, warehouseId });
      if (r.ok) detail = r.data.message;
    } catch {
      // the detail is optional — the base message below is still shown
    }
    toast.error(detail ? `Code reçu « ${shown} » : ${detail}` : withScanHint(`Aucun article trouvé sur ce canal pour le code reçu « ${shown} ».`, q), {
      duration: 10_000,
    });
  }

  // Initial list: clicking the EMPTY field (or ArrowDown) shows the first
  // sellable units of the selected channel/location — never on autofocus, so
  // a scanner-first counter still opens on a quiet, focused field. Typing,
  // adding an item or changing channel/location dismisses it; Enter /
  // « Chercher » keep the unchanged search above.
  async function browse() {
    if (query.trim() || !channelId || !warehouseId || hits.length > 0) return;
    const seq = ++browseSeq.current;
    setBrowsing(true);
    const found = await runLookup("");
    if (seq !== browseSeq.current) return; // dismissed (typing / context change) while loading
    if (!found) {
      setBrowsing(false);
      return;
    }
    if (found.length === 0) {
      setBrowsing(false);
      return toast.info("Aucun article disponible sur ce canal.");
    }
    setHits(found);
  }

  function onCameraDetect(code: string) {
    setQuery(code);
    void search(code);
  }

  function submit() {
    if (lines.length === 0) return toast.error("Ajoutez au moins un article.");
    if (Math.abs(paid - total) > 0.005) return toast.error("Le total des paiements doit être égal au total de la vente.");
    startTransition(async () => {
      const r = await createSaleAction({
        salesChannelId: channelId,
        warehouseId,
        idempotencyKey: idempotencyKey.current,
        customerId: customer?.id ?? null,
        customerLabel: customer?.fullName ?? "",
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
          <CardHeader>
            <CardTitle accent="blue">Point de vente</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="sale-channel">Canal</Label>
              <NativeSelect
                id="sale-channel"
                value={channelId}
                onChange={(e) => {
                  setChannelId(e.target.value);
                  setWarehouseId(locationsByChannel[e.target.value]?.[0]?.id ?? "");
                  setLines([]);
                  closeBrowse();
                }}
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sale-wh">Emplacement</Label>
              <NativeSelect id="sale-wh" value={warehouseId} onChange={(e) => { setWarehouseId(e.target.value); setLines([]); closeBrowse(); }}>
                {locations.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sale-customer">Client (optionnel)</Label>
              <SaleCustomerPicker value={customer} onChange={setCustomer} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle accent="peach">Articles</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div ref={pickerRef} className="space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  // New text = no highlighted row: Enter then means search / scan.
                  unitNav.reset();
                  closeBrowse();
                }}
                onClick={() => void browse()}
                placeholder={narrow ? "Code-barres, réf., nom…" : "Scanner un code-barres ou saisir référence / nom…"}
                aria-label="Rechercher un article"
                role={unitNav.inputProps.role}
                aria-expanded={hits.length > 0}
                aria-controls={unitNav.inputProps["aria-controls"]}
                aria-autocomplete={unitNav.inputProps["aria-autocomplete"]}
                aria-activedescendant={unitNav.inputProps["aria-activedescendant"]}
                onKeyDown={(e) => {
                  // Shared listbox navigation first (same as the order form).
                  if (hits.length > 0) {
                    unitNav.inputProps.onKeyDown(e);
                    if (e.defaultPrevented) return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    closeBrowse();
                    // The field's own value: a code scanned before hydration is in the DOM, not yet in state.
                    void search(e.currentTarget.value);
                  } else if (e.key === "ArrowDown") {
                    void browse();
                  }
                }}
              />
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={() => void search()}>
                <ScanBarcode className="size-4" />
                Chercher
              </Button>
              <BarcodeScanButton formats={LOOKUP_SCAN_FORMATS} onDetect={onCameraDetect} label="Caméra" />
            </div>
            <UnitPickList
              id="sale-unit"
              hits={hits}
              unitOf={(h) => h.unit}
              isDisabled={(h) => !h.tracked || h.available <= 0}
              meta={(h) => (h.tracked ? `${h.available} dispo · ${formatCurrency(String(h.unit.price))}` : "non suivi ici")}
              addedKeys={new Set(lines.map((l) => l.key))}
              selected={lines}
              onRemove={(key) => setLines((p) => p.filter((x) => x.key !== key))}
              onPick={(h) => addUnit(h, "click")}
              onDone={closeList}
              nav={unitNav}
            />
            </div>

            {lines.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-tile border border-dashed border-field-border py-8 text-center text-sm text-ink-muted">
                <ShoppingBasket className="size-5" />
                Le panier est vide — scannez ou recherchez un article.
              </div>
            ) : (
              <div className="divide-y divide-hairline rounded-tile border border-hairline">
                {lines.map((l) => (
                  <div key={l.key} className="grid items-center gap-2 p-3 sm:grid-cols-[1fr_6rem_8rem_7rem_2rem]">
                    <div>
                      <div className="text-sm font-medium text-ink">{l.label}</div>
                      <div className="font-mono text-xs text-ink-muted">{l.sku} · dispo {l.available}</div>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-2 sm:contents">
                      <div className="space-y-1">
                        <span className="block text-xs text-ink-muted sm:hidden">Quantité</span>
                        <Input type="number" min={1} max={l.available} value={l.quantity} aria-label="Quantité" onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, quantity: Math.min(x.available, Math.max(1, Number(e.target.value) || 1)) } : x)))} />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-xs text-ink-muted sm:hidden">Prix unitaire</span>
                        <Input type="number" min={0} step="0.01" value={l.unitPrice} disabled={!canOverridePrice} aria-label="Prix unitaire" title={canOverridePrice ? undefined : "Modification du prix non autorisée"} onChange={(e) => setLines((p) => p.map((x) => (x.key === l.key ? { ...x, unitPrice: Math.max(0, Number(e.target.value) || 0) } : x)))} />
                      </div>
                      <div className="space-y-1">
                        <span className="block text-xs text-ink-muted sm:hidden">Remise</span>
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
          <CardTitle accent="green">Paiement</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-baseline justify-between gap-2 pr-10 sm:pr-0">
            <span className="text-sm text-ink-muted">Total</span>
            <span className="text-2xl font-semibold tracking-tight text-ink tabular-nums sm:text-[28px]">{formatCurrency(String(total))}</span>
          </div>
          {payments.map((p) => (
            <div key={p.key} className="flex gap-2">
              <NativeSelect value={p.method} onChange={(e) => setPayments((prev) => prev.map((x) => (x.key === p.key ? { ...x, method: e.target.value } : x)))}>
                {Object.entries(CASH_PAYMENT_METHOD_LABELS).map(([k, lab]) => (
                  <option key={k} value={k}>{lab}</option>
                ))}
              </NativeSelect>
              <Input type="number" min={0} step="0.01" value={p.amount} aria-label="Montant" onChange={(e) => setPayments((prev) => prev.map((x) => (x.key === p.key ? { ...x, amount: Math.max(0, Number(e.target.value) || 0) } : x)))} />
              <Button type="button" variant="ghost" size="icon" aria-label="Retirer le paiement" onClick={() => setPayments((prev) => prev.filter((x) => x.key !== p.key))}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" disabled={total <= 0} onClick={() => setPayments([{ key: crypto.randomUUID(), method: "ESPECES", amount: total }])}>
              <Banknote className="size-3.5" />
              Tout en espèces
            </Button>
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setPayments((p) => [...p, { key: crypto.randomUUID(), method: "CARTE", amount: Math.max(0, total - paid) }])}>
              <Plus className="size-3.5" />
              Paiement
            </Button>
          </div>
          {Math.abs(paid - total) > 0.005 && lines.length > 0 && (
            <Notice tone="warning" size="sm">
              <AlertTriangle />
              Reste à encaisser : {formatCurrency(String(total - paid))}
            </Notice>
          )}
          <Button type="button" className="w-full" size="lg" loading={isPending} disabled={lines.length === 0} onClick={submit}>
            {!isPending && <CheckCircle2 className="size-4" />}
            Valider la vente
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
