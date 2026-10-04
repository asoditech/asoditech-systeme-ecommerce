"use server";

import { revalidatePath } from "next/cache";
import { prismaBase } from "@/lib/prisma";
import { requirePlatformAdminForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { announcementFormValues, announcementIdSchema, announcementInputSchema } from "@/lib/validation/announcement";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Platform announcement administration (docs/adr/0059). EVERY action starts
 * with `requirePlatformAdminForAction` (isPlatformAdmin flag + unlocked
 * Platform Access Key session) BEFORE reading any input or touching the
 * table — a tenant OWNER/ADMIN, whatever the payload, gets an error and no
 * write. Announcements are platform-level rows (no tenantId), so there is no
 * tenant id in any payload to tamper with.
 */

function revalidateAnnouncements() {
  revalidatePath("/platform/annonces");
  // The bar lives in the protected app shell layout.
  revalidatePath("/", "layout");
}

function snapshot(a: { message: string; type: string; isPublished: boolean; startsAt: Date | null; endsAt: Date | null; actionLabel: string | null; actionUrl: string | null }) {
  return {
    message: a.message,
    type: a.type,
    isPublished: a.isPublished,
    startsAt: a.startsAt?.toISOString() ?? null,
    endsAt: a.endsAt?.toISOString() ?? null,
    actionLabel: a.actionLabel,
    actionUrl: a.actionUrl,
  };
}

export async function createAnnouncementAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();
  const parsed = announcementInputSchema.safeParse(announcementFormValues(formData));
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const created = await prismaBase.platformAnnouncement.create({
    data: { ...parsed.data, createdById: actor.id, updatedById: actor.id },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "announcement.created",
    entityType: "PlatformAnnouncement",
    entityId: created.id,
    newValue: snapshot(created),
  });
  revalidateAnnouncements();
  return actionOk({ id: created.id });
}

export async function updateAnnouncementAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();
  const id = announcementIdSchema.safeParse(formData.get("id"));
  if (!id.success) return actionError("Annonce introuvable.");
  const parsed = announcementInputSchema.safeParse(announcementFormValues(formData));
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prismaBase.platformAnnouncement.findUnique({ where: { id: id.data } });
  if (!existing) return actionError("Annonce introuvable.");
  const updated = await prismaBase.platformAnnouncement.update({
    where: { id: existing.id },
    data: { ...parsed.data, updatedById: actor.id },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "announcement.updated",
    entityType: "PlatformAnnouncement",
    entityId: updated.id,
    previousValue: snapshot(existing),
    newValue: snapshot(updated),
  });
  revalidateAnnouncements();
  return actionOk({ id: updated.id });
}

/** Publish or disable without editing the content. */
export async function setAnnouncementPublishedAction(input: { id: string; isPublished: boolean }): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();
  const id = announcementIdSchema.safeParse(input?.id);
  if (!id.success || typeof input?.isPublished !== "boolean") return actionError("Champs invalides.");

  const existing = await prismaBase.platformAnnouncement.findUnique({ where: { id: id.data } });
  if (!existing) return actionError("Annonce introuvable.");
  const updated = await prismaBase.platformAnnouncement.update({
    where: { id: existing.id },
    data: { isPublished: input.isPublished, updatedById: actor.id },
  });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: input.isPublished ? "announcement.published" : "announcement.unpublished",
    entityType: "PlatformAnnouncement",
    entityId: updated.id,
    previousValue: { isPublished: existing.isPublished },
    newValue: { isPublished: updated.isPublished },
  });
  revalidateAnnouncements();
  return actionOk({ id: updated.id });
}

export async function deleteAnnouncementAction(input: { id: string }): Promise<ActionResult<IdResult>> {
  const actor = await requirePlatformAdminForAction();
  const id = announcementIdSchema.safeParse(input?.id);
  if (!id.success) return actionError("Champs invalides.");

  const existing = await prismaBase.platformAnnouncement.findUnique({ where: { id: id.data } });
  if (!existing) return actionError("Annonce introuvable.");
  await prismaBase.platformAnnouncement.delete({ where: { id: existing.id } });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "announcement.deleted",
    entityType: "PlatformAnnouncement",
    entityId: existing.id,
    previousValue: snapshot(existing),
  });
  revalidateAnnouncements();
  return actionOk({ id: existing.id });
}
