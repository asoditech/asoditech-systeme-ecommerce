import { z } from "zod";

export const createExpenseCategorySchema = z.object({
  name: z.string().trim().min(2, "Le nom de la catégorie est requis.").max(120),
});

export const createExpenseSchema = z.object({
  categoryId: z.string().min(1, "La catégorie de dépense est requise."),
  amount: z.coerce.number().positive("Le montant doit être positif."),
  currency: z.string().length(3).default("MAD"),
  date: z.coerce.date(),
  description: z.string().trim().max(2000).nullish().or(z.literal("")),
  vendor: z.string().trim().max(200).nullish().or(z.literal("")),
});

export const updateExpenseSchema = createExpenseSchema.extend({
  id: z.string().min(1),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
