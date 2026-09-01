import "server-only";

import { registerDeliveryProvider } from "@/lib/integrations/delivery/registry";
import { ozonExpressAdapter } from "./adapter";

export {
  ozonExpressAdapter,
  OZONEXPRESS_PROVIDER_KEY,
  OZONEXPRESS_VERIFICATION,
} from "./adapter";

/**
 * Registers the OzonExpress adapter into the process-wide delivery
 * registry. Call this from
 * `src/lib/integrations/delivery/providers/index.ts` to make OzonExpress
 * selectable in production.
 *
 * ⚠️ It is intentionally NOT called there yet — OzonExpress's API contract
 * is reconstructed from community integrations, not official documentation
 * (`OZONEXPRESS_VERIFICATION === "UNVERIFIED"`). Enable it only once the
 * contract is confirmed with OzonExpress. See
 * docs/adr/0013-ozonexpress-integration.md.
 */
export function registerOzonExpressProvider(): void {
  registerDeliveryProvider(ozonExpressAdapter);
}
