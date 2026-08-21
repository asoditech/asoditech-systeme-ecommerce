import { z } from "zod";

export const integrationProviderSchema = z.enum([
  "WOOCOMMERCE",
  "SHOPIFY",
  "META_ADS",
  "GOOGLE_ADS",
  "TIKTOK_ADS",
  "WHATSAPP",
  "EMAIL",
  "GOOGLE_SHEETS",
  "AI_PROVIDER",
]);

export const connectIntegrationSchema = z.object({
  provider: integrationProviderSchema,
  // Non-secret config, e.g. store URL. Actual credentials go through a
  // separate field so they can be encrypted before ever reaching Prisma.
  siteUrl: z.union([z.url(), z.literal("")]).nullish(),
  apiKey: z.string().trim().max(500).nullish().or(z.literal("")),
  apiSecret: z.string().trim().max(500).nullish().or(z.literal("")),
});

export const disconnectIntegrationSchema = z.object({
  provider: integrationProviderSchema,
});

export type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
