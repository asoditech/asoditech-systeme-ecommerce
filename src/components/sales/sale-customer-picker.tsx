"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Search, UserPlus, X } from "lucide-react";
import { createSaleCustomerAction, findSaleCustomersByPhoneAction, type SaleCustomer } from "@/actions/sales";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Sale « Client » (optional, default « Passage »). The seller types the
 * customer's full phone number: matching customers show as name + masked
 * phone. No browsing and no partial search. Not found → create with name +
 * phone (the same name + phone reuses the existing customer).
 */
export function SaleCustomerPicker({
  value,
  onChange,
}: {
  value: SaleCustomer | null;
  onChange: (customer: SaleCustomer | null) => void;
}) {
  const [phone, setPhone] = useState("");
  const [results, setResults] = useState<SaleCustomer[] | null>(null);
  const [name, setName] = useState("");
  const [isPending, startTransition] = useTransition();

  if (value) {
    return (
      <div className="flex h-11 items-center justify-between gap-2 rounded-control bg-pill-neutral px-3.5 text-sm text-ink">
        <span className="truncate">
          {value.fullName} <span className="text-muted-foreground">{value.maskedPhone}</span>
        </span>
        <button type="button" aria-label="Retirer le client" className="rounded-full text-ink-muted transition-colors hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none" onClick={() => onChange(null)}>
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  function search() {
    if (!phone.trim()) return;
    startTransition(async () => {
      const r = await findSaleCustomersByPhoneAction(phone);
      if (r.ok) setResults(r.data);
      else {
        setResults(null);
        toast.error(r.error);
      }
    });
  }

  function create() {
    startTransition(async () => {
      const r = await createSaleCustomerAction({ fullName: name, phone });
      if (r.ok) {
        onChange(r.data);
        setPhone("");
        setName("");
        setResults(null);
      } else toast.error(r.error);
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id="sale-customer"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          placeholder="Passage — n° de téléphone"
          onChange={(e) => {
            setPhone(e.target.value);
            setResults(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
        />
        <Button type="button" variant="outline" size="icon" aria-label="Rechercher le client" disabled={isPending || !phone.trim()} onClick={search}>
          <Search className="h-4 w-4" />
        </Button>
      </div>
      {results !== null && (
        <div className="space-y-1 rounded-tile border border-hairline p-2 text-sm">
          {results.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-row-hover"
              onClick={() => {
                onChange(c);
                setPhone("");
                setResults(null);
              }}
            >
              <span className="truncate">{c.fullName}</span>
              <span className="text-muted-foreground">{c.maskedPhone}</span>
            </button>
          ))}
          {results.length === 0 && <p className="px-2 py-1 text-muted-foreground">Aucun client avec ce numéro.</p>}
          <div className="flex gap-2 pt-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du nouveau client" aria-label="Nom du nouveau client" />
            <Button type="button" variant="outline" disabled={isPending || name.trim().length < 2} onClick={create}>
              <UserPlus className="mr-1 h-4 w-4" />
              Créer
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
