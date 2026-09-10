"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Download, DatabaseBackup, Upload, ShieldAlert, Loader2, FileArchive, Cloud, CloudOff, Trash2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { confirmRestoreAction, discardRestoreUploadAction } from "@/actions/backup";
import {
  disconnectGoogleDriveAction,
  pushBackupToDriveAction,
  deleteDriveBackupAction,
  restoreFromDriveAction,
} from "@/actions/backup-google-drive";
import type { BackupStatusView } from "@/lib/queries/backup";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(2)} Mo`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR");
}

interface UploadPreview {
  uploadId: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  totalRows: number;
  manifest: {
    version: number | null;
    createdAt: string | null;
    appVersion: string | null;
    schemaVersion: string | null;
    tenant: { id: string; slug: string; name: string } | null;
    sameTenant: boolean;
  };
  preview: { label: string; count: number }[];
}

export function BackupPanel({ status }: { status: BackupStatusView }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [generating, startGenerate] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [restoring, startRestore] = useTransition();
  const [discarding, startDiscard] = useTransition();
  const [preview, setPreview] = useState<UploadPreview | null>(null);
  const [drivePending, startDrive] = useTransition();
  const gd = status.googleDrive;

  async function generateNow() {
    startGenerate(async () => {
      try {
        const res = await fetch("/parametres/sauvegarde/download", { method: "POST" });
        if (!res.ok) {
          toast.error((await res.text()) || "Échec de la génération.");
          return;
        }
        await triggerDownload(res);
        toast.success("Sauvegarde générée et téléchargée.");
        router.refresh();
      } catch {
        toast.error("Échec de la génération de la sauvegarde.");
      }
    });
  }

  async function triggerDownload(res: Response) {
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") ?? "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match?.[1] ?? "ASODITECH_BACKUP.asb";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await fetch("/parametres/sauvegarde/restore/upload", { method: "POST", body: fd });
      const json = (await res.json()) as UploadPreview & { error?: string };
      if (!res.ok || json.error) {
        toast.error(json.error ?? "Fichier de sauvegarde refusé.");
        return;
      }
      setPreview(json);
      router.refresh();
    } catch {
      toast.error("Échec de l'analyse du fichier.");
    } finally {
      setUploading(false);
    }
  }

  function closePreview(discard: boolean) {
    const uploadId = preview?.uploadId;
    setPreview(null);
    if (discard && uploadId) {
      startDiscard(async () => {
        const fd = new FormData();
        fd.set("uploadId", uploadId);
        await discardRestoreUploadAction(fd);
        router.refresh();
      });
    }
  }

  function confirmRestore() {
    if (!preview) return;
    const uploadId = preview.uploadId;
    startRestore(async () => {
      const fd = new FormData();
      fd.set("uploadId", uploadId);
      const res = await confirmRestoreAction(fd);
      if (res.ok) {
        toast.success(
          `Restauration terminée : ${res.data.restoredTotal} enregistrement(s).` +
            (res.data.usersCreatedDisabled > 0
              ? ` ${res.data.usersCreatedDisabled} compte(s) recréé(s) désactivé(s) — à réinviter.`
              : "")
        );
        setPreview(null);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const canConfirm = preview?.valid && preview.manifest.sameTenant && !restoring;

  function driveBackupNow() {
    startDrive(async () => {
      const res = await pushBackupToDriveAction();
      if (res.ok) {
        toast.success(`Sauvegarde envoyée vers Google Drive (${res.data.totalRows} enreg., ${formatBytes(res.data.sizeBytes)}).`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function driveDisconnect() {
    startDrive(async () => {
      const res = await disconnectGoogleDriveAction();
      if (res.ok) {
        toast.success("Google Drive déconnecté. Vos données et sauvegardes locales sont intactes.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function driveDelete(recordId: string) {
    startDrive(async () => {
      const fd = new FormData();
      fd.set("ref", recordId);
      const res = await deleteDriveBackupAction(fd);
      if (res.ok) {
        toast.success("Sauvegarde supprimée de Google Drive.");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function driveRestore(recordId: string) {
    startDrive(async () => {
      const fd = new FormData();
      fd.set("ref", recordId);
      const res = await restoreFromDriveAction(fd);
      if (res.ok) {
        setPreview(res.data);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* État de la dernière sauvegarde */}
      <section className="rounded-lg border p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <FileArchive className="size-4" /> État de la dernière sauvegarde
        </h2>
        {status.lastBackup ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <Row label="Date" value={formatDateTime(status.lastBackup.createdAt)} />
            <Row label="Générée par" value={status.lastBackup.createdByName ?? "—"} />
            <Row label="Taille" value={formatBytes(status.lastBackup.sizeBytes)} />
            <Row label="Enregistrements" value={String(status.lastBackup.totalRows)} />
            <Row label="Version du schéma" value={status.lastBackup.schemaVersion} />
            <Row label="Version de l'app" value={status.lastBackup.appVersion} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Aucune sauvegarde générée pour ce compte.</p>
        )}

        {status.lastBackup && status.lastBackup.breakdown.length > 0 && (
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer">Détail par catégorie</summary>
            <ul className="mt-2 grid gap-1 sm:grid-cols-3">
              {status.lastBackup.breakdown.map((b) => (
                <li key={b.label} className="tabular-nums">
                  {b.label} : {b.count}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" onClick={generateNow} disabled={generating}>
            {generating ? <Loader2 className="size-4 animate-spin" /> : <DatabaseBackup className="size-4" />}
            Sauvegarder maintenant
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!status.lastBackup?.downloadable}
            render={<a href="/parametres/sauvegarde/download" />}
          >
            <Download className="size-4" />
            Télécharger une sauvegarde
          </Button>
        </div>
      </section>

      {/* Restauration */}
      <section className="rounded-lg border p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Upload className="size-4" /> Restaurer une sauvegarde
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Un instantané de sécurité de vos données actuelles est créé automatiquement avant toute restauration. La
          restauration remplace les commandes, produits, stock, livraison et finance ; les comptes utilisateurs sont
          fusionnés, jamais supprimés. Les connecteurs devront être reconnectés.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".asb"
          hidden
          onChange={onFileChosen}
        />
        <Button
          type="button"
          variant="outline"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          Importer une sauvegarde
        </Button>
        {status.pendingUpload && !preview && (
          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
            Une sauvegarde importée est en attente de confirmation (
            {formatDateTime(status.pendingUpload.createdAt)}).{" "}
            <button
              type="button"
              className="underline"
              disabled={discarding}
              onClick={() =>
                startDiscard(async () => {
                  const fd = new FormData();
                  fd.set("uploadId", status.pendingUpload!.id);
                  await discardRestoreUploadAction(fd);
                  router.refresh();
                })
              }
            >
              Annuler
            </button>
          </p>
        )}
      </section>

      {/* Instantanés de sécurité */}
      {status.recentSafetySnapshots.length > 0 && (
        <section className="rounded-lg border p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert className="size-4" /> Instantanés de sécurité (avant restauration)
          </h2>
          <ul className="space-y-1.5 text-sm">
            {status.recentSafetySnapshots.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {formatDateTime(s.createdAt)} · {formatBytes(s.sizeBytes)}
                </span>
                {s.downloadable ? (
                  <a
                    className="text-primary hover:underline"
                    href={`/parametres/sauvegarde/download?snapshot=${s.id}`}
                  >
                    Télécharger
                  </a>
                ) : (
                  <span className="text-xs text-muted-foreground/70">Expiré</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Google Drive (Phase 2) */}
      {gd.connection.configured && (
        <section className="rounded-lg border p-4">
          <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <Cloud className="size-4" /> Google Drive
          </h2>
          <p className="mb-3 text-xs text-muted-foreground">
            Conservez une copie chiffrée (le même paquet <span className="font-mono">.asb</span>) dans le Google Drive de
            votre entreprise. La base de données reste la source de vérité.
          </p>

          {!gd.connection.connected && gd.connection.status !== "ERREUR" && (
            <Button type="button" variant="outline" render={<a href="/parametres/sauvegarde/google/start" />}>
              <Cloud className="size-4" />
              Connecter Google Drive
            </Button>
          )}

          {gd.connection.status === "ERREUR" && (
            <div className="space-y-2">
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                La connexion Google Drive a expiré ou a été révoquée. Reconnectez-vous pour reprendre les envois.
                {gd.connection.lastError ? ` (${gd.connection.lastError})` : ""}
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" render={<a href="/parametres/sauvegarde/google/start" />}>
                  <RotateCcw className="size-4" />
                  Reconnecter
                </Button>
                <Button type="button" variant="ghost" disabled={drivePending} onClick={driveDisconnect}>
                  Déconnecter
                </Button>
              </div>
            </div>
          )}

          {gd.connection.connected && (
            <div className="space-y-3">
              <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                <Row label="Statut" value="Connecté" />
                <Row label="Compte" value={gd.connection.accountEmail ?? "—"} />
                <Row
                  label="Dernier envoi"
                  value={gd.connection.lastBackupAt ? formatDateTime(gd.connection.lastBackupAt) : "Jamais"}
                />
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={drivePending} onClick={driveBackupNow}>
                  {drivePending ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
                  Sauvegarder maintenant vers Google Drive
                </Button>
                <Button type="button" variant="ghost" disabled={drivePending} onClick={driveDisconnect}>
                  <CloudOff className="size-4" />
                  Déconnecter
                </Button>
              </div>

              {gd.listError && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Impossible de lister les sauvegardes Google Drive : {gd.listError}
                </p>
              )}

              {gd.backups.length === 0 ? (
                <p className="text-xs text-muted-foreground">Aucune sauvegarde sur Google Drive.</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {gd.backups.map((b) => (
                    <li key={b.recordId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs">{b.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {formatDateTime(b.createdAt)} · {formatBytes(b.sizeBytes)}
                          {b.totalRows != null ? ` · ${b.totalRows} enreg.` : ""}
                          {!b.existsOnDrive ? " · (fichier absent de Drive)" : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {b.existsOnDrive ? (
                          <a
                            className="rounded px-2 py-1 text-xs text-primary hover:underline"
                            href={`/parametres/sauvegarde/google/download?ref=${encodeURIComponent(b.recordId)}`}
                          >
                            <Download className="mr-1 inline size-3.5" />
                            Télécharger
                          </a>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={drivePending || !b.existsOnDrive}
                          onClick={() => driveRestore(b.recordId)}
                        >
                          Restaurer
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={drivePending}
                          onClick={() => driveDelete(b.recordId)}
                        >
                          <Trash2 className="size-3.5 text-destructive" />
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      {/* Preview / confirm dialog */}
      <Dialog open={preview !== null} onOpenChange={(o) => !o && closePreview(true)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirmer la restauration</DialogTitle>
            <DialogDescription>
              Vérifiez le contenu avant de restaurer. Cette opération est transactionnelle : en cas d&apos;erreur, rien
              n&apos;est modifié.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3 text-sm">
            {preview && (
              <>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <Row label="Format" value={`v${preview.manifest.version ?? "?"}`} />
                  <Row label="Créée le" value={preview.manifest.createdAt ? formatDateTime(preview.manifest.createdAt) : "—"} />
                  <Row label="App / schéma" value={`${preview.manifest.appVersion ?? "?"} / ${preview.manifest.schemaVersion ?? "?"}`} />
                  <Row label="Enregistrements" value={String(preview.totalRows)} />
                  <Row label="Tenant d'origine" value={preview.manifest.tenant?.name ?? "—"} />
                </dl>

                {!preview.manifest.sameTenant && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    Cette sauvegarde provient d&apos;un autre compte/déploiement. La restauration entre tenants n&apos;est
                    pas disponible dans cette version.
                  </p>
                )}
                {preview.errors.length > 0 && (
                  <ul className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {preview.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {preview.warnings.length > 0 && (
                  <ul className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                    {preview.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                {preview.valid && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Contenu ({preview.preview.length} catégories)</summary>
                    <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                      {preview.preview.map((p) => (
                        <li key={p.label} className="tabular-nums">
                          {p.label} : {p.count}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => closePreview(true)} disabled={restoring}>
              Annuler
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRestore} disabled={!canConfirm}>
              {restoring ? <Loader2 className="size-4 animate-spin" /> : null}
              Restaurer maintenant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
