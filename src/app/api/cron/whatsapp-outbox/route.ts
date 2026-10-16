import { env } from "@/lib/env";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { processWhatsAppOutboxForAllTenants } from "@/lib/whatsapp/outbox";

/**
 * Staff-WhatsApp outbox retry processor — docs/adr/0058 addendum.
 *
 * `GET /api/cron/whatsapp-outbox` with `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron sends exactly that when the project defines CRON_SECRET).
 * Unset CRON_SECRET → 503, wrong/missing bearer → 401: the route never runs
 * unauthenticated. It sends due retries for every ACTIVE tenant, each one
 * strictly inside its own `runWithTenant`. The response carries counts only.
 *
 * Scheduling is NOT configured here (vercel.json is left untouched) — see
 * docs/CLIENT-ENVIRONMENT-VARIABLES.md « Relances WhatsApp ».
 */

export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  if (!env.CRON_SECRET) {
    return Response.json({ error: "cron_not_configured" }, { status: 503 });
  }
  if (!isAuthorizedCronRequest(request.headers.get("authorization"), env.CRON_SECRET)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const summary = await processWhatsAppOutboxForAllTenants();
  return Response.json({ ok: true, ...summary }, { headers: { "Cache-Control": "no-store" } });
}

export function GET(request: Request): Promise<Response> {
  return handle(request);
}

export function POST(request: Request): Promise<Response> {
  return handle(request);
}
