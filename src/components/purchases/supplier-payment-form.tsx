"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { recordSupplierPaymentAction, type SupplierPaymentResult } from "@/actions/purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * Records a payment to a supplier — docs/adr/0042. The user enters only an
 * amount: the server automatically allocates it across the supplier's
 * oldest outstanding validated receptions first, so there is nothing to
 * pick here ("which reception does this belong to?" is not a question the
 * form asks). After saving, the allocation the server actually applied is
 * shown back so the user can see exactly where the money went.
 */
export function SupplierPaymentForm({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("ESPECES");
  const [reference, setReference] = useState("");
  const [lastResult, setLastResult] = useState<SupplierPaymentResult | null>(null);

  function submit() {
    startTransition(async () => {
      const r = await recordSupplierPaymentAction({
        supplierId,
        amount: Number(amount),
        method: method as "ESPECES",
        reference,
      });
      if (r.ok) {
        toast.success("Paiement enregistré.");
        setAmount("");
        setReference("");
        setLastResult(r.data);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Enregistrer un paiement</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Indiquez seulement le montant réglé — il est affecté automatiquement aux réceptions impayées les plus
          anciennes de ce fournisseur.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="pay-amount">Montant (MAD)</Label>
            <Input id="pay-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-method">Mode</Label>
            <select id="pay-method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value)}>
              {Object.entries(CASH_PAYMENT_METHOD_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pay-ref">Référence</Label>
            <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° chèque / virement" />
          </div>
          <div className="sm:col-span-3">
            <Button type="button" onClick={submit} disabled={isPending || !(Number(amount) > 0)}>
              {isPending ? "Enregistrement..." : "Enregistrer le paiement"}
            </Button>
          </div>
        </div>

        {lastResult && (
          <div className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex items-center gap-1.5 font-medium">
              <CheckCircle2 className="size-4 text-emerald-600" />
              Paiement de {formatCurrency(lastResult.amount)} affecté automatiquement
            </div>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              {lastResult.allocations.map((a) => (
                <li key={a.receptionId}>
                  {a.receptionLabel} → {formatCurrency(a.amount)}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs">
              Solde restant dû au fournisseur : <span className="font-medium">{formatCurrency(lastResult.remainingBalance)}</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
