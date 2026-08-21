export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export function actionError(error: string, fieldErrors?: Record<string, string[]>): ActionResult<never> {
  return { ok: false, error, fieldErrors };
}

export function actionOk<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/**
 * Return shape for actions whose caller only needs the created/updated
 * row's id (e.g. to redirect or revalidate) — never the full Prisma record,
 * since Decimal fields aren't serializable across the Server Action ->
 * Client Component boundary (see docs/adr/0007-finance-and-profit.md).
 */
export interface IdResult {
  id: string;
}
