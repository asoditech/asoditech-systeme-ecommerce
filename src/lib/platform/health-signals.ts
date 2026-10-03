/**
 * Platform health panel — pure, testable helpers (no DB, no secrets out).
 * The checks themselves run in src/lib/queries/platform-health.ts; the page
 * is src/app/platform/sante/page.tsx (platform admins only).
 *
 * Principle: report only what this runtime actually verified. A check that
 * could not run is "unknown", never green.
 */

export type CheckState = "ok" | "warning" | "error" | "unknown";

/** Sanitized database error categories — never the raw message (it can carry hosts, SQL or data). */
export type DbErrorCategory = "unreachable" | "auth" | "timeout" | "pool" | "missing-database" | "permission" | "unknown";

export const DB_ERROR_LABELS: Record<DbErrorCategory, string> = {
  unreachable: "Serveur de base de données injoignable",
  auth: "Authentification refusée par la base de données",
  timeout: "La base de données n'a pas répondu à temps",
  pool: "Toutes les connexions de la base sont occupées",
  "missing-database": "Base de données introuvable",
  permission: "Droits insuffisants pour cette vérification",
  unknown: "Erreur de base de données non classée",
};

export class HealthCheckTimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms} ms`);
    this.name = "HealthCheckTimeoutError";
  }
}

/** Maps a Prisma / Postgres failure to a sanitized category, by error code only. */
export function classifyDbError(error: unknown): DbErrorCategory {
  if (error instanceof HealthCheckTimeoutError) return "timeout";
  const e = error as { errorCode?: unknown; code?: unknown; meta?: { code?: unknown }; message?: unknown } | null;
  const code = String(e?.errorCode ?? e?.code ?? "");
  const pgCode = String(e?.meta?.code ?? "");
  switch (code) {
    case "P1000":
      return "auth";
    case "P1001":
    case "P1017":
      return "unreachable";
    case "P1002":
    case "P1008":
      return "timeout";
    case "P1003":
      return "missing-database";
    case "P2024":
      return "pool";
    case "P1010":
      return "permission";
  }
  // Raw-query failures carry the Postgres SQLSTATE: 42501 insufficient_privilege.
  if (pgCode === "42501" || /permission denied/i.test(String(e?.message ?? ""))) return "permission";
  return "unknown";
}

/** Rejects with HealthCheckTimeoutError after `ms` — a hung connection must not hang the page. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HealthCheckTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The Supabase project ref this deployment's database belongs to, derived
 * from the connection URL ALREADY configured for the runtime — never guessed:
 *   - pooler: user "<role>.<ref>" on "*.pooler.supabase.com";
 *   - direct: host "db.<ref>.supabase.co".
 * Returns only the ref (a public project identifier that appears in every
 * dashboard URL); null for any non-Supabase or unparsable URL.
 */
export function supabaseProjectRef(databaseUrl: string | null | undefined): string | null {
  if (!databaseUrl) return null;
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isRef = (s: string) => /^[a-z0-9]{20}$/.test(s);
  if (host.endsWith(".pooler.supabase.com")) {
    const user = decodeURIComponent(url.username);
    const ref = user.includes(".") ? user.slice(user.lastIndexOf(".") + 1) : "";
    return isRef(ref) ? ref : null;
  }
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(host);
  return direct && isRef(direct[1]) ? direct[1] : null;
}

export interface ExternalLink {
  label: string;
  href: string;
  hint: string;
}

/** Supabase dashboard destinations for a verified project ref. */
export function supabaseLinks(ref: string): ExternalLink[] {
  const base = `https://supabase.com/dashboard/project/${ref}`;
  return [
    { label: "Projet Supabase", href: base, hint: "État du projet (actif ou en pause), base de données, sauvegardes." },
    { label: "Journaux Supabase", href: `${base}/logs/explorer`, hint: "Journaux de la base de données (Postgres) et du pooler de connexions." },
  ];
}

/**
 * Vercel project of this application. Verified from the Vercel CLI output for
 * this repository (team « asoditech », project « asoditech-systeme-ecommerce »,
 * see .vercel/repo.json) — not derived at runtime: Vercel exposes no team slug
 * to the running app.
 */
export const VERCEL_PROJECT_URL = "https://vercel.com/asoditech/asoditech-systeme-ecommerce";

export function vercelLinks(): ExternalLink[] {
  return [
    { label: "Déploiements Vercel", href: `${VERCEL_PROJECT_URL}/deployments`, hint: "Liste des déploiements, journaux de build et migrations (prisma migrate deploy)." },
    { label: "Journaux Vercel", href: `${VERCEL_PROJECT_URL}/logs`, hint: "Journaux d'exécution de l'application (requêtes, erreurs serveur)." },
  ];
}

export interface DeploymentInfo {
  environment: string;
  deploymentId: string | null;
  commit: string | null;
  region: string | null;
  url: string | null;
}

/** Deployment facts Vercel exposes to the runtime (system env vars). Absent locally or on a CLI upload without git metadata. */
export function deploymentInfo(env: Record<string, string | undefined>): DeploymentInfo {
  const v = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  return {
    environment: v("VERCEL_ENV") ?? v("NODE_ENV") ?? "inconnu",
    deploymentId: v("VERCEL_DEPLOYMENT_ID"),
    commit: v("VERCEL_GIT_COMMIT_SHA")?.slice(0, 7) ?? null,
    region: v("VERCEL_REGION"),
    url: v("VERCEL_URL"),
  };
}

export interface MigrationRow {
  name: string;
  finishedAt: Date | null;
  rolledBackAt: Date | null;
}

export interface MigrationStatus {
  state: CheckState;
  applied: number;
  unfinished: string[];
  lastApplied: { name: string; at: Date } | null;
  /** Migrations shipped with this deployment but not applied — null when the deployment's list was not readable. */
  pending: string[] | null;
  summary: string;
}

/**
 * Compares the database's _prisma_migrations rows with the migration folders
 * shipped in this deployment (`expected`, null when unreadable).
 */
export function evaluateMigrations(rows: MigrationRow[], expected: string[] | null): MigrationStatus {
  const finished = rows.filter((r) => r.finishedAt && !r.rolledBackAt);
  const unfinished = rows.filter((r) => !r.finishedAt && !r.rolledBackAt).map((r) => r.name);
  const appliedNames = new Set(finished.map((r) => r.name));
  const last = [...finished].sort((a, b) => a.name.localeCompare(b.name)).at(-1) ?? null;
  const pending = expected ? expected.filter((n) => !appliedNames.has(n)).sort() : null;

  let state: CheckState;
  let summary: string;
  if (unfinished.length > 0) {
    state = "error";
    summary = `${unfinished.length} migration(s) commencée(s) mais non terminée(s) : le déploiement suivant échouera tant que ce n'est pas résolu.`;
  } else if (pending === null) {
    state = "unknown";
    summary = `${finished.length} migrations appliquées. Liste des migrations de ce déploiement non lisible : comparaison non vérifiée.`;
  } else if (pending.length > 0) {
    state = "warning";
    summary = `${pending.length} migration(s) de ce déploiement pas encore appliquée(s) à la base.`;
  } else {
    state = "ok";
    summary = `${finished.length} migrations appliquées, conformes à ce déploiement.`;
  }
  return {
    state,
    applied: finished.length,
    unfinished,
    lastApplied: last ? { name: last.name, at: last.finishedAt! } : null,
    pending,
    summary,
  };
}
