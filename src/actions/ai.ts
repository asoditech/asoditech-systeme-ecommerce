"use server";

import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { getAiTool } from "@/lib/ai/tools";

export async function runAiToolAction(
  toolId: string,
): Promise<
  | { ok: true; answer: string; href?: string; linkLabel?: string }
  | { ok: false; error: string }
> {
  const user = await requirePermissionForAction("ai.use");

  const tool = getAiTool(toolId);
  if (!tool) {
    return { ok: false, error: "Question non reconnue." };
  }

  // The AI must never be a way around RBAC: a tool that surfaces finance /
  // delivery / customer data is only runnable by a role that already holds
  // the matching permission, exactly as if the user opened that page.
  if (tool.permission && !userHasPermission(user, tool.permission)) {
    return {
      ok: false,
      error: "Vous n'avez pas la permission de consulter cette information.",
    };
  }
  // Channel scope (docs/adr/0039): a tool that reads Online order data is not
  // runnable by a user with no Online channel, whatever shared permission
  // (finance.view, products.view…) they hold.
  if (tool.domain === "ONLINE" && !user.channels.online) {
    return {
      ok: false,
      error: "Vous n'avez pas la permission de consulter cette information.",
    };
  }

  const answer = await tool.run();

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "ai.query",
    entityType: "AiQuery",
    entityId: tool.id,
    metadata: { question: tool.label },
  });

  return { ok: true, answer, href: tool.href, linkLabel: tool.linkLabel };
}
