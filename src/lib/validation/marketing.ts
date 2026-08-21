import { z } from "zod";

export const marketingChannelTypeSchema = z.enum(["META", "GOOGLE", "TIKTOK", "AUTRE"]);

export const createMarketingChannelSchema = z.object({
  name: z.string().trim().min(2, "Le nom du canal est requis.").max(150),
  type: marketingChannelTypeSchema.default("AUTRE"),
  isActive: z.coerce.boolean().default(true),
});

export const campaignStatusSchema = z.enum(["BROUILLON", "ACTIVE", "EN_PAUSE", "TERMINEE"]);

export const createMarketingCampaignSchema = z.object({
  channelId: z.string().min(1, "Le canal marketing est requis."),
  name: z.string().trim().min(2, "Le nom de la campagne est requis.").max(200),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().nullish(),
  budget: z.coerce.number().min(0).nullish(),
  spend: z.coerce.number().min(0).nullish(),
  status: campaignStatusSchema.default("BROUILLON"),
  notes: z.string().trim().max(2000).nullish().or(z.literal("")),
});

export const updateMarketingCampaignSchema = createMarketingCampaignSchema.extend({
  id: z.string().min(1),
});

export type CreateMarketingCampaignInput = z.infer<typeof createMarketingCampaignSchema>;
