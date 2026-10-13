import { Inbox, MoreHorizontal, Pencil, Plus, ShoppingCart, Users, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldHint, FieldRow } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Progress } from "@/components/ui/progress";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DataTablePagination } from "@/components/data-table-pagination";
import { EmptyState } from "@/components/empty-state";
import { KpiCard } from "@/components/kpi-card";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { ORDER_PAYMENT_STATUS_LABELS, ORDER_STATUS_LABELS } from "@/lib/status-labels";
import { InteractiveDemos } from "./interactive";

const ROWS = [
  { ref: "CMD-000017", date: "12 oct. · 2 articles", client: "Salma Bennani", city: "Casablanca", status: "NOUVELLE", total: "1.500,00 MAD" },
  { ref: "CMD-000016", date: "12 oct. · 1 article", client: "Youssef Alaoui", city: "Rabat", status: "EN_PREPARATION", total: "349,00 MAD" },
  { ref: "CMD-000015", date: "11 oct. · 3 articles", client: "Imane Tazi", city: "Marrakech", status: "EXPEDIEE", total: "2.180,50 MAD" },
  { ref: "CMD-000014", date: "10 oct. · 1 article", client: "Karim El Idrissi", city: "Fès", status: "LIVREE", total: "199,00 MAD" },
  { ref: "CMD-000013", date: "10 oct. · 2 articles", client: "Nadia Chraibi", city: "Tanger", status: "ANNULEE", total: "820,00 MAD" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-sm font-medium text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

/** Every shared component once — rendered by page.tsx in a light and a dark panel. */
export function Showcase({ id }: { id: string }) {
  return (
    <div className="space-y-10">
      <PageHeader
        title="Commandes"
        description="Toutes les commandes, toutes sources confondues."
        breadcrumbs={[{ label: "Ventes", href: "#" }, { label: "Commandes" }]}
        actions={
          <>
            <Button variant="outline">Exporter</Button>
            <Button>
              <Plus data-icon="inline-start" />
              Nouvelle commande
            </Button>
          </>
        }
      />

      <Section title="Boutons — variantes">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Principal</Button>
          <Button variant="secondary">Secondaire</Button>
          <Button variant="outline">Contour</Button>
          <Button variant="ghost">Discret</Button>
          <Button variant="destructive">Supprimer</Button>
          <Button variant="link">Lien</Button>
          <Button loading>Chargement</Button>
          <Button disabled>Désactivé</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg">Grand</Button>
          <Button size="sm">Petit</Button>
          <Button size="xs" variant="outline">
            Très petit
          </Button>
          <Button size="icon" variant="outline" aria-label="Ajouter">
            <Plus />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Modifier">
            <Pencil />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Plus d'actions">
            <MoreHorizontal />
          </Button>
        </div>
      </Section>

      <Section title="Contrôle segmenté">
        <SegmentedControl>
          <SegmentedControlItem href="#" active>
            Ce mois-ci
          </SegmentedControlItem>
          <SegmentedControlItem href="#" active={false}>
            Ce trimestre
          </SegmentedControlItem>
          <SegmentedControlItem href="#" active={false}>
            Toute la période
          </SegmentedControlItem>
        </SegmentedControl>
      </Section>

      <Section title="Pastilles de statut (commandes · paiement · intentions)">
        <div className="flex flex-wrap gap-2">
          {Object.keys(ORDER_STATUS_LABELS).map((s) => (
            <StatusBadge key={s} status={s} labels={ORDER_STATUS_LABELS} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {Object.keys(ORDER_PAYMENT_STATUS_LABELS).map((s) => (
            <StatusBadge key={s} status={s} labels={ORDER_PAYMENT_STATUS_LABELS} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {(["default", "success", "warning", "info", "purple", "secondary", "destructive", "outline"] as const).map((v) => (
            <Badge key={v} variant={v}>
              {v}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="Cartes">
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle accent="green">Chiffre d&apos;affaires</CardTitle>
              <CardDescription>Barre pastel optionnelle avant le titre.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" className="rounded-full">
                  Ce mois-ci
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="text-[40px] leading-none font-semibold tracking-tight text-ink tabular-nums">128.450,00 MAD</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle accent="purple">Objectif mensuel</CardTitle>
              <CardDescription>Avec pied de carte.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Progress value={64} />
              <p className="text-xs text-ink-muted">64 % atteint</p>
            </CardContent>
            <CardFooter>
              <Button variant="ghost" size="sm">
                Voir le détail
              </Button>
            </CardFooter>
          </Card>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Commandes (ce mois)" value="248" icon={ShoppingCart} trend={{ direction: "up", label: "+12,4 %" }} hint="vs mois dernier" />
          <KpiCard label="Panier moyen" value="518,00 MAD" icon={Wallet} tone="success" trend={{ direction: "down", label: "-3,1 %" }} />
          <KpiCard label="Nouveaux clients" value="37" icon={Users} tone="info" trend={{ direction: "flat", label: "0 %" }} />
          <KpiCard label="Bénéfice net" value={null} icon={Wallet} tone="violet" unavailableReason="Non calculable" hint="Coût d'achat manquant" />
        </div>
      </Section>

      <Section title="Formulaire">
        <Card>
          <CardContent className="space-y-5">
            <FieldRow>
              <Field>
                <Label htmlFor={`${id}-name`} required>
                  Nom du client
                </Label>
                <Input id={`${id}-name`} placeholder="Ex. Salma Bennani" />
                <FieldHint>Tel qu&apos;il apparaîtra sur l&apos;étiquette.</FieldHint>
              </Field>
              <Field>
                <Label htmlFor={`${id}-phone`}>Téléphone</Label>
                <Input id={`${id}-phone`} defaultValue="06 12 34 56" aria-invalid />
                <FieldError>Numéro incomplet.</FieldError>
              </Field>
            </FieldRow>
            <FieldRow>
              <Field>
                <Label htmlFor={`${id}-city`}>Ville (select natif)</Label>
                <NativeSelect id={`${id}-city`} defaultValue="casa">
                  <option value="casa">Casablanca</option>
                  <option value="rabat">Rabat</option>
                </NativeSelect>
              </Field>
              <Field>
                <Label htmlFor={`${id}-disabled`}>Désactivé</Label>
                <Input id={`${id}-disabled`} disabled defaultValue="Non modifiable" />
              </Field>
            </FieldRow>
            <Field>
              <Label htmlFor={`${id}-note`}>Note</Label>
              <Textarea id={`${id}-note`} placeholder="Instructions de livraison…" />
            </Field>
          </CardContent>
        </Card>
      </Section>

      <Section title="Contrôles interactifs (select, date, onglets, cases, menus, dialogues, toasts)">
        <InteractiveDemos id={id} />
      </Section>

      <Section title="Tableau + pagination">
        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((r) => (
                <TableRow key={r.ref}>
                  <TableCell>
                    <p className="font-medium text-ink">{r.ref}</p>
                    <p className="text-xs text-ink-muted">{r.date}</p>
                  </TableCell>
                  <TableCell>
                    <p className="text-ink">{r.client}</p>
                    <p className="text-xs text-ink-muted">{r.city}</p>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} labels={ORDER_STATUS_LABELS} />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{r.total}</TableCell>
                  <TableCell>
                    <div data-row-actions="" className="flex justify-end gap-1">
                      <Button size="icon-sm" variant="ghost" aria-label={`Modifier ${r.ref}`}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Plus d'actions pour ${r.ref}`}>
                        <MoreHorizontal />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataTablePagination page={3} pageSize={10} total={200} basePath="/dev/components" pageSizeOptions={[10, 50, 100]} />
        </Card>
      </Section>

      <Section title="État vide · squelettes">
        <EmptyState
          icon={Inbox}
          title="Aucune commande"
          description="Les commandes importées ou créées apparaîtront ici."
          action={<Button variant="outline">Créer une commande</Button>}
        />
        <Card>
          <CardContent className="space-y-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
