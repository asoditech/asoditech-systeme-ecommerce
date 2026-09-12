import { z } from "zod";

/**
 * "Signaler un problème" — the categories the widget offers. A free
 * `category` string column backs this (see prisma `SupportTicket`) so the
 * list can grow without a migration; the schema just keeps input honest.
 */
export const SUPPORT_TICKET_CATEGORIES = {
  commande: "Commande",
  livraison: "Livraison",
  stock: "Stock / produits",
  finance: "Finance",
  bug: "Bug / erreur technique",
  compte: "Compte / accès",
  upgrade: "Demande de mise à niveau",
  autre: "Autre",
} as const;

export type SupportTicketCategory = keyof typeof SUPPORT_TICKET_CATEGORIES;

export const reportProblemSchema = z.object({
  category: z.enum(
    Object.keys(SUPPORT_TICKET_CATEGORIES) as [SupportTicketCategory, ...SupportTicketCategory[]],
  ),
  description: z.string().trim().min(10, "Décrivez le problème en quelques mots.").max(2000),
  // Context only — the page the user was on, and the record they were
  // looking at. Never a secret.
  pageUrl: z.string().trim().max(500).optional().or(z.literal("")),
  contextType: z.enum(["Order", "Shipment"]).optional().or(z.literal("")),
  contextId: z.string().trim().max(60).optional().or(z.literal("")),
});

export type ReportProblemInput = z.infer<typeof reportProblemSchema>;
