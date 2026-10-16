import "server-only";

import { env } from "@/lib/env";
import { parseEnabledTemplates } from "@/lib/whatsapp/outbox-rules";

/**
 * The post-V1 templates the operator declared approved
 * (WHATSAPP_ENABLED_TEMPLATES) — docs/adr/0058 addendum. Its own tiny
 * module so tests can mock it instead of the parsed env.
 */
export function getEnabledWhatsAppTemplates(): Set<string> {
  return parseEnabledTemplates(env.WHATSAPP_ENABLED_TEMPLATES);
}
