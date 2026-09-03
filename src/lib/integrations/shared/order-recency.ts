import "server-only";

// A bulk history import must not fan out a "nouvelle commande"
// notification for every order it pulls in — only for one that was
// actually placed in the last couple of days (a fresh webhook order, or a
// sync catching an order minutes after it landed). The order row, audit
// event and everything else are still created for older orders; only the
// alert is skipped.
const NOTIFY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** True when the provider's order-creation timestamp is recent enough to
 * be worth a "new order" notification. Unparseable dates count as not
 * recent (a backfill is the likelier source of a bad date than a live
 * order). */
export function isRecentlyPlaced(sourceCreatedAt: string): boolean {
  const placedAt = new Date(sourceCreatedAt).getTime();
  return !Number.isNaN(placedAt) && Date.now() - placedAt < NOTIFY_WINDOW_MS;
}
