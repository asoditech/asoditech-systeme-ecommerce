"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { recordSupplierPaymentAction } from "@/actions/purchases";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CASH_PAYMENT_METHOD_LABELS } from "@/lib/status-labels";

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * Records a payment to a supplier. A payment is a FINANCIAL record: it never
 * creates stock, and it may settle one validated reception or sit on the
 * supplier's account (docs/adr/0040).
 */
export function SupplierPaymentForm({
  supplierId,
  receptions,
  defaultReceptionId,
}: {
  supplierId: string;
  /** Validated receptions with something left to pay. */
  receptions: { id: string; label: string; remaining: string }[];
  defaultReceptionId?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("ESPECES");
  const [receptionId, setReceptionId] = useState(defaultReceptionId ?? "");
  const [reference, setReference] = useState("");

  function submit() {
    startTransition(async () => {
      const r = await recordSupplierPaymentAction({
        supplierId,
        receptionId: receptionId || null,
        amount: Number(amount),
        method: method as "ESPECES",
        reference,
      });
      if (r.ok) {
        toast.success("Paiement enregistré.");
        setAmount("");
        setReference("");
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Enregistrer un paiement</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4">
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
          <Label htmlFor="pay-reception">Réception réglée</Label>
          <select id="pay-reception" className={selectClass} value={receptionId} onChange={(e) => setReceptionId(e.target.value)}>
            <option value="">Sur le compte fournisseur</option>
            {receptions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} — reste {r.remaining}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pay-ref">Référence</Label>
          <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="N° chèque / virement" />
        </div>
        <div className="sm:col-span-4">
          <Button type="button" onClick={submit} disabled={isPending || !(Number(amount) > 0)}>
            {isPending ? "Enregistrement..." : "Enregistrer le paiement"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
