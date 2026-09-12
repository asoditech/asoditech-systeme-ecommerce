import { z } from "zod";

/**
 * The centralized feature/entitlement catalogue — see
 * docs/adr/0035-plans-entitlements-usage.md. This is the single place a
 * feature key is declared; `Plan.features` (JSONB) is validated against
 * `planFeaturesSchema` below everywhere it's read, so a malformed or
 * partially-edited row in `/platform/plans` can never silently produce
 * `undefined` at a `checkEntitlement()` call site.
 *
 * Three tiered keys (`reports`, `profitability`, `backup`) carry
 * `"standard" | "advanced"` rather than a boolean, matching the
 * commercial table (Business = standard, Pro = advanced) — every other
 * key is a plain boolean. Both plans hold `true`/`"standard"` at minimum
 * for every key today: the brief is explicit that Business must remain a
 * genuinely useful, full product, not a crippled tier. No existing
 * report, backup, or module page is hard-gated behind "advanced" in this
 * phase — the tier is modeled and shown in the UI, ready for a future,
 * deliberate decision about which specific advanced-only capability (not
 * yet built) becomes Pro-exclusive.
 */
export const FEATURE_KEYS = [
  "orders",
  "users",
  "warehouses",
  "woocommerce",
  "shopify",
  "reports",
  "profitability",
  "backup",
  "aiAssistant",
  "integrations",
  "notifications",
  "commissions",
  "finance",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** French display label per feature — the client-facing usage page and
 * the platform plan editor both show these; only the features worth
 * showing as a distinct checklist item are listed (the trivially-always-on
 * "orders"/"users"/"warehouses" module flags are represented by their own
 * numeric usage cards instead, not repeated here). */
export const FEATURE_KEY_LABELS: Partial<Record<FeatureKey, string>> = {
  woocommerce: "WooCommerce",
  shopify: "Shopify",
  reports: "Rapports",
  profitability: "Rentabilité",
  backup: "Sauvegarde",
  aiAssistant: "Assistant IA",
  commissions: "Commissions de confirmation",
  finance: "Finance & dépenses",
};

/** Keys whose value is a tier, not a plain boolean. */
export const TIERED_FEATURE_KEYS = ["reports", "profitability", "backup"] as const;
export type TieredFeatureKey = (typeof TIERED_FEATURE_KEYS)[number];
export type FeatureTier = "standard" | "advanced";

const tierSchema = z.enum(["standard", "advanced"]);

/**
 * `support` is informational only (shown in the plan comparison / usage
 * page as "Support standard" / "Support prioritaire") — it gates nothing
 * in code, since there is no support-ticket priority queue to wire it
 * into (`SupportTicket` is deliberately minimal, no SLA — see its own
 * schema comment). Kept in the same JSON blob rather than a separate
 * column so the whole commercial description of a plan lives in one place.
 */
export const planFeaturesSchema = z
  .object({
    orders: z.boolean(),
    users: z.boolean(),
    warehouses: z.boolean(),
    woocommerce: z.boolean(),
    shopify: z.boolean(),
    reports: tierSchema,
    profitability: tierSchema,
    backup: tierSchema,
    aiAssistant: z.boolean(),
    integrations: z.boolean(),
    notifications: z.boolean(),
    commissions: z.boolean(),
    finance: z.boolean(),
    support: z.enum(["standard", "priority"]).optional(),
  })
  .strict();

export type PlanFeatures = z.infer<typeof planFeaturesSchema>;

/** Parses and validates a `Plan.features` JSONB value. Throws a clear
 * error rather than silently returning a partially-typed object — a
 * malformed row here means every entitlement check for every tenant on
 * that plan would otherwise fail unpredictably. */
export function parsePlanFeatures(raw: unknown): PlanFeatures {
  return planFeaturesSchema.parse(raw);
}

export function featureValue(features: PlanFeatures, key: FeatureKey): boolean | FeatureTier {
  return features[key];
}

// ---------------------------------------------------------------------------
// Usage status thresholds — centralized, not scattered as magic numbers.
// ---------------------------------------------------------------------------

export type UsageStatus = "NORMAL" | "WARNING" | "CRITICAL" | "LIMIT_REACHED";

/** Percentage-of-limit boundaries. `WARNING` starts at 80%, `CRITICAL` at
 * 90%, `LIMIT_REACHED` at 100%+ — see docs/adr/0035 "Limit behaviour".
 * Centralized here so nothing else in the app hardcodes 80/90/100. */
export const USAGE_THRESHOLDS = {
  WARNING: 80,
  CRITICAL: 90,
  LIMIT_REACHED: 100,
} as const;

/** The ordered list of alert thresholds a `UsageAlertState` row can be
 * advanced through — used by both the status computation and the
 * de-duplicated alert firer (src/lib/entitlements/alerts.ts). */
export const ALERT_THRESHOLDS = [80, 90, 100] as const;

/**
 * `limit === null` means unlimited (reserved for a future CUSTOM plan —
 * never true for BUSINESS/PRO today) — always `NORMAL`, since there is no
 * ceiling to approach. `used`/`limit` must both already be authoritative,
 * server-computed numbers (docs/adr/0035 "Usage metering") — this
 * function does no querying itself, just the threshold math, so it stays
 * trivially unit-testable.
 */
export function computeUsageStatus(used: number, limit: number | null): UsageStatus {
  if (limit === null || limit <= 0) return "NORMAL";
  const pct = (used / limit) * 100;
  if (pct >= USAGE_THRESHOLDS.LIMIT_REACHED) return "LIMIT_REACHED";
  if (pct >= USAGE_THRESHOLDS.CRITICAL) return "CRITICAL";
  if (pct >= USAGE_THRESHOLDS.WARNING) return "WARNING";
  return "NORMAL";
}

export function usagePercent(used: number, limit: number | null): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(999, Math.round((used / limit) * 100));
}
