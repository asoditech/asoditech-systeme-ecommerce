"use server";

import { prisma } from "@/lib/prisma";
import { requireUserForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { notifySupportTicket } from "@/lib/notifications";
import { sendSupportTicketEmail } from "@/lib/email";
import { reportProblemSchema, SUPPORT_TICKET_CATEGORIES } from "@/lib/validation/support";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * "Signaler un problème" from the support widget. Any authenticated user
 * may report — no special permission (it is help, not a business action).
 * The report is persisted as a `SupportTicket` (a real support queue can
 * grow on this later), owners/admins are notified in-app, and — when a
 * support address is configured — it is forwarded there by email.
 * Notification and email are best-effort and never fail the report.
 */
export async function reportProblemAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requireUserForAction();

  const parsed = reportProblemSchema.safeParse({
    category: formData.get("category"),
    description: formData.get("description"),
    pageUrl: formData.get("pageUrl") ?? "",
    contextType: formData.get("contextType") ?? "",
    contextId: formData.get("contextId") ?? "",
  });
  if (!parsed.success) {
    return actionError("Merci de vérifier le formulaire.", parsed.error.flatten().fieldErrors);
  }

  const { category, description } = parsed.data;
  const pageUrl = parsed.data.pageUrl?.trim() || null;
  const contextType = parsed.data.contextType || null;
  const contextId = (contextType && parsed.data.contextId?.trim()) || null;
  const categoryLabel = SUPPORT_TICKET_CATEGORIES[category];

  const ticket = await prisma.supportTicket.create({
    data: {
      reporterUserId: user.id,
      category,
      description,
      pageUrl,
      contextType: contextId ? contextType : null,
      contextId,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "support.ticket_created",
    entityType: "SupportTicket",
    entityId: ticket.id,
    metadata: { category },
  });

  // Best-effort fan-out — the ticket is already saved and visible in-app.
  await notifySupportTicket(
    { id: ticket.id, categoryLabel, reporterName: user.name },
    user.id,
  );

  const settings = await prisma.businessSettings.findFirst({
    select: { supportEmail: true, companyName: true },
  });
  if (settings?.supportEmail) {
    try {
      await sendSupportTicketEmail({
        to: settings.supportEmail,
        companyName: settings.companyName?.trim() || "ASODITECH",
        categoryLabel,
        description,
        reporterName: user.name,
        reporterEmail: user.email,
        pageUrl,
        contextLine: contextId ? `${contextType === "Order" ? "Commande" : "Expédition"} : ${contextId}` : null,
      });
    } catch (error) {
      console.error("sendSupportTicketEmail failed (non-fatal):", error);
    }
  }

  return actionOk({ id: ticket.id });
}
