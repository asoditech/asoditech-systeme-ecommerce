"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { encryptSecret } from "@/lib/crypto";
import { validateStoreUrl, InvalidStoreUrlError } from "@/lib/integrations/woocommerce/ssrf";
import { validateShopDomain, InvalidShopDomainError } from "@/lib/integrations/shopify/ssrf";
import { connectIntegrationSchema, disconnectIntegrationSchema } from "@/lib/validation/integration";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

/**
 * Stores connection configuration for a provider. This does NOT verify
 * connectivity — status lands on CONFIGURE, never CONNECTE, so the UI
 * never claims a live connection merely because credentials were saved
 * (see docs/adr/0004-integration-architecture.md's audit addendum). Only a
 * real "Tester la connexion" request (WooCommerce: testWooCommerceConnectionAction)
 * can advance status to CONNECTE. Credentials are encrypted at rest and
 * never returned to the client.
 *
 * WooCommerce specifically also gets its store URL validated against SSRF
 * (private/internal network targets) at save time — see
 * docs/adr/0010-woocommerce-integration.md. Other providers have no real
 * adapter yet, so no further validation is possible.
 */
export async function connectIntegrationAction(formData: FormData): Promise<ActionResult<IdResult>> {
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

  let normalizedSiteUrl = parsed.data.siteUrl || null;
  let config: Record<string, string | null> = { siteUrl: normalizedSiteUrl };

  if (parsed.data.provider === "WOOCOMMERCE") {
    if (!normalizedSiteUrl) {
      return actionError("L'URL de la boutique est requise.", { siteUrl: ["URL requise."] });
    }
    if (!parsed.data.apiKey || !parsed.data.apiSecret) {
      return actionError("La clé et le secret API sont requis pour WooCommerce.");
    }
    try {
      normalizedSiteUrl = await validateStoreUrl(normalizedSiteUrl);
    } catch (error) {
      if (error instanceof InvalidStoreUrlError) {
        return actionError(error.message, { siteUrl: [error.message] });
      }
      throw error;
    }
    config = { siteUrl: normalizedSiteUrl };
  } else if (parsed.data.provider === "SHOPIFY") {
    if (!parsed.data.siteUrl) {
      return actionError("Le nom de la boutique Shopify est requis.", { siteUrl: ["Nom de boutique requis."] });
    }
    if (!parsed.data.apiKey) {
      return actionError("Le jeton d'accès Admin API Shopify est requis.");
    }
    let shopDomain: string;
    try {
      shopDomain = await validateShopDomain(parsed.data.siteUrl);
    } catch (error) {
      if (error instanceof InvalidShopDomainError) {
        return actionError(error.message, { siteUrl: [error.message] });
      }
      throw error;
    }
    // apiSecret (Shopify's own custom-app client secret) is optional here
    // — it's only needed to verify inbound webhook signatures, and an
    // operator who only wants manual/periodic sync has no reason to
    // provide it. See docs/adr/0011-shopify-integration.md.
    config = { shopDomain };
  }

  const hasCredentials = Boolean(parsed.data.apiKey || parsed.data.apiSecret);
  const credentialsEncrypted = hasCredentials
    ? encryptSecret(JSON.stringify({ apiKey: parsed.data.apiKey ?? "", apiSecret: parsed.data.apiSecret ?? "" }))
    : null;

  const integration = await prisma.integration.upsert({
    where: { provider: parsed.data.provider },
    update: {
      status: "CONFIGURE",
      config,
      credentialsEncrypted,
      lastError: null,
    },
    create: {
      provider: parsed.data.provider,
      status: "CONFIGURE",
      config,
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
  // Never return the full record — credentialsEncrypted is ciphertext, not
  // plaintext, but it still must never cross the Server Action -> Client
  // boundary at all. Found during the A–G audit; see
  // docs/adr/0004-integration-architecture.md.
  return actionOk({ id: integration.id });
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
