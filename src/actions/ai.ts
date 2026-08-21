"use server";

import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { AI_TOOLS } from "@/lib/ai/tools";

export async function runAiToolAction(toolId: string): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const user = await requirePermissionForAction("ai.use");

  const tool = AI_TOOLS.find((t) => t.id === toolId);
  if (!tool) {
    return { ok: false, error: "Question non reconnue." };
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

  return { ok: true, answer };
}
