"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { createMarketingChannelSchema, createMarketingCampaignSchema } from "@/lib/validation/marketing";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import type { MarketingChannel } from "@prisma/client";

export async function createMarketingChannelAction(formData: FormData): Promise<ActionResult<MarketingChannel>> {
  const user = await requirePermissionForAction("marketing.manage");

  const parsed = createMarketingChannelSchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type") || "AUTRE",
    isActive: formData.get("isActive") !== "off",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const channel = await prisma.marketingChannel.create({ data: parsed.data });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "marketing_channel.created",
    entityType: "MarketingChannel",
    entityId: channel.id,
    newValue: { name: channel.name },
  });

  revalidatePath("/marketing");
  return actionOk(channel);
}

export async function createMarketingCampaignAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("marketing.manage");

  const parsed = createMarketingCampaignSchema.safeParse({
    channelId: formData.get("channelId"),
    name: formData.get("name"),
    startDate: formData.get("startDate"),
    endDate: formData.get("endDate") || undefined,
    budget: formData.get("budget") || undefined,
    spend: formData.get("spend") || undefined,
    status: formData.get("status") || "BROUILLON",
    notes: formData.get("notes"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const channel = await prisma.marketingChannel.findUnique({ where: { id: parsed.data.channelId } });
  if (!channel) return actionError("Canal marketing introuvable.");

  const campaign = await prisma.marketingCampaign.create({
    data: {
      channelId: parsed.data.channelId,
      name: parsed.data.name,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate ?? null,
      budget: parsed.data.budget ?? null,
      spend: parsed.data.spend ?? null,
      status: parsed.data.status,
      notes: parsed.data.notes || null,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "marketing_campaign.created",
    entityType: "MarketingCampaign",
    entityId: campaign.id,
    newValue: { name: campaign.name },
  });

  revalidatePath("/marketing");
  return actionOk({ id: campaign.id });
}
