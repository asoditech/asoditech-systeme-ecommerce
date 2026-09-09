import { z } from "zod";

export const userRoleSchema = z.enum([
  "OWNER",
  "ADMIN",
  "MANAGER",
  "CONFIRMATION",
  "WAREHOUSE",
  "DELIVERY",
  "SUPPORT",
  "ACCOUNTANT",
]);

// Phase 5 (docs/adr/0027-tenant-provisioning.md): a user account is never
// created directly with an admin-chosen password anymore — every one, in
// every tenant, is provisioned by inviting an address and having the
// invitee set their own password when they accept. See
// src/actions/invitations.ts.
export const inviteUserSchema = z.object({
  name: z.string().trim().min(2, "Le nom est requis.").max(200),
  email: z.email("Adresse e-mail invalide."),
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

export const deleteUserSchema = z.object({
  id: z.string().min(1),
  // Typed confirmation — the client sends the exact e-mail of the account
  // being deleted, so a mis-click on the wrong row can't destroy an account.
  confirmEmail: z.string().trim().min(1),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
