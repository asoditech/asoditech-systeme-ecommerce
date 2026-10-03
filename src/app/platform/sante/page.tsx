import { ExternalLink as ExternalLinkIcon, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runPlatformHealthChecks } from "@/lib/queries/platform-health";
import { formatDateTime } from "@/lib/format";
import type { CheckState, ExternalLink } from "@/lib/platform/health-signals";

export const metadata = { title: "Santé — Plateforme ASODITECH" };
// Every visit re-runs the (read-only, bounded) checks — never a cached status.
export const dynamic = "force-dynamic";

const STATE_BADGE: Record<CheckState, { label: string; className: string }> = {
  ok: { label: "OK", className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-400" },
  warning: { label: "Attention", className: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-400" },
  error: { label: "Erreur", className: "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-400" },
  unknown: { label: "Non vérifié", className: "text-muted-foreground" },
};

/**
 * Platform health (platform admins only — requirePlatformAdmin here, and in
 * the /platform layout). Shows ONLY what this server verified just now, on
 * demand: no polling, no writes, no raw errors or connection details. See
 * src/lib/queries/platform-health.ts for what each check does and does not cover.
 */
export default async function PlatformHealthPage() {
  await requirePlatformAdmin();
  const report = await runPlatformHealthChecks();
  const d = report.deployment;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Santé de la plateforme"
        description={`Vérifié le ${formatDateTime(report.checkedAt)} par ce serveur, à l'ouverture de la page.`}
        actions={
          // A plain anchor: a full reload re-runs every check.
          <Button size="sm" variant="outline" render={<a href="/platform/sante" />}>
            <RefreshCw className="size-3.5" />
            Revérifier
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-2">
        {report.checks.map((c) => (
          <Card key={c.key}>
            <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
              <CardTitle className="text-[15px]">{c.title}</CardTitle>
              <Badge variant="outline" className={STATE_BADGE[c.state].className}>
                {STATE_BADGE[c.state].label}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p>{c.summary}</p>
              {c.details.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                  {c.details.map((line) => (
                    <li key={line} className="break-words">{line}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Déploiement en cours</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <Fact label="Environnement" value={d.environment} />
          <Fact label="Identifiant de déploiement" value={d.deploymentId} missing="Non communiqué (hors Vercel)" mono />
          <Fact label="Commit" value={d.commit} missing="Non communiqué (déploiement sans métadonnées git, ex. envoi par la CLI)" mono />
          <Fact label="Région" value={d.region} missing="Non communiquée" />
          <Fact label="Adresse du déploiement" value={d.url} missing="Non communiquée" mono />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Journaux et tableaux de bord externes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-xs text-muted-foreground">
            Ces liens ouvrent les consoles de Vercel et de Supabase dans un nouvel onglet. Il faut un compte ayant accès à
            ces projets : l&apos;application elle-même ne lit pas ces journaux.
          </p>
          <LinkGroup
            title="Vercel — l'application (déploiements, build, exécution)"
            links={report.links.vercel}
          />
          {report.links.supabase ? (
            <LinkGroup title="Supabase — la base de données" links={report.links.supabase} />
          ) : (
            <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              Supabase : lien non disponible. La base configurée pour ce serveur n&apos;est pas reconnue comme un projet
              Supabase hébergé (par exemple une base locale), donc aucun identifiant de projet fiable n&apos;est connu.
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">Que faire selon le problème ?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Guidance title="Problème d'application">
            Cette page ne s&apos;affiche pas, ou des pages renvoient une erreur. Ouvrez « Journaux Vercel » et cherchez les
            erreurs à l&apos;heure du problème.
          </Guidance>
          <Guidance title="Problème de connexion à la base de données">
            « Base de données — connexion » est en erreur. Ouvrez « Projet Supabase » et vérifiez que le projet est actif
            (un projet Supabase peut être mis en pause) ; si la catégorie est « authentification », la variable
            DATABASE_URL de Vercel ne correspond plus au mot de passe de la base.
          </Guidance>
          <Guidance title="Problème de déploiement / build">
            Une migration est inachevée ou en attente, ou le commit affiché n&apos;est pas celui attendu. Ouvrez
            « Déploiements Vercel » et lisez le journal de build (étape prisma migrate deploy). Aucune action automatique
            n&apos;est faite depuis cette page.
          </Guidance>
          <Guidance title="Problème d'intégration externe">
            Des intégrations sont en erreur ou des synchronisations échouent. Le client concerné voit le détail dans
            Intégrations ; testez la connexion depuis son espace ou contactez-le.
          </Guidance>
          <p className="text-xs text-muted-foreground">
            La page « Utilisation » mesure le volume de données par client et la taille de la base : elle ne dit rien de la
            santé de l&apos;application.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Fact({ label, value, missing, mono }: { label: string; value: string | null; missing?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      {value ? (
        <p className={mono ? "break-all font-mono text-xs" : ""}>{value}</p>
      ) : (
        <p className="text-xs text-muted-foreground italic">{missing ?? "—"}</p>
      )}
    </div>
  );
}

function LinkGroup({ title, links }: { title: string; links: ExternalLink[] }) {
  return (
    <div className="space-y-2">
      <p className="font-medium">{title}</p>
      <ul className="space-y-2">
        {links.map((l) => (
          <li key={l.href} className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <a
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-primary underline-offset-4 hover:underline"
            >
              {l.label}
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(nouvel onglet)</span>
            </a>
            <span className="text-xs text-muted-foreground">{l.hint}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Guidance({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground">{children}</p>
    </div>
  );
}
