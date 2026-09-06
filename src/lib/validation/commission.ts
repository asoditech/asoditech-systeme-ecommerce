import { z } from "zod";

export const upsertCommissionAgentSchema = z.object({
  userId: z.string().min(1, "L'utilisateur est requis."),
  ratePerOrder: z.coerce.number().min(0, "Le montant doit être positif.").max(100000),
  isActive: z.coerce.boolean().optional(),
});

export const updateCommissionAgentSchema = z.object({
  agentId: z.string().min(1),
  ratePerOrder: z.coerce.number().min(0).max(100000),
  isActive: z.coerce.boolean(),
});

export const assignOrderAgentSchema = z.object({
  orderId: z.string().min(1),
  // "" clears the assignment.
  agentId: z.string().trim().max(64).nullish().or(z.literal("")),
});

const currentYear = new Date().getUTCFullYear();

export const closeCommissionStatementSchema = z.object({
  agentId: z.string().min(1),
  periodYear: z.coerce.number().int().min(2020).max(currentYear + 1),
  periodMonth: z.coerce.number().int().min(1).max(12),
});

export const markStatementPaidSchema = z.object({
  statementId: z.string().min(1),
  paidAmount: z.coerce.number().min(0).max(1_000_000).optional(),
  note: z.string().trim().max(500).nullish().or(z.literal("")),
});

export type UpsertCommissionAgentInput = z.infer<typeof upsertCommissionAgentSchema>;
