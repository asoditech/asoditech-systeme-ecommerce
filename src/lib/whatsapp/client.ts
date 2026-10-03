import "server-only";

import { env } from "@/lib/env";
import { WHATSAPP_TEMPLATE_LANGUAGE, type WhatsAppTemplateMessage } from "@/lib/whatsapp/templates";

/**
 * WhatsApp Cloud API provider — docs/adr/0058. Plain `fetch` against the
 * Graph API (no SDK), ONE central ASODITECH sender configured by env vars
 * (never per-tenant credentials).
 *
 * Same contract as src/lib/email.ts: never throws. Unconfigured — or
 * NODE_ENV === "test", for the same reason email forces it (a developer's
 * real `.env` must never leak into the suite) — nothing is sent. Logs carry
 * the template name and Meta's error code/type only: never the phone
 * number, the parameters (message body) or the token.
 */

const TIMEOUT_MS = 8_000;

export type WhatsAppResult = { ok: true; messageId: string | null } | { ok: false; error: string };

export function isWhatsAppConfigured(): boolean {
  if (env.NODE_ENV === "test") return false;
  return Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID);
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${path}`;
}

/** Meta's error → a short, non-sensitive description (code/type only — its
 * free-text `message` can echo request data). */
async function metaError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: number; error_subcode?: number; type?: string } };
    const e = body.error;
    if (e) return `HTTP ${res.status} code=${e.code ?? "?"}${e.error_subcode ? `/${e.error_subcode}` : ""} type=${e.type ?? "?"}`;
  } catch {
    // non-JSON body
  }
  return `HTTP ${res.status}`;
}

export async function sendTemplate(
  to: string,
  templateName: string,
  language: string,
  parameters: string[],
  options: { buttonParameter?: string } = {}
): Promise<WhatsAppResult> {
  if (!isWhatsAppConfigured()) {
    if (env.NODE_ENV !== "test") console.warn(`[whatsapp] NOT SENT — WhatsApp not configured (template ${templateName})`);
    return { ok: false, error: "not_configured" };
  }
  try {
    const components: unknown[] = [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }];
    if (options.buttonParameter) {
      components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: options.buttonParameter }] });
    }
    const res = await fetch(graphUrl(`${env.WHATSAPP_PHONE_NUMBER_ID}/messages`), {
      method: "POST",
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "template",
        template: { name: templateName, language: { code: language }, components },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      const error = await metaError(res);
      console.error(`[whatsapp] send failed (template ${templateName}): ${error}`);
      return { ok: false, error };
    }
    const body = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    return { ok: true, messageId: body.messages?.[0]?.id ?? null };
  } catch (error) {
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`[whatsapp] send threw (template ${templateName}): ${kind}`);
    return { ok: false, error: kind };
  }
}

/** Convenience for a prepared template message. */
export function sendTemplateMessage(to: string, message: WhatsAppTemplateMessage): Promise<WhatsAppResult> {
  return sendTemplate(to, message.templateName, WHATSAPP_TEMPLATE_LANGUAGE, message.parameters, {
    buttonParameter: message.buttonParameter,
  });
}

/**
 * « Tester la connexion » — reads the configured sending number from Meta.
 * Sends nothing. Returns only non-secret facts for display.
 */
export async function checkWhatsAppSender(): Promise<
  { ok: true; displayPhoneNumber: string | null; verifiedName: string | null } | { ok: false; error: string }
> {
  if (!isWhatsAppConfigured()) {
    return { ok: false, error: "Configuration WhatsApp manquante (WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID)." };
  }
  try {
    const res = await fetch(graphUrl(`${env.WHATSAPP_PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,quality_rating`), {
      headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      const error = await metaError(res);
      console.error(`[whatsapp] sender check failed: ${error}`);
      return { ok: false, error: `Meta a refusé la vérification du numéro d'envoi (${error}).` };
    }
    const body = (await res.json()) as { display_phone_number?: string; verified_name?: string };
    return { ok: true, displayPhoneNumber: body.display_phone_number ?? null, verifiedName: body.verified_name ?? null };
  } catch (error) {
    const kind = error instanceof Error ? error.name : "unknown";
    console.error(`[whatsapp] sender check threw: ${kind}`);
    return { ok: false, error: "Meta est injoignable pour le moment." };
  }
}
