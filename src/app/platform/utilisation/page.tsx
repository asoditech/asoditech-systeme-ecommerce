import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ForcePasswordResetButton } from "@/components/platform/force-password-reset-button";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { listTenantsWithUsage } from "@/lib/queries/platform";
import { getPlatformUsage, listTenantUsersForPlatform, USAGE_METRICS } from "@/lib/queries/platform-usage";
import { formatDateTime, formatNumber } from "@/lib/format";
import { PLAN_CODE_LABELS, SUBSCRIPTION_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Utilisation — Plateforme ASODITECH" };

const bytes = (n: number) =>
  n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} Go` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} Mo` : `${Math.round(n / 1024)} Ko`;
const label = (map: Record<string, { label: string }>, key: string) => map[key]?.label ?? key;

/**
 * Customer usage (docs/adr/0053): row counts per customer and module, 30-day
 * growth, real database / table sizes. Aggregated with one GROUP BY per table
 * and cached 5 minutes (`?actualiser=1` recomputes). `?tenant=<id>` lists that
 * customer's users with « Forcer la réinitialisation » — no password is ever shown.
 */
export default async function PlatformUsagePage({ searchParams }: { searchParams: Promise<{ tenant?: string; actualiser?: string }> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const [tenants, usage] = await Promise.all([listTenantsWithUsage(), getPlatformUsage({ fresh: sp.actualiser === "1" })]);
  const selected = sp.tenant ? tenants.find((t) => t.id === sp.tenant) ?? null : null;
  const users = selected ? await listTenantUsersForPlatform(selected.id) : [];
  const ranked = [...tenants].sort((a, b) => (usage.rows.get(b.id)?.totalRows ?? 0) - (usage.rows.get(a.id)?.totalRows ?? 0));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Utilisation par client"
        description={`Volume de données par client et taille de la base, calculés le ${formatDateTime(usage.computedAt)} (cache 5 min ; « Actualiser » recalcule, en lecture seule).`}
        actions={
          <Button size="sm" variant="outline" render={<Link href="/platform/utilisation?actualiser=1" />}>
            Actualiser
          </Button>
        }
      />

      <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        Cette page mesure l&apos;utilisation (nombre d&apos;enregistrements, croissance, taille de la base). Elle ne vérifie
        ni la disponibilité de l&apos;application, ni la connexion à la base, ni les déploiements : voir{" "}
        <Link href="/platform/sante" className="font-medium text-foreground underline-offset-4 hover:underline">
          Santé
        </Link>
        .
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Clients — du plus actif au moins actif</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="text-[12px]">
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Forfait</TableHead>
                {USAGE_METRICS.map((m) => (
                  <TableHead key={m.key} className="text-right">{m.label}</TableHead>
                ))}
                <TableHead className="text-right">30 j : commandes / ventes / mouvements</TableHead>
                <TableHead>Dernière activité</TableHead>
                <TableHead>Créé le</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ranked.map((t) => {
                const u = usage.rows.get(t.id);
                return (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      <Link href={`/platform/utilisation?tenant=${t.id}`} className="hover:underline">{t.name}</Link>
                      <div className="text-[11px] text-muted-foreground">{t.slug}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.tenantStatus === "ACTIVE" ? "secondary" : "destructive"}>{t.tenantStatus === "ACTIVE" ? "Actif" : "Suspendu"}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {PLAN_CODE_LABELS[t.planCode] ?? t.planCode} · {label(SUBSCRIPTION_STATUS_LABELS, t.subscriptionStatus)}
                    </TableCell>
                    {USAGE_METRICS.map((m) => (
                      <TableCell key={m.key} className="text-right tabular-nums">{formatNumber(u?.counts[m.key] ?? 0)}</TableCell>
                    ))}
                    <TableCell className="text-right tabular-nums">
                      {u ? `${u.last30d.orders} / ${u.last30d.sales} / ${u.last30d.movements}` : "0 / 0 / 0"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{t.lastActivityAt ? formatDateTime(t.lastActivityAt) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDateTime(t.createdAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Modules les plus utilisés (tous clients)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Module</TableHead>
                  <TableHead>Donnée</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Clients utilisateurs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.moduleTotals.map((m) => (
                  <TableRow key={m.key}>
                    <TableCell>{m.module}</TableCell>
                    <TableCell>{m.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(m.total)}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.tenantsUsing}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Taille réelle de la base (Postgres)</CardTitle>
          </CardHeader>
          <CardContent>
            {usage.database ? (
              <>
                <p className="mb-3 text-sm">
                  Base complète : <strong>{bytes(usage.database.totalBytes)}</strong> — tous clients confondus. La taille par client n&apos;est pas
                  mesurable directement ; voir les volumes de lignes ci-dessus.
                </p>
                <Table className="text-[13px]">
                  <TableBody>
                    {usage.database.tables.map((t) => (
                      <TableRow key={t.table}>
                        <TableCell className="font-mono text-xs">{t.table}</TableCell>
                        <TableCell className="text-right tabular-nums">{bytes(t.bytes)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Taille indisponible (droits de lecture du catalogue Postgres).</p>
            )}
          </CardContent>
        </Card>
      </div>

      {selected && (
        <Card>
          <CardHeader>
            <CardTitle>Utilisateurs — {selected.name}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table className="text-[13px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Nom</TableHead>
                  <TableHead>E-mail</TableHead>
                  <TableHead>Rôle</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead>Dernière connexion</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.role}</TableCell>
                    <TableCell>{u.status}</TableCell>
                    <TableCell>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "—"}</TableCell>
                    <TableCell className="text-right">
                      {!u.isPlatformAdmin && u.status === "ACTIVE" && <ForcePasswordResetButton userId={u.id} email={u.email} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
