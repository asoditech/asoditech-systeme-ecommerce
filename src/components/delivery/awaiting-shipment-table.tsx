"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Truck } from "lucide-react";
import { createShipmentsBulkAction } from "@/actions/delivery";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  CreateShipmentDialog,
  type ShipmentProviderOption,
  type OrderShippingAddress,
} from "@/components/delivery/create-shipment-dialog";
import { CityMappingDialog } from "@/components/delivery/city-mapping-dialog";
import { formatCurrency, formatDate, displayOrderNumber } from "@/lib/format";

export interface AwaitingOrderRow {
  id: string;
  orderNumber: number;
  displayNumber?: number | null;
  source: "INTERNE" | "WOOCOMMERCE" | "SHOPIFY";
  externalNumber: string | null;
  customerName: string;
  total: string;
  currency: string;
  placedAt: string;
  parcelContents: string | null;
  /** Reason the last shipment-creation attempt for this order failed, if
   * any — shown inline so the operator can fix + retry. */
  failedReason?: string | null;
  address: OrderShippingAddress;
}

const BATCH = 6;

export function AwaitingShipmentTable({
  orders,
  providers,
}: {
  orders: AwaitingOrderRow[];
  providers: ShipmentProviderOption[];
}) {
  const router = useRouter();
  const apiProviders = useMemo(
    () => providers.filter((p) => p.type === "API" && p.connectionStatus === "CONNECTE"),
    [providers]
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProviderId, setBulkProviderId] = useState<string | undefined>(
    apiProviders.length === 1 ? apiProviders[0].id : undefined
  );
  const [running, setRunning] = useState(false);

  const allSelected = orders.length > 0 && selected.size === orders.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(orders.map((o) => o.id)));
  }

  async function runBulk() {
    if (running || selected.size === 0 || !bulkProviderId) return;
    setRunning(true);
    let remaining = [...selected];
    let created = 0;
    const failures: string[] = [];
    try {
      while (remaining.length > 0) {
        const fd = new FormData();
        fd.set("providerId", bulkProviderId);
        fd.set("orderIds", remaining.join(","));
        const res = await createShipmentsBulkAction(fd);
        if (!res.ok) {
          toast.error(res.error);
          break;
        }
        const done = new Set<string>();
        for (const r of res.data.results) {
          done.add(r.orderId);
          if (r.ok) created++;
          else
            failures.push(
              `${displayOrderNumber({ orderNumber: r.orderNumber, displayNumber: r.orderDisplayNumber, source: "INTERNE", externalNumber: null })} : ${r.error ?? "échec"}`
            );
        }
        remaining = remaining.filter((id) => !done.has(id));
        if (res.data.results.length === 0) break; // safety
        if (remaining.length > 0) await new Promise((r) => setTimeout(r, 150));
      }
      setSelected(new Set());
      if (created > 0) toast.success(`${created} expédition(s) créée(s).`);
      if (failures.length > 0) {
        toast.error(`${failures.length} échec(s) : ${failures.slice(0, 3).join(" · ")}${failures.length > 3 ? "…" : ""}`);
      }
      router.refresh();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {apiProviders.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">{selected.size} sélectionnée(s)</span>
          <span className="text-muted-foreground">→</span>
          <Select value={bulkProviderId} onValueChange={(v) => setBulkProviderId((v as string | null) ?? undefined)}>
            <SelectTrigger className="h-8 w-52">
              <SelectValue placeholder="Prestataire">
                {(value: string) => apiProviders.find((p) => p.id === value)?.name ?? "Prestataire"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {apiProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={running || selected.size === 0 || !bulkProviderId}
            onClick={runBulk}
          >
            <Truck className={running ? "size-4 animate-pulse" : "size-4"} />
            {running ? "Création…" : `Créer les expéditions (${selected.size})`}
          </Button>
          {bulkProviderId && (
            <CityMappingDialog
              providerId={bulkProviderId}
              providerName={apiProviders.find((p) => p.id === bulkProviderId)?.name ?? ""}
              triggerLabel="Villes du transporteur"
              triggerVariant="ghost"
            />
          )}
          <span className="text-xs text-muted-foreground">
            Traité par lots de {BATCH}. Une ville non reconnue ? Ajoutez une correspondance ci-dessus.
          </span>
        </div>
      )}

      <div className="rounded-lg border">
        <Table className="text-[13px] [&_td]:px-2.5 [&_td]:py-2 [&_th]:px-2.5">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Tout sélectionner" />
              </TableHead>
              <TableHead>Commande</TableHead>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Date</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.map((o) => (
              <TableRow key={o.id} data-state={selected.has(o.id) ? "selected" : undefined}>
                <TableCell className="align-top">
                  <Checkbox
                    checked={selected.has(o.id)}
                    onCheckedChange={() => toggle(o.id)}
                    aria-label={`Sélectionner ${displayOrderNumber(o)}`}
                  />
                </TableCell>
                <TableCell className="font-medium align-top">
                  <Link href={`/commandes/${o.id}`} className="hover:underline">
                    {displayOrderNumber(o)}
                  </Link>
                </TableCell>
                <TableCell className="align-top">
                  <span className="block max-w-[10rem] truncate">{o.customerName}</span>
                  <span className="block max-w-[10rem] truncate text-xs text-muted-foreground">
                    {o.address.shippingCity ?? "ville manquante"}
                  </span>
                  {o.failedReason && (
                    <p className="mt-1 max-w-[18rem] text-[11px] leading-tight text-destructive">{o.failedReason}</p>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums align-top">{formatCurrency(o.total, o.currency)}</TableCell>
                <TableCell className="text-muted-foreground align-top">{formatDate(o.placedAt)}</TableCell>
                <TableCell className="align-top">
                  <CreateShipmentDialog
                    orderId={o.id}
                    providers={providers}
                    defaultNotes={o.parcelContents || undefined}
                    orderAddress={o.address}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
