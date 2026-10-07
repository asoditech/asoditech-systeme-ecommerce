import type { AuditAction } from "@/lib/audit";

/**
 * Audit-event classification (docs/operations/audit-retention-policy.md).
 *
 * TECHNICAL events record that the system did something mechanical (a sync
 * ran, a connection was tested, tracking was refreshed, a drive call
 * failed…). They stay in the audit journal, but they are not "activity" a
 * manager wants to see — so they are hidden from the dashboard's « Activité
 * récente », where they would otherwise crowd out business events.
 *
 * Typed as AuditAction[]: a misspelt or renamed action fails to compile.
 * Presentation only — nothing here deletes or stops writing an event.
 */
export const TECHNICAL_AUDIT_ACTIONS: readonly AuditAction[] = [
  // Integrations — the sync history / webhook_events tables are the real record.
  "integration.webhook_received", // no longer written; historical rows only
  "integration.sync_started",
  "integration.sync_completed",
  "integration.sync_partial_failure",
  "integration.connection_test_succeeded",
  "integration.connection_test_failed",
  "shipping_provider.connection_test_succeeded",
  "shipping_provider.connection_test_failed",
  // Carrier mechanics — the business outcome (created / status changed /
  // cancelled) is its own event.
  "shipment.tracking_refreshed",
  "shipment.creation_failed",
  "shipment.status_sync_failed",
  "shipment.cancellation_failed",
  "delivery_manifest.failed",
  // Google Drive backup mechanics.
  "backup.drive_token_error",
  "backup.drive_operation_failed",
  "backup.drive_downloaded",
  // Usage / support / exports — recorded in their own places.
  "ai.query",
  "usage.threshold_reached",
  "support.ticket_created",
  "product.exported",
];

/**
 * Routine security events: kept in the journal (security retention) but too
 * frequent to be "recent activity" — every sign-in would push business events
 * off the dashboard. Failed sign-ins and every access/role change stay visible.
 */
export const ROUTINE_SECURITY_AUDIT_ACTIONS: readonly AuditAction[] = ["user.login.success", "user.logout"];

/** What the dashboard's « Activité récente » never shows (the journal shows everything). */
export const DASHBOARD_HIDDEN_AUDIT_ACTIONS: readonly AuditAction[] = [
  ...TECHNICAL_AUDIT_ACTIONS,
  ...ROUTINE_SECURITY_AUDIT_ACTIONS,
];
