import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { TroubleshootingEntry } from "@/lib/docs/types";

/**
 * Collapsible troubleshooting entries — plain native <details>, no new
 * component library, fully keyboard/accessible by default.
 */
export function TroubleshootingBlock({ entries }: { entries: TroubleshootingEntry[] }) {
  return (
    <div className="space-y-2.5">
      {entries.map((entry, i) => (
        <details key={i} className="group rounded-lg border" open={entries.length === 1}>
          <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 text-sm font-medium select-none">
            <AlertTriangle className="size-4 shrink-0 text-amber-500" />
            <span>{entry.symptom}</span>
          </summary>
          <div className="space-y-2.5 border-t px-3.5 py-3 text-sm">
            <p>
              <span className="font-medium text-muted-foreground">Cause probable — </span>
              {entry.cause}
            </p>
            <p>
              <span className="font-medium text-muted-foreground">Vérification — </span>
              {entry.check}
            </p>
            <p>
              <span className="font-medium text-muted-foreground">Solution — </span>
              {entry.solution}
            </p>
            <p>
              <span className="font-medium text-muted-foreground">Résultat attendu — </span>
              {entry.expectedResult}
            </p>
            {entry.errorStrings && entry.errorStrings.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {entry.errorStrings.map((err, j) => (
                  <Badge key={j} variant="outline" className="font-mono text-[11px] font-normal whitespace-normal">
                    « {err} »
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
