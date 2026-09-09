"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Phone, SlidersHorizontal } from "lucide-react";
import { updateBusinessSettingsAction } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LogoField } from "@/components/settings/logo-field";
import type { BusinessSettings } from "@prisma/client";
import type { ActionResult } from "@/actions/types";

export function BusinessSettingsForm({ settings }: { settings: BusinessSettings }) {
  const router = useRouter();
  const [state, formAction, isPending] = useActionState(
    async (_prevState: ActionResult<BusinessSettings> | undefined, formData: FormData) =>
      updateBusinessSettingsAction(formData),
    undefined
  );

  useEffect(() => {
    if (state?.ok) {
      toast.success("Paramètres enregistrés.");
      router.refresh();
    } else if (state && !state.ok) {
      toast.error(state.error);
    }
  }, [state, router]);

  return (
    <form action={formAction} className="space-y-5">
      {/* Currency is fixed per deployment — not operator-editable — but the
          action still expects the field, so round-trip the stored value. */}
      <input type="hidden" name="currency" value={settings.currency} />

      <SettingsCard
        icon={<Building2 className="size-4" />}
        title="Identité de l'entreprise"
        description="Nom et logo utilisés sur les documents imprimés (rapports, factures de livraison)."
      >
        <div className="space-y-5">
          <LogoField defaultValue={settings.logoUrl} />
          <Field label="Nom de l'entreprise" htmlFor="companyName">
            <Input id="companyName" name="companyName" defaultValue={settings.companyName} />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<Phone className="size-4" />}
        title="Coordonnées"
        description="Apparaissent en en-tête des factures et rapports transmis à vos clients."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="E-mail de contact" htmlFor="email">
            <Input id="email" name="email" type="email" defaultValue={settings.email ?? ""} />
          </Field>
          <Field label="Téléphone" htmlFor="phone">
            <Input id="phone" name="phone" defaultValue={settings.phone ?? ""} />
          </Field>
          <Field label="Adresse" htmlFor="address" className="sm:col-span-2">
            <Input id="address" name="address" defaultValue={settings.address ?? ""} />
          </Field>
          <Field label="Ville" htmlFor="city">
            <Input id="city" name="city" defaultValue={settings.city ?? ""} />
          </Field>
          <Field label="Pays" htmlFor="country">
            <Input id="country" name="country" defaultValue={settings.country} />
          </Field>
        </div>
      </SettingsCard>

      <SettingsCard
        icon={<SlidersHorizontal className="size-4" />}
        title="Préférences générales"
        description="Réglages par défaut appliqués à l'ensemble du système."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Fuseau horaire" htmlFor="timezone">
            <Input id="timezone" name="timezone" defaultValue={settings.timezone} />
          </Field>
          <Field label="Seuil de stock faible par défaut" htmlFor="lowStockDefaultThreshold">
            <Input
              id="lowStockDefaultThreshold"
              name="lowStockDefaultThreshold"
              type="number"
              min="0"
              defaultValue={settings.lowStockDefaultThreshold}
            />
          </Field>
          <Field label="Préfixe des numéros de commande" htmlFor="orderNumberPrefix">
            <Input id="orderNumberPrefix" name="orderNumberPrefix" defaultValue={settings.orderNumberPrefix} />
          </Field>
        </div>
      </SettingsCard>

      <div className="sticky bottom-0 flex justify-end border-t bg-background/95 py-3 backdrop-blur">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Enregistrement..." : "Enregistrer les modifications"}
        </Button>
      </div>
    </form>
  );
}

function SettingsCard({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
            {icon}
          </span>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5${className ? ` ${className}` : ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
