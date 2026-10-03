"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Download, ShieldAlert } from "lucide-react";
import { validateProductExportAction } from "@/actions/product-export";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/status-badge";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PRODUCT_STATUS_LABELS } from "@/lib/status-labels";
import { EXPORT_PLATFORM_LABELS, type ExportPlatform } from "@/lib/catalog/export/model";
import type { ExportValidation } from "@/lib/catalog/export/validate";

export interface ExportRow {
  id: string;
  name: string;
  sku: string;
  status: string;
  category: string | null;
  variationCount: number;
  imageCount: number;
  createdAt: string;
  publishedTo: ExportPlatform[];
}

/**
 * Select → platform → verify → download (docs/adr/0054). The checks and the
 * file are produced server-side; this component only holds the selection.
 */
export function ProductExportPanel({ rows, total, limit }: { rows: ExportRow[]; total: number; limit: number }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [platform, setPlatform] = useState<ExportPlatform>("woocommerce");
  const [checked, setChecked] = useState<{ validation: ExportValidation; rowCount: number; filename: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  const ids = useMemo(() => rows.filter((r) => selected.has(r.id)).map((r) => r.id), [rows, selected]);
  const allSelected = rows.length > 0 && ids.length === rows.length;
  const reset = () => {
    setChecked(null);
    setAcknowledged(false);
  };
  const toggle = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
    reset();
  };
  const selectAll = (on: boolean) => {
    setSelected(on ? new Set(rows.map((r) => r.id)) : new Set());
    reset();
  };

  async function verify() {
    setBusy(true);
    const res = await validateProductExportAction({ platform, ids });
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setChecked(res.data);
    setAcknowledged(res.data.validation.warnings.length === 0);
  }

  async function download() {
    setBusy(true);
    try {
      const form = new FormData();
      for (const id of ids) form.append("ids", id);
      const res = await fetch(`/produits/exporter/${platform}`, { method: "POST", body: form });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; validation?: ExportValidation } | null;
        if (body?.validation) setChecked((c) => (c ? { ...c, validation: body.validation! } : c));
        toast.error(body?.error ?? "Export impossible.");
        return;
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? checked?.filename ?? "export.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(`${name} téléchargé (${ids.length} produit(s)).`);
    } finally {
      setBusy(false);
    }
  }

  const canDownload = checked !== null && checked.validation.errors.length === 0 && acknowledged && ids.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card p-3 shadow-card ring-1 ring-border">
        <span className="text-sm font-medium">
          {ids.length} sélectionné(s) sur {rows.length}
          {total > rows.length && <span className="ml-1 text-xs text-muted-foreground">(affinez les filtres : {total} résultats, {limit} affichés au plus)</span>}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => selectAll(!allSelected)} disabled={rows.length === 0}>
          {allSelected ? "Tout désélectionner" : `Tout sélectionner (${rows.length})`}
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Format</span>
          <SegmentedControl>
            {(["woocommerce", "shopify"] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={platform === p}
                onClick={() => {
                  setPlatform(p);
                  reset();
                }}
                className={
                  "rounded-full px-3 py-1 text-xs font-medium whitespace-nowrap transition-colors " +
                  (platform === p ? "bg-background text-foreground shadow-sm ring-1 ring-border" : "text-muted-foreground hover:text-foreground")
                }
              >
                {EXPORT_PLATFORM_LABELS[p]}
              </button>
            ))}
          </SegmentedControl>
          <Button type="button" size="sm" variant="outline" onClick={verify} loading={busy && !checked} disabled={ids.length === 0}>
            <ShieldAlert className="size-3.5" />
            Vérifier l&apos;export
          </Button>
          <Button type="button" size="sm" onClick={download} loading={busy && checked !== null} disabled={!canDownload}>
            <Download className="size-3.5" />
            Télécharger le CSV {EXPORT_PLATFORM_LABELS[platform]}
          </Button>
        </div>
      </div>

      {checked && (
        <div className="space-y-3 rounded-xl bg-card p-4 shadow-card ring-1 ring-border" role="status">
          {checked.validation.errors.length === 0 ? (
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="size-4" />
              Prêt : {ids.length} produit(s), {checked.rowCount} ligne(s) — {checked.filename}
            </p>
          ) : (
            <div>
              <p className="mb-1 text-sm font-medium text-destructive">Export bloqué — corrigez ces points :</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-destructive">
                {checked.validation.errors.map((e, i) => (
                  <li key={i}>
                    {e.productName && <strong>{e.productName} : </strong>}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {checked.validation.warnings.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-4" />
                Avertissements
              </p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
                {checked.validation.warnings.map((w, i) => (
                  <li key={i}>
                    {w.productName && <strong className="text-foreground">{w.productName} : </strong>}
                    {w.message}
                  </li>
                ))}
              </ul>
              {checked.validation.errors.length === 0 && (
                <label className="mt-3 flex items-center gap-2 text-sm">
                  <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(Boolean(v))} aria-label="J'ai lu les avertissements" />
                  J&apos;ai lu ces avertissements
                </label>
              )}
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border bg-card shadow-card">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  indeterminate={ids.length > 0 && !allSelected}
                  onCheckedChange={(v) => selectAll(Boolean(v))}
                  aria-label="Tout sélectionner"
                  disabled={rows.length === 0}
                />
              </TableHead>
              <TableHead>Produit</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Catégorie</TableHead>
              <TableHead className="text-right">Variations</TableHead>
              <TableHead className="text-right">Images</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Créé le</TableHead>
              <TableHead>Déjà publié</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                  Aucun produit ne correspond aux filtres.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r) => (
                <TableRow key={r.id} data-state={selected.has(r.id) ? "selected" : undefined}>
                  <TableCell>
                    <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, Boolean(v))} aria-label={`Sélectionner ${r.name}`} />
                  </TableCell>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs">{r.sku}</TableCell>
                  <TableCell className="text-muted-foreground">{r.category ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.variationCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.imageCount}</TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} labels={PRODUCT_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{r.createdAt}</TableCell>
                  <TableCell>
                    {r.publishedTo.length === 0
                      ? "—"
                      : r.publishedTo.map((p) => (
                          <Badge key={p} variant="outline" className="mr-1">
                            {EXPORT_PLATFORM_LABELS[p]}
                          </Badge>
                        ))}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
