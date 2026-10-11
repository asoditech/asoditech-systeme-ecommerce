/**
 * Integration card line for failed webhook deliveries (WebhookEvent rows
 * with status ECHEC). A failure used to be invisible: the card only showed
 * when the LAST webhook arrived, never that some could not be processed.
 * A retry reusing the same delivery id overwrites its ECHEC row
 * (webhook-event.ts); a retry with a new id leaves it — so the line says
 * "failed", never "still missing".
 */
export const WEBHOOK_FAILURE_WINDOW_DAYS = 7;

/** Start of the window the card counts failures in. */
export function webhookFailureSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - WEBHOOK_FAILURE_WINDOW_DAYS * 86_400_000);
}

export function webhookFailureMessage(
  failedCount: number,
  lastFailure: { receivedAt: Date; topic: string } | null,
  formatDate: (d: Date) => string
): string | null {
  if (failedCount <= 0 || !lastFailure) return null;
  const what = failedCount === 1 ? "1 webhook n'a pas pu être traité" : `${failedCount} webhooks n'ont pas pu être traités`;
  return `${what} sur les ${WEBHOOK_FAILURE_WINDOW_DAYS} derniers jours (dernier : ${formatDate(lastFailure.receivedAt)}, ${lastFailure.topic}). Vérifiez les commandes concernées ou relancez la synchronisation des commandes.`;
}
