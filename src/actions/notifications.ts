"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

export async function markNotificationReadAction(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  if (!id) {
    return actionError("Notification invalide.");
  }

  await prisma.notification.updateMany({
    where: { id, userId: user.id },
    data: { isRead: true },
  });

  revalidatePath("/notifications");
  return actionOk(undefined);
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  await prisma.notification.updateMany({
    where: { userId: user.id, isRead: false },
    data: { isRead: true },
  });
  revalidatePath("/notifications");
  return actionOk(undefined);
}

/** Hides one notification from the bell/list — a per-user row with no
 * other reference in the schema, so this is a real delete, not a soft
 * "hidden" flag; nothing else in the app ever reads a deleted one back. */
export async function dismissNotificationAction(id: string): Promise<ActionResult<undefined>> {
  const user = await requireUserForAction();
  if (!id) {
    return actionError("Notification invalide.");
  }

  await prisma.notification.deleteMany({ where: { id, userId: user.id } });

  revalidatePath("/notifications");
  return actionOk(undefined);
}
