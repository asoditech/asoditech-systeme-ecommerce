import type { ReturnParcelState } from "@/lib/queries/return-receiving";
import type { ReceiveParcelResult } from "@/lib/returns/reception";

/** What a parcel's badge shows — its stage, or that reception isn't allowed. */
export type ReturnParcelDisplayState = ReturnParcelState | "NON_ELIGIBLE";

/**
 * The badge of one row of the scan lot (src/components/returns/returns-workspace.tsx).
 * Display only — eligibility itself is decided server-side (lookup + reception).
 *   - the server's answer to « Réceptionner le lot » wins over the stage the
 *     parcel had when it was scanned: received (or found pending) → « Reçu —
 *     à inspecter »; refused as not eligible → « Non éligible »; refused as
 *     already inspected → « Inspecté »; refused because every unit is already
 *     recorded as returned → « Inspecté » if inspected here, else « Déjà
 *     retourné » (returned outside the workspace, e.g. the order page).
 *   - a parcel the carrier doesn't report as returned and that was never
 *     received → « Non éligible », never « À réceptionner »;
 *   - otherwise the parcel's own stage (an earlier reception stays true even
 *     if the carrier status changed since).
 */
export function lotRowDisplayState(
  parcel: { eligible: boolean; state: ReturnParcelState },
  result?: ReceiveParcelResult
): ReturnParcelDisplayState {
  if (result?.ok) return "A_INSPECTER";
  if (result && !result.ok) {
    if (result.code === "not_eligible") return "NON_ELIGIBLE";
    if (result.code === "already_inspected") return "INSPECTE";
    if (result.code === "nothing_remaining") return parcel.state === "INSPECTE" ? "INSPECTE" : "DEJA_RETOURNE";
  }
  if (!parcel.eligible && parcel.state === "A_RECEPTIONNER") return "NON_ELIGIBLE";
  return parcel.state;
}
