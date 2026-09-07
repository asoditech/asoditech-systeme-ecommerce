import { z } from "zod";

export const loginSchema = z.object({
  email: z.email("Adresse e-mail invalide."),
  password: z.string().min(1, "Le mot de passe est requis."),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** Shared by invitation-acceptance and password-reset (Phase 5 —
 * docs/adr/0027-tenant-provisioning.md) — the one place a user ever
 * chooses their own password. */
export const newPasswordSchema = z.string().min(10, "Le mot de passe doit contenir au moins 10 caractères.");

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: newPasswordSchema,
});

export const requestPasswordResetSchema = z.object({
  email: z.email("Adresse e-mail invalide."),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: newPasswordSchema,
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
