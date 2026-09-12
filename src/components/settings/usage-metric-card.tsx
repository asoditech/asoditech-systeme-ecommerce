import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatNumber } from "@/lib/format";
import type { UsageStatus } from "@/lib/entitlements/catalogue";
import type { LucideIcon } from "lucide-react";

/** 🟢🟠🔴⚫ — the exact, friendly indicator set requested for the
 * client-facing usage page (docs/adr/0035 "Client usage dashboard"). Kept
 * separate from the denser `Badge`-based `USAGE_STATUS_LABELS` used on
 * the platform side (src/lib/status-labels.ts) — same underlying
 * `UsageStatus`, different presentation for a different audience. */
const STATUS_EMOJI: Record<UsageStatus, string> = {
  NORMAL: "🟢",
  WARNING: "🟠",
  CRITICAL: "🔴",
  LIMIT_REACHED: "⚫",
};

const PROGRESS_TONE: Record<UsageStatus, string> = {
  NORMAL: "bg-primary",
  WARNING: "bg-amber-500",
  CRITICAL: "bg-rose-500",
  LIMIT_REACHED: "bg-rose-700",
};

const STATUS_SENTENCE: Record<UsageStatus, (used: string, limit: string, unit: string) => string> = {
  NORMAL: (used, limit, unit) => `Vous avez utilisé ${used} ${unit} sur ${limit} ce mois-ci.`,
  WARNING: (used, limit, unit) => `Vous avez utilisé ${used} ${unit} sur ${limit}. Vous approchez de la limite de votre forfait.`,
  CRITICAL: (used, limit, unit) => `Vous avez utilisé ${used} ${unit} sur ${limit}. Vous êtes proche de la limite de votre forfait.`,
  LIMIT_REACHED: (used, limit, unit) => `Vous avez utilisé ${used} ${unit} sur ${limit}. Vous avez atteint la limite de votre forfait.`,
};

export function UsageMetricCard({
  label,
  icon: Icon,
  used,
  limit,
  status,
  unit,
}: {
  label: string;
  icon?: LucideIcon;
  used: number;
  limit: number | null;
  status: UsageStatus;
  /** e.g. "commandes", "utilisateurs", "entrepôts" — used in the sentence below the numbers. */
  unit: string;
}) {
  const percent = limit !== null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
          </div>
          <span aria-hidden="true">{STATUS_EMOJI[status]}</span>
        </div>

        {limit === null ? (
          <>
            <p className="text-2xl font-semibold tracking-tight">{formatNumber(used)}</p>
            <p className="text-xs text-muted-foreground">Illimité sur votre forfait.</p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tracking-tight">
              {formatNumber(used)} <span className="text-base font-normal text-muted-foreground">/ {formatNumber(limit)}</span>
            </p>
            <Progress value={percent ?? 0} indicatorClassName={PROGRESS_TONE[status]} />
            <p className="text-xs text-muted-foreground">
              {STATUS_SENTENCE[status](formatNumber(used), formatNumber(limit), unit)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
