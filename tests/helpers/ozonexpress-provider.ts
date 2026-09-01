import {
  registerDeliveryProvider,
  __resetDeliveryProviderRegistryForTests,
} from "@/lib/integrations/delivery/registry";
import { ozonExpressAdapter } from "@/lib/integrations/delivery/providers/ozonexpress";

/**
 * Registers the real OzonExpress adapter into the process-wide registry
 * for a test. The adapter is deliberately NOT registered in production
 * (`src/lib/integrations/delivery/providers/index.ts`) because its API
 * contract is unverified — see docs/adr/0013-ozonexpress-integration.md —
 * so tests that need it wire it up themselves, exactly like
 * registerReferenceDeliveryProvider().
 */
export function registerOzonExpressProviderForTests(): void {
  __resetDeliveryProviderRegistryForTests();
  registerDeliveryProvider(ozonExpressAdapter);
}

export { ozonExpressAdapter, OZONEXPRESS_PROVIDER_KEY } from "@/lib/integrations/delivery/providers/ozonexpress";
