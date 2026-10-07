"use client";

import { AtSign, Clock3, Gauge, Hash, Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import { updateBusinessSettingsAction } from "@/actions/settings";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LogoField } from "@/components/settings/logo-field";
import { SettingsForm, ValueTile } from "@/components/settings/setting-controls";
import { identityCompletion, orderNumberPreview } from "@/lib/settings/configuration-model";
import { cn } from "@/lib/utils";
import type { BusinessSettings } from "@prisma/client";

/**
 * Company-wide settings of the Configuration control center. Every form posts
 * ONLY its own fields to the one shared `updateBusinessSettingsAction` (fields
 * it doesn't send keep their stored value) — same field names as always. The
 * fuseau horaire is not offered: it is stored but nothing uses it.
 */

function Field({ label, htmlFor, children, className }: { label: string; htmlFor: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</legend>
      {children}
    </fieldset>
  );
}

function Initials({ name }: { name: string }) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return <span className="text-lg font-bold">{letters || "?"}</span>;
}

/** Entreprise: a live document-header preview + the identity form (floating save bar). */
export function CompanySettingsForm({ settings }: { settings: BusinessSettings }) {
  const completion = identityCompletion(settings);
  return (
    <div id="identite" className="grid scroll-mt-24 gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <aside className="space-y-4">
        <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
          <div className="border-b bg-muted/40 px-5 py-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            Aperçu sur vos documents
          </div>
          <div className="space-y-4 p-5">
            <div className="flex items-center gap-3">
              <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted text-muted-foreground">
                {settings.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={settings.logoUrl} alt="" className="max-h-full max-w-full object-contain" />
                ) : (
                  <Initials name={settings.companyName} />
                )}
              </span>
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{settings.companyName.trim() || "Nom de l'entreprise"}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {[settings.city, settings.country].filter(Boolean).join(", ") || "Ville, pays"}
                </p>
              </div>
            </div>
            <ul className="space-y-2 text-sm">
              <PreviewLine icon={MapPin} value={settings.address} placeholder="Adresse" />
              <PreviewLine icon={Mail} value={settings.email} placeholder="E-mail" />
              <PreviewLine icon={Phone} value={settings.phone} placeholder="Téléphone" />
            </ul>
          </div>
        </div>
        <div className="rounded-2xl border bg-card p-4 shadow-xs">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Identité complète</span>
            <span className="font-semibold tabular-nums">{completion.percent} %</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={completion.percent} aria-valuemin={0} aria-valuemax={100} aria-label="Identité complète">
            <div className={cn("h-full rounded-full transition-all", completion.percent === 100 ? "bg-emerald-500" : "bg-primary")} style={{ width: `${completion.percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {completion.filled} sur {completion.total} éléments affichés sur vos rapports et factures.
          </p>
        </div>
      </aside>

      <SettingsForm action={updateBusinessSettingsAction} success="Informations de l'entreprise enregistrées." className="rounded-2xl border bg-card p-5 shadow-xs sm:p-6">
        <div className="space-y-7">
          <FieldGroup title="Identité">
            <Field label="Nom de l'entreprise" htmlFor="companyName">
              <Input id="companyName" name="companyName" defaultValue={settings.companyName} />
            </Field>
            <LogoField defaultValue={settings.logoUrl} />
          </FieldGroup>
          <FieldGroup title="Coordonnées">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="E-mail de contact" htmlFor="email">
                <Input id="email" name="email" type="email" defaultValue={settings.email ?? ""} />
              </Field>
              <Field label="Téléphone" htmlFor="phone">
                <Input id="phone" name="phone" defaultValue={settings.phone ?? ""} />
              </Field>
            </div>
          </FieldGroup>
          <FieldGroup title="Adresse">
            <Field label="Adresse" htmlFor="address">
              <Input id="address" name="address" defaultValue={settings.address ?? ""} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Ville" htmlFor="city">
                <Input id="city" name="city" defaultValue={settings.city ?? ""} />
              </Field>
              <Field label="Pays" htmlFor="country">
                <Input id="country" name="country" defaultValue={settings.country} />
              </Field>
            </div>
          </FieldGroup>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Devise</p>
              <p className="text-xs text-muted-foreground">Fixée pour cette installation — non modifiable ici.</p>
            </div>
            <span className="rounded-lg bg-background px-2.5 py-1 text-sm font-bold tabular-nums shadow-xs">{settings.currency}</span>
          </div>
        </div>
      </SettingsForm>
    </div>
  );
}

function PreviewLine({ icon: Icon, value, placeholder }: { icon: typeof Mail; value: string | null; placeholder: string }) {
  return (
    <li className={cn("flex items-center gap-2.5", value ? "text-foreground" : "text-muted-foreground/70 italic")}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{value || `${placeholder} non renseigné`}</span>
    </li>
  );
}

/** Commandes: the order number prefix, previewed as the next order number. */
export function OrderNumberingForm({ settings }: { settings: BusinessSettings }) {
  return (
    <ValueTile
      anchor="prefixe"
      section="commandes"
      icon={Hash}
      title="Numéro des commandes"
      summary="Identifie chaque commande créée dans ASODITECH, partout dans l'application."
      value={<span className="font-mono tracking-normal">{orderNumberPreview(settings.orderNumberPrefix)}</span>}
      valueCaption={`Préfixe « ${settings.orderNumberPrefix} » — prochain numéro attribué`}
      note="Les numéros déjà attribués ne changent pas."
      action={updateBusinessSettingsAction}
      success="Préfixe des commandes enregistré."
    >
      <Field label="Préfixe des numéros de commande" htmlFor="orderNumberPrefix">
        <Input id="orderNumberPrefix" name="orderNumberPrefix" maxLength={10} defaultValue={settings.orderNumberPrefix} className="font-mono sm:w-48" autoFocus />
      </Field>
    </ValueTile>
  );
}

/** Stock & Achats: the default low-stock threshold for new products. */
export function StockThresholdForm({ settings }: { settings: BusinessSettings }) {
  return (
    <ValueTile
      anchor="seuil"
      section="stock"
      icon={Gauge}
      title="Seuil de stock faible"
      summary="Proposé à la création d'un produit ; chaque produit garde ensuite son propre seuil."
      value={
        <>
          {settings.lowStockDefaultThreshold} <span className="text-sm font-medium text-muted-foreground">unités</span>
        </>
      }
      valueCaption="Alerte « stock faible » par défaut"
      action={updateBusinessSettingsAction}
      success="Seuil de stock faible enregistré."
    >
      <Field label="Seuil par défaut (unités)" htmlFor="lowStockDefaultThreshold">
        <Input
          id="lowStockDefaultThreshold"
          name="lowStockDefaultThreshold"
          type="number"
          min="0"
          defaultValue={settings.lowStockDefaultThreshold}
          className="sm:w-32"
          autoFocus
        />
      </Field>
    </ValueTile>
  );
}

/** Support: a preview of what the help centre shows + the contact form (floating save bar). */
export function SupportSettingsForm({ settings }: { settings: BusinessSettings }) {
  const contacts = [
    { icon: MessageCircle, label: "WhatsApp", value: settings.supportWhatsapp },
    { icon: Phone, label: "Téléphone", value: settings.supportPhone },
    { icon: AtSign, label: "E-mail", value: settings.supportEmail },
  ];
  return (
    <div id="contacts" className="grid scroll-mt-24 gap-5 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <aside className="overflow-hidden rounded-2xl border bg-card shadow-xs">
        <div className="border-b bg-muted/40 px-5 py-2.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Ce que voient vos équipes
        </div>
        <div className="space-y-4 p-5">
          <div>
            <p className="text-base font-semibold">{settings.supportName || "Support"}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" />
              {settings.supportHours || "Horaires non renseignés"}
            </p>
          </div>
          <ul className="space-y-2">
            {contacts.map((c) => (
              <li
                key={c.label}
                className={cn(
                  "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm",
                  c.value ? "border-teal-500/30 bg-teal-500/5" : "border-dashed text-muted-foreground"
                )}
              >
                <c.icon className={cn("size-4 shrink-0", c.value ? "text-teal-600 dark:text-teal-400" : "")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{c.label}</span>
                  <span className="block truncate text-xs">{c.value || "Non affiché"}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Un contact vide est simplement masqué dans le centre d&apos;aide.</p>
        </div>
      </aside>

      <SettingsForm action={updateBusinessSettingsAction} success="Coordonnées du support enregistrées." className="rounded-2xl border bg-card p-5 shadow-xs sm:p-6">
        <div className="space-y-7">
          <FieldGroup title="Présentation">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nom du support" htmlFor="supportName">
                <Input id="supportName" name="supportName" defaultValue={settings.supportName ?? ""} placeholder="Ex. : YounessWeb Support" />
              </Field>
              <Field label="Horaires" htmlFor="supportHours">
                <Input id="supportHours" name="supportHours" defaultValue={settings.supportHours ?? ""} placeholder="Ex. : Lun–Sam, 9h–18h" />
              </Field>
            </div>
          </FieldGroup>
          <FieldGroup title="Moyens de contact">
            <p className="-mt-1 text-xs text-muted-foreground">WhatsApp et téléphone sont indépendants : un numéro de téléphone n&apos;est pas forcément joignable sur WhatsApp.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="WhatsApp" htmlFor="supportWhatsapp">
                <Input id="supportWhatsapp" name="supportWhatsapp" defaultValue={settings.supportWhatsapp ?? ""} placeholder="+212XXXXXXXXX" />
              </Field>
              <Field label="Téléphone" htmlFor="supportPhone">
                <Input id="supportPhone" name="supportPhone" defaultValue={settings.supportPhone ?? ""} placeholder="+212XXXXXXXXX" />
              </Field>
            </div>
            <Field label="E-mail du support" htmlFor="supportEmail">
              <Input id="supportEmail" name="supportEmail" type="email" defaultValue={settings.supportEmail ?? ""} placeholder="support@example.com" />
            </Field>
          </FieldGroup>
        </div>
      </SettingsForm>
    </div>
  );
}
