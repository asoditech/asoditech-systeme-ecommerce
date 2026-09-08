"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Warehouse filter for the stock-valuation report — swaps `?warehouseId`
 * while keeping the period params. Client component only because it
 * navigates on change. */
export function WarehousePickerLink({
  warehouses,
  selected,
  basePath,
}: {
  warehouses: { id: string; name: string }[];
  selected?: string;
  basePath: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function go(value: string | null) {
    const sp = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") sp.delete("warehouseId");
    else sp.set("warehouseId", value);
    router.push(`${basePath}?${sp.toString()}`);
  }

  return (
    <Select value={selected ?? "all"} onValueChange={go}>
      <SelectTrigger className="w-52">
        <SelectValue>
          {(v: string) => (v === "all" ? "Tous les entrepôts" : warehouses.find((w) => w.id === v)?.name ?? "Entrepôt")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">Tous les entrepôts</SelectItem>
        {warehouses.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
