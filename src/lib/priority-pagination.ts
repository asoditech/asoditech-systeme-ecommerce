/**
 * Offset pagination over two ordered segments — the PRIORITY rows (e.g. an
 * exact tracking-number match) first, then every other row — without ever
 * loading a whole result set into memory. Prisma's `orderBy` can't rank by
 * a CASE expression, so each segment is its own bounded query (same
 * `orderBy`, applied by the caller's `findMany`), and the page window is
 * split across them:
 *
 *   rows [skip, skip + take) of  priority ++ rest
 *
 * `priority` and `rest` MUST partition `where` (every row matching `where`
 * is in exactly one of them) — then `total` is exact and no row is shown
 * twice or skipped across pages. Cost: two counts plus at most two page-
 * sized reads.
 */

export interface PriorityPage<R> {
  rows: R[];
  total: number;
}

export async function paginateWithPriority<W, R>(args: {
  where: W;
  /** Rows to rank first, and their exact complement; `null` → plain pagination. */
  priority: { exact: W; rest: W } | null;
  skip: number;
  take: number;
  and: (a: W, b: W) => W;
  count: (where: W) => Promise<number>;
  findMany: (where: W, skip: number, take: number) => Promise<R[]>;
}): Promise<PriorityPage<R>> {
  const { where, priority, skip, take, and, count, findMany } = args;
  if (!priority) {
    const [rows, total] = await Promise.all([findMany(where, skip, take), count(where)]);
    return { rows, total };
  }

  const exactWhere = and(where, priority.exact);
  const restWhere = and(where, priority.rest);
  const [total, exactTotal] = await Promise.all([count(where), count(exactWhere)]);

  const rows: R[] = [];
  if (skip < exactTotal) {
    rows.push(...(await findMany(exactWhere, skip, Math.min(take, exactTotal - skip))));
  }
  const remaining = take - rows.length;
  if (remaining > 0) {
    rows.push(...(await findMany(restWhere, Math.max(0, skip - exactTotal), remaining)));
  }
  return { rows, total };
}
