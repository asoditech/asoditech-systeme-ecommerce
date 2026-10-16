"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { validateStoreUrl, InvalidStoreUrlError } from "@/lib/integrations/woocommerce/ssrf";
import { validateShopDomain, InvalidShopDomainError } from "@/lib/integrations/shopify/ssrf";
import { isShopifyIntegrationEnabled, SHOPIFY_DISABLED_MESSAGE } from "@/lib/integrations/shopify/feature-flag";
import { connectIntegrationSchema, disconnectIntegrationSchema } from "@/lib/validation/integration";
import { inventoryOwnerSchema, remoteDeletionModeSchema } from "@/lib/integrations/woocommerce/store-settings";
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

  // Shopify is disabled for now (client feedback #10) — refuse any attempt
  // to start or reconfigure a connection. Disconnecting an existing one is
  // still allowed (see disconnectIntegrationAction).
  if (parsed.data.provider === "SHOPIFY" && !isShopifyIntegrationEnabled()) {
    return actionError(SHOPIFY_DISABLED_MESSAGE);
  }

  let normalizedSiteUrl = parsed.data.siteUrl || null;
  let config: Record<string, string | boolean | null> = { siteUrl: normalizedSiteUrl };

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
  // Updating the WooCommerce key/secret must not drop the webhook signing
  // secret generated earlier (« Webhooks » → it is pasted into the store's
  // 5 webhooks): losing it made every webhook fail with 401 until it was
  // regenerated and re-pasted by hand.
  const keptWebhookSecret = parsed.data.provider === "WOOCOMMERCE" ? await existingWooWebhookSecret(user.tenantId) : null;
  const credentialsEncrypted = hasCredentials
    ? encryptSecret(
        JSON.stringify({
          apiKey: parsed.data.apiKey ?? "",
          apiSecret: parsed.data.apiSecret ?? "",
          ...(keptWebhookSecret ? { webhookSecret: keptWebhookSecret } : {}),
        })
      )
    : null;

  // Owner decision (2026-10-13): re-saving the SAME store (rotated key,
  // disconnect + reconnect) keeps the company's valid per-connection choices;
  // a DIFFERENT store address never inherits them — it starts from the safe
  // defaults. Sync cursors restart either way (working state).
  const { storeAddress, kept, initialized } = await connectionSettingsOnSave(user.tenantId, parsed.data.provider, config);
  config = { ...config, ...kept };

  const integration = await prisma.integration.upsert({
    where: { tenantId_provider: { tenantId: user.tenantId, provider: parsed.data.provider } },
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
    // `new` / `same` / `changed` store address; which choices were kept and which start from their default.
    newValue: { provider: integration.provider, storeAddress, keptSettings: Object.keys(kept).sort(), initializedSettings: initialized },
  });

  revalidatePath("/integrations");
  // Never return the full record — credentialsEncrypted is ciphertext, not
  // plaintext, but it still must never cross the Server Action -> Client
  // boundary at all. Found during the A–G audit; see
  // docs/adr/0004-integration-architecture.md.
  return actionOk({ id: integration.id });
}

/**
 * The company's own choices on a connection (each set by an audited action:
 * remote deletion, stock owner, order history, first-import status) — not
 * sync cursors or leases, which belong to the store they were read from.
 * Each value is kept only when valid; anything else starts from its default
 * (manual unlinking, ASODITECH stock, history imported, first import NOUVELLE).
 */
const SETTING_VALIDATORS: Record<string, (value: unknown) => boolean> = {
  remoteDeletionMode: (v) => remoteDeletionModeSchema.safeParse(v).success,
  inventoryOwner: (v) => inventoryOwnerSchema.safeParse(v).success,
  importHistoricalOrders: (v) => typeof v === "boolean",
  historyCutoffAt: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  forceNouvelleOnImport: (v) => typeof v === "boolean",
};
const CONNECTION_SETTING_KEYS: Record<"WOOCOMMERCE" | "SHOPIFY", string[]> = {
  WOOCOMMERCE: ["remoteDeletionMode", "inventoryOwner", "importHistoricalOrders", "historyCutoffAt", "forceNouvelleOnImport"],
  SHOPIFY: ["remoteDeletionMode", "inventoryOwner", "importHistoricalOrders", "historyCutoffAt", "forceNouvelleOnImport"],
};

/**
 * What a save does to this tenant's choices for `provider`: same validated
 * store address (`siteUrl` / `shopDomain`) → the valid ones are kept; a first
 * connection or a different address → none (safe defaults).
 */
async function connectionSettingsOnSave(
  tenantId: string,
  provider: string,
  next: Record<string, string | boolean | null>
): Promise<{ storeAddress: "new" | "same" | "changed"; kept: Record<string, string | boolean>; initialized: string[] }> {
  if (provider !== "WOOCOMMERCE" && provider !== "SHOPIFY") return { storeAddress: "new", kept: {}, initialized: [] };
  const keys = CONNECTION_SETTING_KEYS[provider];
  const row = await prisma.integration.findUnique({
    where: { tenantId_provider: { tenantId, provider } },
    select: { config: true },
  });
  const previous = (row?.config ?? null) as Record<string, unknown> | null;
  const addressKey = provider === "WOOCOMMERCE" ? "siteUrl" : "shopDomain";
  const previousAddress = typeof previous?.[addressKey] === "string" ? previous[addressKey] : null;
  if (!previous || previousAddress === null) return { storeAddress: "new", kept: {}, initialized: [...keys] };
  if (previousAddress !== next[addressKey]) return { storeAddress: "changed", kept: {}, initialized: [...keys] };

  const kept: Record<string, string | boolean> = {};
  for (const key of keys) {
    const value = previous[key];
    if (SETTING_VALIDATORS[key](value)) kept[key] = value as string | boolean;
  }
  return { storeAddress: "same", kept, initialized: keys.filter((key) => !(key in kept)) };
}

/** The stored WooCommerce webhook secret of this tenant, if any (never returned to the client). */
async function existingWooWebhookSecret(tenantId: string): Promise<string | null> {
  const row = await prisma.integration.findUnique({
    where: { tenantId_provider: { tenantId, provider: "WOOCOMMERCE" } },
    select: { credentialsEncrypted: true },
  });
  if (!row?.credentialsEncrypted) return null;
  try {
    const stored = JSON.parse(decryptSecret(row.credentialsEncrypted)) as { webhookSecret?: unknown };
    return typeof stored.webhookSecret === "string" && stored.webhookSecret ? stored.webhookSecret : null;
  } catch {
    return null;
  }
}

export async function disconnectIntegrationAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("integrations.manage");

  const parsed = disconnectIntegrationSchema.safeParse({ provider: formData.get("provider") });
  if (!parsed.success) {
    return actionError("Fournisseur invalide.");
  }

  const existing = await prisma.integration.findFirst({ where: { provider: parsed.data.provider } });
  if (!existing) return actionError("Intégration introuvable.");

  await prisma.integration.update({
    where: { id: existing.id },
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
