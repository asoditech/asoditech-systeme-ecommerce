import "server-only";

import { registerOzonExpressProvider } from "./ozonexpress";

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
 */
registerOzonExpressProvider();
