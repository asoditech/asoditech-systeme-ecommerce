"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { connectIntegrationSchema, disconnectIntegrationSchema } from "@/lib/validation/integration";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { Integration } from "@prisma/client";

/**
 * Stores connection configuration for a provider. This does NOT verify
 * connectivity or perform any sync — no WooCommerce/Shopify adapter exists
 * yet (see docs/adr/0004-integration-architecture.md). Credentials are
 * encrypted at rest and never returned to the client.
 */
export async function connectIntegrationAction(formData: FormData): Promise<ActionResult<Integration>> {
  const user = await requirePermissionForAction("integrations.manage");

  const parsed = connectIntegrationSchema.safeParse({
    provider: formData.get("provider"),
    siteUrl: formData.get("siteUrl"),
    apiKey: formData.get("apiKey"),
    apiSecret: formData.get("apiSecret"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const hasCredentials = Boolean(parsed.data.apiKey || parsed.data.apiSecret);
  const credentialsEncrypted = hasCredentials
    ? encryptSecret(JSON.stringify({ apiKey: parsed.data.apiKey ?? "", apiSecret: parsed.data.apiSecret ?? "" }))
    : null;

  const integration = await prisma.integration.upsert({
    where: { provider: parsed.data.provider },
    update: {
      status: "CONNECTE",
      config: { siteUrl: parsed.data.siteUrl || null },
      credentialsEncrypted,
      lastError: null,
    },
    create: {
      provider: parsed.data.provider,
      status: "CONNECTE",
      config: { siteUrl: parsed.data.siteUrl || null },
      credentialsEncrypted,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.connected",
    entityType: "Integration",
    entityId: integration.id,
    newValue: { provider: integration.provider },
  });

  revalidatePath("/integrations");
  return actionOk(integration);
}

export async function disconnectIntegrationAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("integrations.manage");

  const parsed = disconnectIntegrationSchema.safeParse({ provider: formData.get("provider") });
  if (!parsed.success) {
    return actionError("Fournisseur invalide.");
  }

  const existing = await prisma.integration.findUnique({ where: { provider: parsed.data.provider } });
  if (!existing) return actionError("Intégration introuvable.");

  await prisma.integration.update({
    where: { provider: parsed.data.provider },
    data: { status: "DECONNECTE", credentialsEncrypted: null, config: undefined },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "integration.disconnected",
    entityType: "Integration",
    entityId: existing.id,
    metadata: { provider: existing.provider },
  });

  revalidatePath("/integrations");
  return actionOk(undefined);
}
