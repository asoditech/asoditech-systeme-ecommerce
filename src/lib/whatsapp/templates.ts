/**
 * The Meta-approved message templates WhatsApp V1 may send — docs/adr/0058.
 * Templates only (never free-form text): business-initiated messages
 * require them. They must exist and be APPROVED, language "fr", in the
 * central ASODITECH WhatsApp Business Account; nothing here creates them.
 *
 * Parameters carry only what the in-app notification already shows its
 * recipient (product name, location name, carrier, integration name) —
 * never a cost, price, internal id, credential or customer data.
 */

export const WHATSAPP_TEMPLATE_LANGUAGE = "fr";

export interface WhatsAppTemplateMessage {
  templateName: string;
  /** Body {{1}}..{{n}}, in order. */
  parameters: string[];
  /** Authentication templates only: the copy-code button's parameter. */
  buttonParameter?: string;
}

/** Meta rejects parameters with newlines/tabs or > 4 consecutive spaces. */
function param(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || "—";
}

/** « Rupture de stock : {{1}} est épuisé à {{2}}. » */
export function stockOutTemplate(p: { productName: string; locationName: string }): WhatsAppTemplateMessage {
  return { templateName: "asoditech_stock_out", parameters: [param(p.productName), param(p.locationName)] };
}

/** « {{1}} livraison(s) en échec nécessitent votre attention ({{2}}). » */
export function deliveryFailureSummaryTemplate(p: { count: number; providerNames: string[] }): WhatsAppTemplateMessage {
  const providers = [...new Set(p.providerNames)].sort();
  return {
    templateName: "asoditech_delivery_failure_summary",
    parameters: [String(p.count), param(providers.join(", "))],
  };
}

/** « Erreur d'intégration : la connexion à {{1}} a échoué. » */
export function integrationDownTemplate(p: { label: string }): WhatsAppTemplateMessage {
  return { templateName: "asoditech_integration_down", parameters: [param(p.label)] };
}

/**
 * Number verification — a Meta "Authentication" template (« {{1}} est
 * votre code de vérification. » + copy-code button). Not a business
 * notification; sent only on the user's own request.
 */
export function verificationCodeTemplate(code: string): WhatsAppTemplateMessage {
  return { templateName: "asoditech_verification_code", parameters: [code], buttonParameter: code };
}
