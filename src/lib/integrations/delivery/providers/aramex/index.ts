import "server-only";

import { hasDeliveryProvider, registerDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { aramexAdapter, ARAMEX_PROVIDER_KEY } from "./adapter";

export { aramexAdapter, ARAMEX_PROVIDER_KEY, ARAMEX_VERIFICATION } from "./adapter";

/**
 * Registers the Aramex adapter into the process-wide delivery registry.
 * Called from `src/lib/integrations/delivery/providers/index.ts` (the
 * production bootstrap) so Aramex is selectable in "Livraison →
 * Prestataires".
 *
 * Registration only makes the connector configurable — it does NOT imply a
 * working connection. Saving credentials lands on CONFIGURE; only a
 * successful "Tester la connexion" (a real authenticated request) moves it
 * to CONNECTE. See docs/adr/0028-aramex-integration.md.
 *
 * Idempotent: a no-op if an "aramex" adapter is already registered (dev
 * hot-reload can evaluate the bootstrap more than once).
 */
export function registerAramexProvider(): void {
  if (hasDeliveryProvider(ARAMEX_PROVIDER_KEY)) return;
  registerDeliveryProvider(aramexAdapter);
}
