import "server-only";

import { hasDeliveryProvider, registerDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { ozonExpressAdapter, OZONEXPRESS_PROVIDER_KEY } from "./adapter";

export {
  ozonExpressAdapter,
  OZONEXPRESS_PROVIDER_KEY,
  OZONEXPRESS_VERIFICATION,
} from "./adapter";

/**
 * Registers the OzonExpress adapter into the process-wide delivery
 * registry. Called from
 * `src/lib/integrations/delivery/providers/index.ts` (the production
 * bootstrap) so OzonExpress is selectable in "Livraison → Prestataires".
 *
 * Registration only makes the connector configurable — it does NOT imply a
 * working connection. Saving credentials lands on CONFIGURE; only a
 * successful "Tester la connexion" (a real authenticated request) moves it
 * to CONNECTE. See docs/adr/0013-ozonexpress-integration.md.
 *
 * Idempotent: a no-op if an "ozonexpress" adapter is already registered
 * (dev hot-reload can evaluate the bootstrap more than once).
 */
export function registerOzonExpressProvider(): void {
  if (hasDeliveryProvider(OZONEXPRESS_PROVIDER_KEY)) return;
  registerDeliveryProvider(ozonExpressAdapter);
}
