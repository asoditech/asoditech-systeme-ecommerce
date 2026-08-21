import "server-only";

/**
 * Production delivery-provider adapter bootstrap. Import each real
 * adapter's registration here — that is the only step needed to make a
 * new carrier selectable once one is implemented.
 *
 * Empty today: no specific delivery carrier was named in this project's
 * specification/ADRs, and the phase brief is explicit that inventing one
 * (guessing an API contract, auth scheme, and status vocabulary without a
 * live account to verify against) would produce untested, likely-broken
 * code — the same reasoning docs/adr/0004-integration-architecture.md
 * already applied to the still-scaffolded Meta/Google/TikTok/WhatsApp/
 * Email/Sheets/AI providers. See
 * docs/adr/0012-delivery-provider-integration.md, "Provider selection".
 *
 * This file is imported by src/lib/integrations/delivery/service.ts so the
 * registry is populated before any Server Action resolves a provider by
 * key. It must never import test/fixture adapters — those live under
 * tests/helpers and register themselves directly into the registry from
 * test code, never from here.
 */
export {};
