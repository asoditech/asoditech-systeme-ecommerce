"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, ExternalLink, CheckCircle2 } from "lucide-react";
import { publishProductAction } from "@/actions/product-publishing";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/**
 * Batch 13 — Product Publishing. One row per external channel this tenant
 * could conceivably publish to (a real, verified CONNECTE integration for
 * that provider — never a disconnected one, per Section 4: "Do not expose
 * fake publish buttons that cannot work"). Publishing is never a side
 * effect of anything else on this page — the only way an external mutation
 * happens is this panel's own explicit review-then-confirm dialog.
 */
export interface PublishChannel {
  provider: "WOOCOMMERCE" | "SHOPIFY";
  label: string;
  /** Present only once a `ProductPublication` row exists for this (product, provider) pair. */
  published: { externalId: string; adminUrl: string | null } | null;
}

export function ProductPublishPanel({
  productId,
  productName,
  channels,
  canPublish,
}: {
  productId: string;
  productName: string;
  channels: PublishChannel[];
  canPublish: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reviewing, setReviewing] = useState<PublishChannel | null>(null);

  function confirmPublish() {
    if (!reviewing) return;
    const provider = reviewing.provider;
    startTransition(async () => {
      const result = await publishProductAction({ productId, provider });
      if (result.ok) {
        toast.success(`Produit publié sur ${reviewing.label}.`);
        setReviewing(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[15px]">Publication externe</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Publier ce produit crée un produit correspondant sur le canal externe choisi. Cette action est explicite —
          rien n&apos;est jamais publié automatiquement lors d&apos;une simple modification.
        </p>
        {channels.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun canal externe connecté. Connectez WooCommerce ou Shopify pour publier ce produit.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {channels.map((c) => (
              <div key={c.provider} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  {c.published ? (
                    <Badge variant="default" className="gap-1">
                      <CheckCircle2 className="size-3" />
                      Publié
                    </Badge>
                  ) : (
                    <Badge variant="outline">Non publié</Badge>
                  )}
                </div>
                {c.published ? (
                  c.published.adminUrl ? (
                    <Button
                      variant="outline"
                      size="sm"
                      render={<a href={c.published.adminUrl} target="_blank" rel="noopener noreferrer" />}
                    >
                      Voir sur {c.label}
                      <ExternalLink className="size-3.5" />
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">Référence {c.published.externalId}</span>
                  )
                ) : (
                  canPublish && (
                    <Dialog
                      open={reviewing?.provider === c.provider}
                      onOpenChange={(open) => setReviewing(open ? c : null)}
                    >
                      <DialogTrigger render={<Button type="button" size="sm" />}>
                        <Upload className="size-3.5" />
                        Publier
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>Publier « {productName} »</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-2 text-sm">
                          <p>
                            <span className="text-muted-foreground">Produit : </span>
                            <span className="font-medium">{productName}</span>
                          </p>
                          <p>
                            <span className="text-muted-foreground">Canal cible : </span>
                            <span className="font-medium">{c.label}</span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            Le nom, le SKU, le prix, la description, les images et les variantes actuels du produit
                            seront envoyés à {c.label} pour créer un nouveau produit correspondant.
                          </p>
                        </div>
                        <DialogFooter>
                          <Button type="button" disabled={isPending} onClick={confirmPublish}>
                            {isPending ? "Publication..." : "Confirmer la publication"}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  )
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
