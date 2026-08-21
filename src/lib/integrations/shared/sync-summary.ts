/**
 * Honest per-run sync result, shared by every provider. A sync must never
 * report bare "success" — every item that was actually touched is
 * accounted for in one bucket below, so a caller (UI, audit log) can tell
 * "100 imported" apart from "97 imported, 3 failed" instead of just
 * "done". See docs/adr/0010-woocommerce-integration.md and
 * docs/adr/0011-shopify-integration.md.
 */
export interface SyncSummary {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  /** Capped list of the first N failure/skip reasons, for the UI and SyncRun.errorSummary — never a raw external payload. */
  notes: string[];
}

export function emptySyncSummary(): SyncSummary {
  return { imported: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, notes: [] };
}

const MAX_NOTES = 20;

export function recordNote(summary: SyncSummary, note: string): void {
  if (summary.notes.length < MAX_NOTES) summary.notes.push(note);
}
