/**
 * Client-side driver for capped sync actions. Each orders/products sync
 * call does a bounded amount of work (sized for the platform's function
 * time limit) and reports `hasMore`; one click re-invokes the action while
 * there is more, so a large backlog looks like one sync — with a safety cap
 * so a bug can never spin forever. Shared by the integrations cards and the
 * « Synchroniser » button of the Commandes / Produits pages.
 */
export const MAX_SYNC_ITERATIONS = 80;
export const SYNC_ITERATION_GAP_MS = 250;

type StepResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type SyncLoopOutcome =
  | { ok: true; iterations: number; stoppedAtCap: boolean }
  | { ok: false; error: string; iterations: number };

export async function runSyncLoop<T>(
  step: (iteration: number) => Promise<StepResult<T>>,
  hasMore: (data: T) => boolean,
  onProgress: (data: T, iteration: number) => void,
  options: { maxIterations?: number; gapMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<SyncLoopOutcome> {
  const max = options.maxIterations ?? MAX_SYNC_ITERATIONS;
  const gap = options.gapMs ?? SYNC_ITERATION_GAP_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let i = 0; i < max; i++) {
    const result = await step(i);
    if (!result.ok) return { ok: false, error: result.error, iterations: i + 1 };
    onProgress(result.data, i);
    if (!hasMore(result.data)) return { ok: true, iterations: i + 1, stoppedAtCap: false };
    if (i < max - 1) await sleep(gap);
  }
  return { ok: true, iterations: max, stoppedAtCap: true };
}
