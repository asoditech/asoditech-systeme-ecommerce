"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import {
  createAnnouncementAction,
  deleteAnnouncementAction,
  setAnnouncementPublishedAction,
  updateAnnouncementAction,
} from "@/actions/announcements";
import {
  ANNOUNCEMENT_ACTION_LABEL_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  ANNOUNCEMENT_STATUS_LABELS,
  ANNOUNCEMENT_TYPES,
  ANNOUNCEMENT_TYPE_LABELS,
  announcementStatus,
  isoToLocalInput,
  localInputToIso,
  type AnnouncementStatus,
  type AnnouncementTypeValue,
} from "@/lib/announcements";
import { formatDateTime } from "@/lib/format";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** A `PlatformAnnouncement` as received by this Client Component (dates as ISO strings). */
export interface SerializedAnnouncement {
  id: string;
  message: string;
  type: AnnouncementTypeValue;
  isPublished: boolean;
  startsAt: string | null;
  endsAt: string | null;
  actionLabel: string | null;
  actionUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_VARIANT: Record<AnnouncementStatus, "success" | "info" | "secondary" | "outline"> = {
  LIVE: "success",
  SCHEDULED: "info",
  EXPIRED: "outline",
  DRAFT: "secondary",
};

const toDate = (iso: string | null) => (iso ? new Date(iso) : null);

/**
 * `/platform/annonces` (docs/adr/0059) — list + create/edit/publish/disable/
 * delete of platform-wide announcements. Every button calls a Server Action
 * that re-checks platform-admin access itself; this component is only the UX.
 */
export function AnnouncementManager({ announcements }: { announcements: SerializedAnnouncement[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState<SerializedAnnouncement | "new" | null>(null);
  const [deleting, setDeleting] = useState<SerializedAnnouncement | null>(null);
  const now = new Date();

  function togglePublished(a: SerializedAnnouncement) {
    startTransition(async () => {
      const r = await setAnnouncementPublishedAction({ id: a.id, isPublished: !a.isPublished });
      if (r.ok) {
        toast.success(a.isPublished ? "Annonce désactivée." : "Annonce publiée.");
        router.refresh();
      } else toast.error(r.error);
    });
  }

  function remove() {
    if (!deleting) return;
    const target = deleting;
    startTransition(async () => {
      const r = await deleteAnnouncementAction({ id: target.id });
      if (r.ok) {
        toast.success("Annonce supprimée.");
        setDeleting(null);
        router.refresh();
      } else toast.error(r.error);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setEditing("new")}>
          <Plus className="size-4" />
          Nouvelle annonce
        </Button>
      </div>

      {announcements.length === 0 ? (
        <EmptyState icon={Megaphone} title="Aucune annonce. Une annonce publiée s'affiche sous l'en-tête de chaque espace client." />
      ) : (
        <div className="rounded-xl border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Message</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Période</TableHead>
                <TableHead className="w-0 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {announcements.map((a) => {
                const status = announcementStatus({ isPublished: a.isPublished, startsAt: toDate(a.startsAt), endsAt: toDate(a.endsAt) }, now);
                return (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-md">
                      <p className="line-clamp-2 text-sm break-words whitespace-normal">{a.message}</p>
                      {a.actionLabel && a.actionUrl && (
                        <p className="truncate text-xs text-muted-foreground">
                          {a.actionLabel} → {a.actionUrl}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{ANNOUNCEMENT_TYPE_LABELS[a.type]}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[status]}>{ANNOUNCEMENT_STATUS_LABELS[status]}</Badge>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
                      {a.startsAt ? `Du ${formatDateTime(a.startsAt)}` : "Dès publication"}
                      <br />
                      {a.endsAt ? `Au ${formatDateTime(a.endsAt)}` : "Sans fin"}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button type="button" size="xs" variant="outline" disabled={isPending} onClick={() => togglePublished(a)}>
                          {a.isPublished ? "Désactiver" : "Publier"}
                        </Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label="Modifier l'annonce" title="Modifier" onClick={() => setEditing(a)}>
                          <Pencil className="size-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Supprimer l'annonce"
                          title="Supprimer"
                          onClick={() => setDeleting(a)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {editing && (
        <AnnouncementEditor
          key={editing === "new" ? "new" : editing.id}
          announcement={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cette annonce ?</DialogTitle>
            <DialogDescription>
              Elle disparaît immédiatement de tous les espaces clients. Pour la masquer temporairement, utilisez plutôt
              « Désactiver ».
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Annuler
            </Button>
            <Button type="button" variant="destructive" disabled={isPending} onClick={remove}>
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AnnouncementEditor({
  announcement,
  onClose,
  onSaved,
}: {
  announcement: SerializedAnnouncement | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState(announcement?.message ?? "");
  const [type, setType] = useState<AnnouncementTypeValue>(announcement?.type ?? "INFO");
  const [isPublished, setIsPublished] = useState(announcement?.isPublished ?? false);
  const [startsAt, setStartsAt] = useState(isoToLocalInput(announcement?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(isoToLocalInput(announcement?.endsAt ?? null));
  const [actionLabel, setActionLabel] = useState(announcement?.actionLabel ?? "");
  const [actionUrl, setActionUrl] = useState(announcement?.actionUrl ?? "");
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({});

  function save() {
    startTransition(async () => {
      const fd = new FormData();
      if (announcement) fd.set("id", announcement.id);
      fd.set("message", message);
      fd.set("type", type);
      fd.set("isPublished", isPublished ? "true" : "false");
      fd.set("startsAt", localInputToIso(startsAt));
      fd.set("endsAt", localInputToIso(endsAt));
      fd.set("actionLabel", actionLabel);
      fd.set("actionUrl", actionUrl);
      const r = announcement ? await updateAnnouncementAction(fd) : await createAnnouncementAction(fd);
      if (r.ok) {
        toast.success(announcement ? "Annonce mise à jour." : "Annonce créée.");
        onSaved();
      } else {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
      }
    });
  }

  const err = (k: string) => errors[k]?.[0];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{announcement ? "Modifier l'annonce" : "Nouvelle annonce"}</DialogTitle>
          <DialogDescription>
            Affichée sous l&apos;en-tête de chaque espace client quand elle est publiée et dans sa période. Chaque
            utilisateur peut la masquer pour son navigateur.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ann-message" required>
              Message
            </Label>
            <Textarea
              id="ann-message"
              value={message}
              maxLength={ANNOUNCEMENT_MESSAGE_MAX}
              rows={3}
              onChange={(e) => setMessage(e.target.value)}
              aria-invalid={Boolean(err("message")) || undefined}
            />
            <p className="flex justify-between text-xs text-muted-foreground">
              <span className="text-destructive">{err("message")}</span>
              <span>
                {message.length}/{ANNOUNCEMENT_MESSAGE_MAX}
              </span>
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ann-type">Type</Label>
              <NativeSelect id="ann-type" value={type} onChange={(e) => setType(e.target.value as AnnouncementTypeValue)}>
                {ANNOUNCEMENT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ANNOUNCEMENT_TYPE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="flex items-end gap-2 pb-1.5">
              <Switch id="ann-published" checked={isPublished} onCheckedChange={(v) => setIsPublished(v === true)} />
              <Label htmlFor="ann-published">Publiée</Label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-start">Début (optionnel)</Label>
              <Input id="ann-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-end">Fin (optionnelle)</Label>
              <Input
                id="ann-end"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                aria-invalid={Boolean(err("endsAt")) || undefined}
              />
              {err("endsAt") && <p className="text-xs text-destructive">{err("endsAt")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-action-label">Bouton — libellé (optionnel)</Label>
              <Input
                id="ann-action-label"
                value={actionLabel}
                maxLength={ANNOUNCEMENT_ACTION_LABEL_MAX}
                placeholder="Ex. En savoir plus"
                onChange={(e) => setActionLabel(e.target.value)}
                aria-invalid={Boolean(err("actionLabel")) || undefined}
              />
              {err("actionLabel") && <p className="text-xs text-destructive">{err("actionLabel")}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-action-url">Bouton — lien (optionnel)</Label>
              <Input
                id="ann-action-url"
                value={actionUrl}
                placeholder="/rapports ou https://…"
                onChange={(e) => setActionUrl(e.target.value)}
                aria-invalid={Boolean(err("actionUrl")) || undefined}
              />
              {err("actionUrl") && <p className="text-xs text-destructive">{err("actionUrl")}</p>}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Heures saisies dans le fuseau de ce navigateur. « Contacter le support » est toujours proposé et ouvre le
            centre d&apos;aide de l&apos;espace client.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button type="button" disabled={isPending} onClick={save}>
            {announcement ? "Enregistrer" : "Créer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
