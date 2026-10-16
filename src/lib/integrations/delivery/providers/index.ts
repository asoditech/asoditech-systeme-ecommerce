import "server-only";

import { registerAmeexProvider } from "./ameex";
import { registerAramexProvider } from "./aramex";
import { registerOzonExpressProvider } from "./ozonexpress";
import { registerSenditProvider } from "./sendit";

/**
 * Production delivery-provider adapter bootstrap. Each real adapter
 * registers itself here — that is the only step needed to make a carrier
 * selectable in "Livraison → Prestataires".
 *
 * This file is imported by src/lib/integrations/delivery/service.ts and
 * src/lib/queries/delivery.ts so the registry is populated before any
 * Server Action or page resolves a provider by key. It must never import
 * test/fixture adapters — those live under tests/helpers and register
 * themselves directly into the registry from test code.
 *
 * ── OzonExpress (Maroc) ───────────────────────────────────────────────
 * Registered so the owner can configure credentials (Customer ID + API
 * Key) and run "Tester la connexion". The four endpoints it uses
 * (add-parcel / parcel-info / tracking / GET /cities) and path-based auth
 * are confirmed by owner-provided documentation. Registration does NOT
 * mark it CONNECTE — saving credentials is CONFIGURE; only a successful
 * real connection test transitions to CONNECTE. Its request/response field
 * schemas are still the Phase 23 resilient reconstruction pending a live
 * call. See docs/adr/0013-ozonexpress-integration.md.
 *
 * ── Aramex ───────────────────────────────────────────────────────────
 * Registered so the owner can configure credentials (the six `ClientInfo`
 * values) + the shipper address and run "Tester la connexion". Uses
 * Aramex's JSON-over-HTTPS Shipping/Tracking/RateCalculator services.
 * Same posture as OzonExpress: registration is CONFIGURE, only a real
 * connection test transitions to CONNECTE. Request field names come from
 * Aramex's official sample code; nothing has been run against a live
 * Aramex account yet. See docs/adr/0028-aramex-integration.md.
 * Retired for NEW connections (acceptsNewConnections: false, docs/adr/0060).
 *
 * ── Sendit (Maroc) ───────────────────────────────────────────────────
 * Client + adapter built from the official public spec
 * (https://app.sendit.ma/docs/api-docs.json): login → Bearer JWT, create,
 * status/tracking, districts, labels. Selectable for new connections with a
 * visible « pas encore validé sur un compte réel » notice; status mapping
 * provisional. Same posture: only a real connection test → CONNECTE. See
 * docs/carriers/sendit.md.
 *
 * ── Ameex (Maroc) ────────────────────────────────────────────────────
 * Header auth (C-Api-Id / C-Api-Key); create (form-encoded, one attempt),
 * status/tracking, cities and signed webhooks — every shape verified on the
 * Ameex SANDBOX on 2026-10-16 (production key NOT tested). Selectable for
 * new connections with a visible « bac à sable uniquement » notice; status
 * mapping provisional. Same posture: only a real connection test →
 * CONNECTE. See docs/carriers/ameex.md.
 */
registerOzonExpressProvider();
registerAramexProvider();
registerSenditProvider();
registerAmeexProvider();
