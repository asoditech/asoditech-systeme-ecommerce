"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { createCustomerAction, updateCustomerAction } from "@/actions/customers";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { CUSTOMER_SEGMENT_LABELS } from "@/lib/status-labels";
import type { Customer } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

export function CustomerForm({ customer }: { customer?: Customer }) {
  const router = useRouter();
  const action = customer ? updateCustomerAction : createCustomerAction;
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<Customer> | undefined, formData: FormData) => action(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success(customer ? "Client mis à jour." : "Client créé.");
      router.push(`/clients/${state.data.id}`);
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={formAction} className="space-y-4">
          {customer && <input type="hidden" name="id" value={customer.id} />}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="fullName">Nom complet</Label>
              <Input id="fullName" name="fullName" required defaultValue={customer?.fullName} />
              {state && !state.ok && state.fieldErrors?.fullName && (
                <p className="text-xs text-destructive">{state.fieldErrors.fullName[0]}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone">Téléphone</Label>
              <Input id="phone" name="phone" defaultValue={customer?.phone ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="whatsapp">WhatsApp</Label>
              <Input id="whatsapp" name="whatsapp" defaultValue={customer?.whatsapp ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">E-mail</Label>
              <Input id="email" name="email" type="email" defaultValue={customer?.email ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="city">Ville</Label>
              <Input id="city" name="city" defaultValue={customer?.city ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="region">Région</Label>
              <Input id="region" name="region" defaultValue={customer?.region ?? ""} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="country">Pays</Label>
              <Input id="country" name="country" defaultValue={customer?.country ?? "Maroc"} />
            </div>
            {customer && (
              <div className="space-y-1.5">
                <Label htmlFor="segment">Segment (manuel)</Label>
                <Select name="segment" defaultValue={customer.segment ?? undefined}>
                  <SelectTrigger id="segment" className="w-full">
                    <SelectValue placeholder="Non segmenté">
                      {(value: string) => CUSTOMER_SEGMENT_LABELS[value] ?? value}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(CUSTOMER_SEGMENT_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" name="notes" rows={3} defaultValue={customer?.notes ?? ""} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => router.back()}>
              Annuler
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Enregistrement..." : customer ? "Enregistrer" : "Créer le client"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
