import { z } from "zod";

export const userRoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "MANAGER",
  "SALES",
  "WAREHOUSE",
  "DELIVERY",
  "SUPPORT",
  "ACCOUNTANT",
]);

export const createUserSchema = z.object({
  name: z.string().trim().min(2, "Le nom est requis.").max(200),
  email: z.email("Adresse e-mail invalide."),
  password: z.string().min(10, "Le mot de passe doit contenir au moins 10 caractères."),
  role: userRoleSchema,
});

export const userStatusSchema = z.enum(["ACTIVE", "DISABLED"]);

export const updateUserStatusSchema = z.object({
  id: z.string().min(1),
  status: userStatusSchema,
});

export const updateUserRoleSchema = z.object({
  id: z.string().min(1),
  role: userRoleSchema,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
