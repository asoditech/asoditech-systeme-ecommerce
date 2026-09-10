import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { BackupPanel } from "@/components/settings/backup-panel";
import { requirePermission } from "@/lib/auth/guards";
import { getBackupStatus } from "@/lib/queries/backup";

export const metadata = { title: "Sauvegarde & Portabilité — ASODITECH Gestion E-commerce" };

const GOOGLE_NOTICE: Record<string, { tone: "ok" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Google Drive connecté." },
  denied: { tone: "warn", text: "Connexion Google refusée ou révoquée. Réessayez." },
  state: { tone: "warn", text: "Requête d'autorisation expirée. Relancez la connexion." },
  forbidden: { tone: "warn", text: "Réservé aux OWNER / ADMIN (settings.manage)." },
  unconfigured: { tone: "warn", text: "Google Drive n'est pas configuré sur ce déploiement." },
  error: { tone: "warn", text: "La connexion Google Drive a échoué. Réessayez." },
};

export default async function SauvegardePage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  // settings.manage (OWNER / ADMIN) — a backup is a full copy of the
  // tenant's business data; restore replaces it.
  const user = await requirePermission("settings.manage");
  const { google } = await searchParams;
  const status = await getBackupStatus(user.tenantId);
  const notice = google ? GOOGLE_NOTICE[google] ?? null : null;

  return (
    <div>
      <PageHeader
        title="Sauvegarde & Portabilité"
        description="Exportez, téléchargez et restaurez les données de votre entreprise. Chiffré, isolé par compte, sans secret."
      />
      <div className="max-w-3xl">
        <SettingsNav canManage />
        {notice && (
          <p
            className={
              "mb-4 rounded-md border px-3 py-2 text-xs " +
              (notice.tone === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400")
            }
          >
            {notice.text}
          </p>
        )}
        <BackupPanel status={status} />
        <p className="mt-6 text-xs text-muted-foreground">
          La source de vérité reste la base de données. Une sauvegarde `.asb` est un instantané chiffré, exclusivement de
          vos propres données. Les mots de passe, jetons de session, clés d&apos;API et identifiants de connecteurs n&apos;y
          figurent jamais. Google Drive stocke ce même paquet chiffré, dans votre propre Drive.
        </p>
      </div>
    </div>
  );
}
