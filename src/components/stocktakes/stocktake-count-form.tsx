"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateStocktakeCountsAction } from "@/actions/stocktakes";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface StocktakeCountLine {
  id: string;
  label: string;
  sku: string;
  systemQuantityAtCount: number;
  currentQuantity: number;
  countedQuantity: number | null;
  isStale: boolean;
}

/** Editable count table for an EN_COURS session. A blank cell means "not
 * counted"; clearing a previously-entered count sends an explicit null.
 * The actual stock is never touched here — only the count is saved. */
export function StocktakeCountForm({
  sessionId,
  lines,
}: {
  sessionId: string;
  lines: StocktakeCountLine[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = React.useTransition();
  // "" = not counted / cleared; otherwise the entered string.
  const [draft, setDraft] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.countedQuantity === null ? "" : String(l.countedQuantity)]))
  );

  const original = (l: StocktakeCountLine) => (l.countedQuantity === null ? "" : String(l.countedQuantity));
  const changedLines = lines.filter((l) => (draft[l.id] ?? "").trim() !== original(l));

  function save() {
    if (changedLines.length === 0) return;
    // Only the lines the operator actually touched are sent — a blank cell
    // that stays blank is left untouched, not rewritten.
    const counts = changedLines.map((l) => {
      const raw = (draft[l.id] ?? "").trim();
      return { lineId: l.id, countedQuantity: raw === "" ? null : Number(raw) };
    });
    // client-side guard mirroring the schema (server still authoritative)
    if (counts.some((c) => c.countedQuantity !== null && (!Number.isInteger(c.countedQuantity) || c.countedQuantity! < 0))) {
      toast.error("Les quantités comptées doivent être des entiers positifs ou nuls.");
      return;
    }
    startTransition(async () => {
      const result = await updateStocktakeCountsAction({ id: sessionId, counts });
      if (result.ok) {
        toast.success("Comptages enregistrés.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Article</TableHead>
              <TableHead>Système</TableHead>
              <TableHead>Compté</TableHead>
              <TableHead>Écart</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((l) => {
              const raw = (draft[l.id] ?? "").trim();
              const counted = raw === "" ? null : Number(raw);
              const variance = counted === null ? null : counted - l.systemQuantityAtCount;
              const drifted = l.currentQuantity !== l.systemQuantityAtCount;
              return (
                <TableRow key={l.id} className={l.isStale ? "bg-destructive/5" : undefined}>
                  <TableCell>
                    <p className="font-medium">{l.label}</p>
                    <p className="text-xs text-muted-foreground">{l.sku}</p>
                  </TableCell>
                  <TableCell>
                    {l.systemQuantityAtCount}
                    {drifted && (
                      <span className="ml-1 text-xs text-destructive">(stock actuel : {l.currentQuantity})</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      inputMode="numeric"
                      className="w-24"
                      value={draft[l.id] ?? ""}
                      placeholder="—"
                      onChange={(e) => setDraft((d) => ({ ...d, [l.id]: e.target.value }))}
                    />
                  </TableCell>
                  <TableCell className={variance != null && variance !== 0 ? "font-medium text-destructive" : ""}>
                    {variance == null ? "—" : variance > 0 ? `+${variance}` : variance}
                  </TableCell>
                  <TableCell>
                    {l.isStale && <Badge variant="destructive">Périmée — recompter</Badge>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Laissez une cellule vide pour ne pas compter cet article. Effacer une valeur déjà saisie la remet à « non compté ».
        </p>
        <Button type="button" onClick={save} disabled={isPending || changedLines.length === 0}>
          {isPending ? "Enregistrement..." : "Enregistrer les comptages"}
        </Button>
      </div>
    </div>
  );
}
