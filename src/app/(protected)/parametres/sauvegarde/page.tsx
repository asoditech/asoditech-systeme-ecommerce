import { PageHeader } from "@/components/page-header";
import { SettingsNav } from "@/components/settings/settings-nav";
import { BackupPanel } from "@/components/settings/backup-panel";
import { requirePermission } from "@/lib/auth/guards";
import { getBackupStatus } from "@/lib/queries/backup";

export const metadata = { title: "Sauvegarde & Portabilité — ASODITECH Gestion E-commerce" };

export default async function SauvegardePage() {
  // settings.manage (OWNER / ADMIN) — a backup is a full copy of the
  // tenant's business data; restore replaces it.
  await requirePermission("settings.manage");
  const status = await getBackupStatus();

  return (
    <div>
      <PageHeader
        title="Sauvegarde & Portabilité"
        description="Exportez, téléchargez et restaurez les données de votre entreprise. Chiffré, isolé par compte, sans secret."
      />
      <div className="max-w-3xl">
        <SettingsNav canManage />
        <BackupPanel status={status} />
        <p className="mt-6 text-xs text-muted-foreground">
          La source de vérité reste la base de données. Une sauvegarde `.asb` est un instantané chiffré, exclusivement de
          vos propres données. Les mots de passe, jetons de session, clés d&apos;API et identifiants de connecteurs n&apos;y
          figurent jamais.
        </p>
      </div>
    </div>
  );
}
