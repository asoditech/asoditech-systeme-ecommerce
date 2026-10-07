import { Activity, ArrowLeftRight, DatabaseBackup, Inbox, Network, Percent, Plug, Store, Truck, Warehouse } from "lucide-react";
import type { BusinessSettings } from "@prisma/client";
import {
  CompanySettingsForm,
  OrderNumberingForm,
  StockThresholdForm,
  SupportSettingsForm,
} from "@/components/settings/business-settings-form";
import { CostingMethodForm } from "@/components/settings/costing-method-form";
import {
  DefaultShippingProviderForm,
  ImportAsNouvelleTile,
  PackingVerificationForm,
  SellerPriceOverrideForm,
  TransferCostOverrideForm,
} from "@/components/settings/sales-delivery-settings";
import {
  AttentionCards,
  ConfigHero,
  ConfigNav,
  DedicatedLink,
  ReadOnlyStateTile,
  SectionHeader,
  SectionTile,
  UnavailableTile,
} from "@/components/settings/config/config-blocks";
import { HashFocus } from "@/components/settings/config/config-search";
import {
  CONFIG_SECTIONS,
  configAttention,
  configHealth,
  identityCompletion,
  sectionSummary,
  sectionSwitches,
  settingsIndex,
  type ConfigContext,
  type ConfigSectionId,
  type ConfigWorkspaceId,
} from "@/lib/settings/configuration-model";

/**
 * Paramètres › Configuration — the control center.
 *
 *  - Hero: the company identity (logo, completeness), configuration health
 *    (sections in order, points to check, features on) and « Rechercher un
 *    réglage ».
 *  - Pill navigation with an icon per section (`?section=`).
 *  - Overview: genuine gaps as actionable cards, then one visual tile per
 *    section (its key value, its switches' states, attention), then the
 *    dedicated pages.
 *  - Section workspace: settings as tiles — switch tiles (state first,
 *    applied immediately), value tiles (the value previewed, inline editor),
 *    and Entreprise / Support as a live preview next to their form.
 *
 * Nothing is stored here: every control is the setting's existing form field
 * and server action. Complex management (carriers, city mappings, channels,
 * locations, integrations, backup…) stays on its own page and is only linked.
 * Business mode, plan, permissions and user preferences are NOT here.
 */

export interface ConfigurationViewProps {
  settings: BusinessSettings;
  /** Section shown (resolved from `?section=` by the page). Default: the overview. */
  section?: ConfigSectionId;
  /** Tenant in « En ligne + Magasin » mode (capability offlineSales). */
  offlineSales: boolean;
  /** Connected shop integrations and their « Toujours importer en Nouvelle » value (null = not configured). */
  imports: { woocommerce: boolean | null; shopify: boolean | null };
  canManageIntegrations: boolean;
  /** `finance.view` — purchase-cost settings are financial data (docs/adr/0043). */
  canManageCost?: boolean;
  providers: { id: string; name: string; hasCityList: boolean }[];
  /** Which advanced management pages the user may open. */
  links: { channels: boolean; delivery: boolean; warehouses: boolean; integrations: boolean; commissions: boolean; backup: boolean };
}

const WORKSPACES = CONFIG_SECTIONS.filter((s) => s.id !== "apercu").map((s) => s.id as ConfigWorkspaceId);

export function ConfigurationView(props: ConfigurationViewProps) {
  const section = props.section ?? "apercu";
  const ctx: ConfigContext = {
    settings: props.settings,
    offlineSales: props.offlineSales,
    imports: props.imports,
    providers: props.providers,
    canManageCost: props.canManageCost ?? false,
  };
  const attention = configAttention(ctx);
  const index = settingsIndex(ctx);
  const countOf = (id: ConfigWorkspaceId) => index.filter((e) => e.section === id).length;

  return (
    <div className="space-y-5">
      <ConfigHero
        companyName={props.settings.companyName}
        logoUrl={props.settings.logoUrl}
        completion={identityCompletion(props.settings).percent}
        health={configHealth(ctx)}
        index={index}
        section={section}
      />
      <ConfigNav current={section} flagged={attention.map((a) => a.section)} />
      <HashFocus section={section} />

      <div data-section={section} className="space-y-6 pt-1">
        {section === "apercu" ? (
          <>
            {attention.length > 0 && (
              <section className="space-y-3">
                <SectionTitle title="À corriger" hint="Les réglages manquants qui changent ce que voient vos équipes et vos clients." />
                <AttentionCards items={attention} />
              </section>
            )}
            <section className="space-y-3">
              <SectionTitle title="Vos réglages" hint="Chaque carte montre l'état actuel ; ouvrez-la pour modifier." />
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {WORKSPACES.map((id) => (
                  <SectionTile key={id} summary={sectionSummary(ctx, id)} settingsCount={countOf(id)} />
                ))}
              </div>
            </section>
            <DedicatedSpaces links={props.links} />
          </>
        ) : (
          <>
            <SectionHeader
              id={section}
              settingsCount={countOf(section)}
              switchesOn={sectionSwitches(ctx, section).filter((s) => s.on).length}
              switchesTotal={sectionSwitches(ctx, section).length}
            />
            <AttentionCards items={attention.filter((a) => a.section === section)} />
            <Workspace id={section} props={props} />
          </>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const tiles = "grid items-start gap-4 md:grid-cols-2";

function Workspace({ id, props }: { id: ConfigWorkspaceId; props: ConfigurationViewProps }) {
  const { settings, links } = props;
  switch (id) {
    case "entreprise":
      return <CompanySettingsForm settings={settings} />;

    case "commandes": {
      const shops = [
        { provider: "WOOCOMMERCE" as const, label: "WooCommerce", value: props.imports.woocommerce },
        { provider: "SHOPIFY" as const, label: "Shopify", value: props.imports.shopify },
      ];
      const connected = shops.filter((s) => s.value !== null);
      return (
        <>
          <div id="imports" className={`${tiles} scroll-mt-24`}>
            <OrderNumberingForm settings={settings} />
            {connected.map((s) =>
              props.canManageIntegrations ? (
                <ImportAsNouvelleTile key={s.provider} provider={s.provider} label={s.label} enabled={s.value!} />
              ) : (
                <ReadOnlyStateTile
                  key={s.provider}
                  icon={Inbox}
                  title={`${s.label} : importer en « Nouvelle »`}
                  on={s.value!}
                  note="Modifiable par les utilisateurs qui gèrent les intégrations."
                />
              )
            )}
            {connected.length === 0 && (
              <UnavailableTile
                icon={Plug}
                title="Commandes importées des boutiques"
                message="Aucune boutique WooCommerce ou Shopify connectée."
                action={links.integrations ? { href: "/integrations", label: "Connecter une boutique" } : undefined}
              />
            )}
          </div>
          <Related>
            {links.integrations && <DedicatedLink href="/integrations" icon={Plug} title="Intégrations" description="Boutiques, synchronisation, e-mail et WhatsApp." />}
            {links.commissions && <DedicatedLink href="/commissions" icon={Percent} title="Commissions" description="Agents de confirmation et montant par commande." />}
          </Related>
        </>
      );
    }

    case "expedition":
      return (
        <>
          <div className={tiles}>
            <PackingVerificationForm enabled={settings.packingVerificationRequired} />
            <DefaultShippingProviderForm providers={props.providers} defaultProviderId={settings.defaultShippingProviderId} />
          </div>
          <Related>
            {links.delivery ? (
              <>
                <DedicatedLink href="/livraison?tab=prestataires" icon={Truck} title="Prestataires & tarification" description="Transporteurs, API, frais de retour, villes." />
                <DedicatedLink href="/livraison/suivi" icon={Activity} title="Suivi des colis" description="Situation de chaque colis chez le transporteur." />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">La gestion des transporteurs nécessite l&apos;accès « Livraison ».</p>
            )}
          </Related>
        </>
      );

    case "magasin":
      return (
        <>
          <div className={tiles}>
            {props.offlineSales ? (
              <SellerPriceOverrideForm enabled={settings.allowSellerPriceOverride} />
            ) : (
              <UnavailableTile
                icon={Store}
                title="Ventes magasin non activées"
                message="Votre entreprise est en mode « En ligne » uniquement. Les ventes magasin ne sont pas activées : ce mode est géré par l'équipe ASODITECH."
              />
            )}
          </div>
          <Related>
            {links.channels && <DedicatedLink href="/parametres/canaux" icon={Network} title="Canaux de vente" description="Magasins, emplacements et produits par canal." />}
          </Related>
        </>
      );

    case "stock":
      return (
        <>
          <div className={tiles}>
            <StockThresholdForm settings={settings} />
            <CostingMethodForm settings={settings} />
            {props.canManageCost ? (
              <TransferCostOverrideForm enabled={settings.transferPurchaseCostOverrideEnabled} />
            ) : (
              <UnavailableTile
                icon={ArrowLeftRight}
                title="Coût d'achat lors des transferts"
                message="Réservé aux utilisateurs ayant accès aux données financières."
              />
            )}
          </div>
          <Related>
            {links.warehouses && <DedicatedLink href="/entrepots" icon={Warehouse} title="Emplacements" description="Entrepôts et magasins, emplacement par défaut." />}
          </Related>
        </>
      );

    case "support":
      return <SupportSettingsForm settings={settings} />;
  }
}

/** Dedicated pages linked from a section. Renders nothing when the user may open none. */
function Related({ children }: { children: React.ReactNode }) {
  const items = (Array.isArray(children) ? children : [children]).flat().filter(Boolean);
  if (items.length === 0) return null;
  return (
    <section className="space-y-3 pt-2">
      <SectionTitle title="Pour aller plus loin" />
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function DedicatedSpaces({ links }: { links: ConfigurationViewProps["links"] }) {
  const items = [
    links.integrations && { href: "/integrations", icon: Plug, title: "Intégrations", description: "Boutiques connectées, synchronisation, e-mail, WhatsApp." },
    links.delivery && { href: "/livraison?tab=prestataires", icon: Truck, title: "Transporteurs", description: "Prestataires, tarifs, correspondances de villes." },
    links.channels && { href: "/parametres/canaux", icon: Network, title: "Canaux de vente", description: "Magasins et produits disponibles par canal." },
    links.warehouses && { href: "/entrepots", icon: Warehouse, title: "Emplacements", description: "Entrepôts et magasins." },
    links.commissions && { href: "/commissions", icon: Percent, title: "Commissions", description: "Agents de confirmation." },
    links.backup && { href: "/parametres/sauvegarde", icon: DatabaseBackup, title: "Sauvegarde & Portabilité", description: "Export chiffré, Google Drive." },
  ].filter((x): x is { href: string; icon: typeof Plug; title: string; description: string } => Boolean(x));
  if (items.length === 0) return null;
  return (
    <section className="space-y-3">
      <SectionTitle title="Espaces dédiés" hint="La configuration avancée a sa propre page." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <DedicatedLink key={i.href} {...i} />
        ))}
      </div>
    </section>
  );
}
