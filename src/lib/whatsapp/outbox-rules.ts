import { WHATSAPP_TEMPLATE_SPECS } from "@/lib/whatsapp/templates";

/**
 * Pure rules of the staff WhatsApp outbox — docs/adr/0058 addendum
 * (2026-10-16). No database, no env, no network: the outbox
 * (src/lib/whatsapp/outbox.ts) feeds these the facts and applies the answer.
 *
 * Lifecycle of one row (one business event × one recipient):
 *   EN_ATTENTE ──claim──▶ EN_COURS ──Meta OK──▶ ENVOYE
 *                              ├─ transient failure, attempts < MAX ─▶ EN_ATTENTE (+backoff)
 *                              ├─ transient failure, attempts = MAX ─▶ ECHEC
 *                              ├─ permanent Meta refusal ────────────▶ ECHEC
 *                              └─ not sendable any more ─────────────▶ IGNORE
 *   ECHEC ──« Réessayer » (admin)──▶ EN_ATTENTE (attempts reset)
 */

/** Total send attempts before a transiently-failing row becomes ECHEC. */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** First retry delay; each next one ×4 (1 min, 4 min, 16 min, 64 min). */
export const OUTBOX_BASE_RETRY_MS = 60_000;
export const OUTBOX_MAX_RETRY_MS = 6 * 60 * 60_000;
/**
 * An EN_COURS row whose claim is older than this is considered abandoned (the
 * process died mid-send) and may be claimed again. Far above the client's
 * 8 s Meta timeout, so a live sender is never overtaken.
 */
export const OUTBOX_STALE_CLAIM_MS = 2 * 60_000;
/** An alert still unsent after this long is no longer useful: ECHEC instead of sending it late. */
export const OUTBOX_EXPIRY_MS = 24 * 60 * 60_000;

export type OutboxStatus = "EN_ATTENTE" | "EN_COURS" | "ENVOYE" | "ECHEC" | "IGNORE";

// ---------------------------------------------------------------------------
// Template availability
// ---------------------------------------------------------------------------

/** WHATSAPP_ENABLED_TEMPLATES (comma-separated template names) → a set. */
export function parseEnabledTemplates(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-z0-9_]{1,512}$/.test(s))
  );
}

/**
 * Whether a template may be sent. The four V1 templates are always
 * available (backward compatible). Any other one only when the operator
 * listed it in WHATSAPP_ENABLED_TEMPLATES — i.e. stated Meta approved it.
 * An unknown template name is never sendable unless listed.
 */
export function isTemplateSendable(templateName: string, enabled: ReadonlySet<string>): boolean {
  if (WHATSAPP_TEMPLATE_SPECS.some((t) => t.name === templateName && t.approvedV1)) return true;
  return enabled.has(templateName);
}

export const IGNORE_REASONS = {
  templateNotEnabled: (name: string) =>
    `Configuration : modèle « ${name} » non approuvé/configuré (à déclarer dans WHATSAPP_ENABLED_TEMPLATES).`,
  tenantDisabled: "WhatsApp désactivé pour l'entreprise.",
  categoryDisabled: "Catégorie d'alerte désactivée par l'entreprise.",
  userMuted: "Alerte coupée par le destinataire.",
  recipientNotReady: "Destinataire inactif ou numéro WhatsApp non vérifié / non accepté.",
  recipientNotAllowed: "Destinataire hors de la liste de test (WHATSAPP_ALLOWED_RECIPIENTS).",
} as const;

export interface SendabilityFacts {
  templateName: string;
  enabledTemplates: ReadonlySet<string>;
  tenantEnabled: boolean;
  alertType: string | null;
  companyDisabled: readonly string[];
  /** ACTIVE + verified number + opted in. */
  recipientReady: boolean;
  userMuted: readonly string[];
}

/** Why a row must be IGNOREd right now, or null when it may be sent. Order = most structural first. */
export function ignoreReason(f: SendabilityFacts): string | null {
  if (!isTemplateSendable(f.templateName, f.enabledTemplates)) return IGNORE_REASONS.templateNotEnabled(f.templateName);
  if (!f.tenantEnabled) return IGNORE_REASONS.tenantDisabled;
  if (f.alertType && f.companyDisabled.includes(f.alertType)) return IGNORE_REASONS.categoryDisabled;
  if (!f.recipientReady) return IGNORE_REASONS.recipientNotReady;
  if (f.alertType && f.userMuted.includes(f.alertType)) return IGNORE_REASONS.userMuted;
  return null;
}

// ---------------------------------------------------------------------------
// Failure classification + backoff
// ---------------------------------------------------------------------------

export type FailureKind = "transient" | "permanent" | "ignore";

/**
 * Meta error codes that mean "try again later" (rate limits, temporary
 * unavailability). Everything else Meta answers with a 4xx is a permanent
 * refusal for THIS message (template missing/paused, bad parameter,
 * undeliverable number, token revoked…) — retrying the same request would
 * fail the same way, so it goes straight to ECHEC (manual « Réessayer »).
 */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);

/**
 * Classifies the client's error string (src/lib/whatsapp/client.ts: "HTTP
 * <status> code=<n>[/<sub>] type=<t>", "not_configured",
 * "recipient_not_allowed", or a thrown error's name such as "TimeoutError").
 */
export function classifySendError(error: string): FailureKind {
  if (error === "recipient_not_allowed") return "ignore";
  const http = /^HTTP (\d{3})/.exec(error);
  if (!http) return "transient"; // network error, timeout, unexpected throw, not_configured (config can come back)
  const status = Number(http[1]);
  const code = /code=(\d+)/.exec(error);
  if (code && TRANSIENT_META_CODES.has(Number(code[1]))) return "transient";
  if (status === 408 || status === 429 || status >= 500) return "transient";
  return "permanent";
}

/** Delay before retry number `attempt + 1`, after `attempt` failed attempts (≥ 1). */
export function retryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.trunc(attempt));
  return Math.min(OUTBOX_BASE_RETRY_MS * 4 ** (n - 1), OUTBOX_MAX_RETRY_MS);
}

/**
 * A stored, displayable error: short, and never a token, a phone number or
 * a message parameter. The client already reduces Meta's answer to
 * code/type (its free-text message can echo request data); this is the
 * second guard — anything that looks like a credential or a number is
 * masked, and the length is capped.
 */
export function sanitizeOutboxError(raw: string): string {
  return raw
    .replace(/Bearer\s+\S+/gi, "Bearer •••")
    .replace(/\bEAA[A-Za-z0-9]{8,}\b/g, "•••") // Meta access tokens
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "•••") // phone-number-like runs (Meta codes are ≤ 6 digits)
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 200);
}

export type FailureDecision =
  | { status: "EN_ATTENTE"; nextAttemptAt: Date; lastError: string }
  | { status: "ECHEC"; lastError: string }
  | { status: "IGNORE"; lastError: string };

/** What a failed attempt turns the row into. `attempts` already counts this attempt. */
export function decideAfterFailure(p: { attempts: number; error: string; now: Date }): FailureDecision {
  const code = sanitizeOutboxError(p.error);
  const kind = classifySendError(p.error);
  if (kind === "ignore") return { status: "IGNORE", lastError: IGNORE_REASONS.recipientNotAllowed };
  if (kind === "permanent") return { status: "ECHEC", lastError: `Refus définitif de Meta (${code}).` };
  if (p.attempts >= OUTBOX_MAX_ATTEMPTS) {
    return { status: "ECHEC", lastError: `Échec après ${p.attempts} tentatives (${code}).` };
  }
  return {
    status: "EN_ATTENTE",
    nextAttemptAt: new Date(p.now.getTime() + retryDelayMs(p.attempts)),
    lastError: `Erreur temporaire, nouvel essai prévu (${code}).`,
  };
}

/** A row created more than OUTBOX_EXPIRY_MS ago is not sent any more. */
export function isOutboxRowExpired(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > OUTBOX_EXPIRY_MS;
}

export const OUTBOX_EXPIRED_ERROR = "Délai d'envoi dépassé (plus de 24 h) : alerte non envoyée.";
