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
