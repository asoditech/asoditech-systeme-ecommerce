import "server-only";

import { readdir } from "node:fs/promises";
import path from "node:path";
import { prismaBase } from "@/lib/prisma";
import { runUnscoped } from "@/lib/tenant/context";
import { env } from "@/lib/env";
import {
  classifyDbError,
  DB_ERROR_LABELS,
  deploymentInfo,
  evaluateMigrations,
  supabaseLinks,
  supabaseProjectRef,
  vercelLinks,
  withTimeout,
  type CheckState,
  type DeploymentInfo,
  type ExternalLink,
  type MigrationRow,
  type MigrationStatus,
} from "@/lib/platform/health-signals";

/**
 * On-demand platform health checks for /platform/sante (platform admins
 * only — the caller is behind requirePlatformAdmin). Every check is
 * READ-ONLY, bounded by a timeout, and run only when the page is opened or
 * « Revérifier » is clicked: no polling, no write, no diagnostic that scans
 * customer data. Errors are reported as sanitized categories only — never a
 * connection string, host, SQL text or raw driver message.
 */

const DB_TIMEOUT_MS = 5_000;

export interface HealthCheckResult {
  key: "app" | "database" | "migrations" | "integrations";
  title: string;
  state: CheckState;
  summary: string;
  details: string[];
}

export interface PlatformHealthReport {
  checkedAt: Date;
  checks: HealthCheckResult[];
  deployment: DeploymentInfo;
  migrations: MigrationStatus | null;
  links: { vercel: ExternalLink[]; supabase: ExternalLink[] | null };
}

async function readShippedMigrations(): Promise<string[] | null> {
  try {
    const entries = await readdir(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true });
    const names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    return names.length > 0 ? names.sort() : null;
  } catch {
    return null;
  }
}

export async function runPlatformHealthChecks(): Promise<PlatformHealthReport> {
  const checkedAt = new Date();
  const deployment = deploymentInfo(process.env);

  const app: HealthCheckResult = {
    key: "app",
    title: "Application",
    state: "ok",
    summary: "Le serveur de l'application a répondu et a généré cette page.",
    details: [
      `Environnement : ${deployment.environment}`,
      deployment.region ? `Région d'exécution : ${deployment.region}` : "Région d'exécution : non communiquée",
    ],
  };

  // 1. Database connectivity — the cheapest possible round trip.
  let database: HealthCheckResult;
  let dbReachable = false;
  const started = Date.now();
  try {
    await withTimeout(prismaBase.$queryRaw`SELECT 1`, DB_TIMEOUT_MS);
    dbReachable = true;
    database = {
      key: "database",
      title: "Base de données — connexion",
      state: "ok",
      summary: `Requête de test réussie en ${Date.now() - started} ms.`,
      details: ["Vérifié : la connexion s'ouvre et la base exécute une requête.", "Non vérifié par ce test : contenu, performances sous charge, sauvegardes."],
    };
  } catch (error) {
    const category = classifyDbError(error);
    database = {
      key: "database",
      title: "Base de données — connexion",
      state: "error",
      summary: DB_ERROR_LABELS[category],
      details: [`Catégorie : ${category}`, `Échec après ${Date.now() - started} ms.`],
    };
  }

  // 2. Schema / migrations — only meaningful if the connection works.
  let migrations: MigrationStatus | null = null;
  let migrationsCheck: HealthCheckResult;
  if (!dbReachable) {
    migrationsCheck = {
      key: "migrations",
      title: "Base de données — schéma (migrations)",
      state: "unknown",
      summary: "Non vérifié : la connexion à la base a échoué.",
      details: [],
    };
  } else {
    try {
      const rows = await withTimeout(
        prismaBase.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
          SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`,
        DB_TIMEOUT_MS
      );
      const mapped: MigrationRow[] = rows.map((r) => ({ name: r.migration_name, finishedAt: r.finished_at, rolledBackAt: r.rolled_back_at }));
      migrations = evaluateMigrations(mapped, await readShippedMigrations());
      migrationsCheck = {
        key: "migrations",
        title: "Base de données — schéma (migrations)",
        state: migrations.state,
        summary: migrations.summary,
        details: [
          migrations.lastApplied ? `Dernière migration appliquée : ${migrations.lastApplied.name}` : "Aucune migration appliquée.",
          ...(migrations.pending && migrations.pending.length > 0 ? [`En attente : ${migrations.pending.join(", ")}`] : []),
          ...(migrations.unfinished.length > 0 ? [`Inachevée(s) : ${migrations.unfinished.join(", ")}`] : []),
        ],
      };
    } catch (error) {
      const category = classifyDbError(error);
      migrationsCheck = {
        key: "migrations",
        title: "Base de données — schéma (migrations)",
        state: "unknown",
        summary: `Non vérifié : ${DB_ERROR_LABELS[category].toLowerCase()}.`,
        details: [],
      };
    }
  }

  // 3. External integrations — aggregate counts only (no customer data, no error text).
  let integrations: HealthCheckResult;
  if (!dbReachable) {
    integrations = { key: "integrations", title: "Intégrations externes", state: "unknown", summary: "Non vérifié : la connexion à la base a échoué.", details: [] };
  } else {
    try {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const [byStatus, last, failedRuns] = await withTimeout(
        runUnscoped("platform:health", () =>
          Promise.all([
            prismaBase.integration.groupBy({ by: ["status"], _count: true }),
            prismaBase.integration.aggregate({ _max: { lastConnectionCheckAt: true, lastSyncAt: true } }),
            prismaBase.syncRun.count({ where: { status: "ECHEC", startedAt: { gte: since } } }),
          ])
        ),
        DB_TIMEOUT_MS
      );
      const count = (s: string) => byStatus.find((g) => g.status === s)?._count ?? 0;
      const total = byStatus.reduce((n, g) => n + g._count, 0);
      const inError = count("ERREUR");
      const fmt = (d: Date | null) => (d ? d.toISOString() : null);
      integrations = {
        key: "integrations",
        title: "Intégrations externes",
        state: total === 0 ? "unknown" : inError > 0 || failedRuns > 0 ? "warning" : "ok",
        summary:
          total === 0
            ? "Aucune intégration configurée : rien à vérifier."
            : `${count("CONNECTE")} connectée(s), ${inError} en erreur, ${total} au total (tous clients). ${failedRuns} synchronisation(s) en échec sur 24 h.`,
        details: [
          `Dernier test de connexion enregistré : ${fmt(last._max.lastConnectionCheckAt) ?? "jamais"}`,
          `Dernière synchronisation enregistrée : ${fmt(last._max.lastSyncAt) ?? "jamais"}`,
          "Ce sont les derniers résultats enregistrés par l'application : aucune boutique n'est contactée par cette page.",
        ],
      };
    } catch (error) {
      integrations = {
        key: "integrations",
        title: "Intégrations externes",
        state: "unknown",
        summary: `Non vérifié : ${DB_ERROR_LABELS[classifyDbError(error)].toLowerCase()}.`,
        details: [],
      };
    }
  }

  const ref = supabaseProjectRef(env.DATABASE_URL);
  return {
    checkedAt,
    checks: [app, database, migrationsCheck, integrations],
    deployment,
    migrations,
    links: { vercel: vercelLinks(), supabase: ref ? supabaseLinks(ref) : null },
  };
}
