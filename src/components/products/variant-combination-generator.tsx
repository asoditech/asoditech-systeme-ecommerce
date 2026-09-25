"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { generateProductVariationsAction } from "@/actions/products";
import { generateAttributeCombinations, attributesKey } from "@/lib/catalog/variations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface OptionDraft {
  name: string;
  /** Comma-separated as typed — parsed to a values[] only on preview/submit. */
  valuesText: string;
}

/**
 * Combination generator (Batch 4, Task 4) — "Couleur: Noir, Blanc" +
 * "Taille: S, M, L" → up to 6 new variations. Preview clearly separates
 * combinations that already exist (skipped, never duplicated) from ones
 * that will actually be created; regenerating a narrower set never removes
 * anything — removal is the table's own explicit "Supprimer" action.
 */
export function VariantCombinationGenerator({
  productId,
  existingAttributes,
}: {
  productId: string;
  /** Every existing variation's attributes, for the "already exists" preview. */
  existingAttributes: Record<string, string>[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<OptionDraft[]>([{ name: "", valuesText: "" }]);
  const [isPending, startTransition] = useTransition();

  const existingKeys = useMemo(() => new Set(existingAttributes.map((a) => attributesKey(a))), [existingAttributes]);

  const parsedOptions = useMemo(
    () =>
      options
        .map((o) => ({ name: o.name.trim(), values: o.valuesText.split(",").map((v) => v.trim()).filter(Boolean) }))
        .filter((o) => o.name && o.values.length > 0),
    [options]
  );
  const combinations = useMemo(() => generateAttributeCombinations(parsedOptions), [parsedOptions]);
  const newCombinations = combinations.filter((c) => !existingKeys.has(attributesKey(c)));
  const alreadyExistingCount = combinations.length - newCombinations.length;

  function updateOption(i: number, patch: Partial<OptionDraft>) {
    setOptions((prev) => prev.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  }

  function submit() {
    if (newCombinations.length === 0) {
      toast.error("Aucune nouvelle combinaison à créer.");
      return;
    }
    startTransition(async () => {
      const result = await generateProductVariationsAction({ productId, options: parsedOptions });
      if (result.ok) {
        toast.success(
          result.data.skippedExisting > 0
            ? `${result.data.created} variation(s) créée(s), ${result.data.skippedExisting} déjà existante(s) ignorée(s).`
            : `${result.data.created} variation(s) créée(s).`
        );
        setOptions([{ name: "", valuesText: "" }]);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Wand2 className="size-4" />
        Générer des combinaisons
      </Button>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Générer des combinaisons</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Une option par ligne (ex. Couleur), avec ses valeurs séparées par des virgules (ex. Noir, Blanc). Les
          combinaisons qui existent déjà ne sont jamais recréées ni modifiées.
        </p>
        <div className="space-y-3">
          {options.map((o, i) => (
            <div key={i} className="flex flex-wrap items-start gap-2">
              <Input
                value={o.name}
                onChange={(e) => updateOption(i, { name: e.target.value })}
                placeholder="Option (ex. Couleur)"
                className="w-40"
                aria-label="Nom de l'option"
              />
              <Input
                value={o.valuesText}
                onChange={(e) => updateOption(i, { valuesText: e.target.value })}
                placeholder="Valeurs séparées par des virgules (ex. Noir, Blanc)"
                className="min-w-56 flex-1"
                aria-label="Valeurs de l'option"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Retirer cette option"
                onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                disabled={options.length === 1}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setOptions((prev) => [...prev, { name: "", valuesText: "" }])}>
            <Plus className="size-4" />
            Ajouter une option
          </Button>
        </div>

        {combinations.length > 0 && (
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-xs font-medium text-muted-foreground">
              {combinations.length} combinaison{combinations.length > 1 ? "s" : ""} — {newCombinations.length} nouvelle
              {newCombinations.length > 1 ? "s" : ""}
              {alreadyExistingCount > 0 ? `, ${alreadyExistingCount} déjà existante${alreadyExistingCount > 1 ? "s" : ""}` : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {combinations.map((c, i) => {
                const exists = existingKeys.has(attributesKey(c));
                return (
                  <Badge key={i} variant={exists ? "secondary" : "outline"}>
                    {Object.values(c).join(" / ")}
                    {exists && " (existe déjà)"}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Annuler
          </Button>
          <Button type="button" onClick={submit} disabled={isPending || newCombinations.length === 0}>
            {isPending
              ? "Création..."
              : `Ajouter ${newCombinations.length || ""} nouvelle${newCombinations.length > 1 ? "s" : ""} combinaison${newCombinations.length > 1 ? "s" : ""}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
