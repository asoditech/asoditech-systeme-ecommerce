import type { WhatsAppAlertType } from "@/lib/whatsapp/alert-types";

/**
 * The Meta message templates staff WhatsApp alerts may send — docs/adr/0058
 * (+ 2026-10-16 addendum: new templates, outbox).
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

/** « Nouvelle commande {{1}} reçue ({{2}}). » — {{2}} = where it came from. */
export function newOrderTemplate(p: { orderNumber: string; sourceLabel: string }): WhatsAppTemplateMessage {
  return { templateName: "asoditech_new_order", parameters: [param(p.orderNumber, 40), param(p.sourceLabel, 60)] };
}

/** « La commande {{1}} a été confirmée. » */
export function orderConfirmedTemplate(p: { orderNumber: string }): WhatsAppTemplateMessage {
  return { templateName: "asoditech_order_confirmed", parameters: [param(p.orderNumber, 40)] };
}

/** « Stock faible : {{1}} — {{2}} unité(s) disponible(s) à {{3}}. » */
export function stockLowTemplate(p: { productName: string; available: number; locationName: string }): WhatsAppTemplateMessage {
  return {
    templateName: "asoditech_stock_low",
    parameters: [param(p.productName), String(Math.max(0, Math.trunc(p.available))), param(p.locationName)],
  };
}

/** « La commande {{1}} a été retournée. » */
export function orderReturnedTemplate(p: { orderNumber: string }): WhatsAppTemplateMessage {
  return { templateName: "asoditech_order_returned", parameters: [param(p.orderNumber, 40)] };
}

// ---------------------------------------------------------------------------
// Catalogue — what must exist in the central WhatsApp Business Account.
// ---------------------------------------------------------------------------

export interface WhatsAppTemplateSpec {
  name: string;
  /** Meta category to request when submitting the template. */
  category: "UTILITY" | "AUTHENTICATION";
  /** Suggested French body (the approved wording may differ, the parameter order may not). */
  body: string;
  /** Body parameters {{1}}..{{n}}, in order. */
  parameters: string[];
  /** The alert categories that use it (none = the verification code). */
  alertTypes: WhatsAppAlertType[];
  /**
   * V1 templates (approved before the outbox) — always sendable, backward
   * compatible. Every other template is sendable only when listed in
   * WHATSAPP_ENABLED_TEMPLATES (the operator's statement that Meta approved it).
   */
  approvedV1: boolean;
}

export const WHATSAPP_TEMPLATE_SPECS: readonly WhatsAppTemplateSpec[] = [
  {
    name: "asoditech_stock_out",
    category: "UTILITY",
    body: "Rupture de stock : {{1}} est épuisé à {{2}}.",
    parameters: ["produit", "emplacement"],
    alertTypes: ["RUPTURE_STOCK"],
    approvedV1: true,
  },
  {
    name: "asoditech_delivery_failure_summary",
    category: "UTILITY",
    body: "{{1}} livraison(s) en échec nécessitent votre attention ({{2}}).",
    parameters: ["nombre d'échecs", "transporteurs"],
    alertTypes: ["ECHEC_LIVRAISON"],
    approvedV1: true,
  },
  {
    name: "asoditech_integration_down",
    category: "UTILITY",
    body: "Erreur d'intégration : la connexion à {{1}} a échoué. Vérifiez la configuration.",
    parameters: ["intégration"],
    alertTypes: ["ERREUR_INTEGRATION", "ECHEC_SYNCHRONISATION"],
    approvedV1: true,
  },
  {
    name: "asoditech_verification_code",
    category: "AUTHENTICATION",
    body: "{{1}} est votre code de vérification. (+ bouton « Copier le code »)",
    parameters: ["code à 6 chiffres"],
    alertTypes: [],
    approvedV1: true,
  },
  {
    name: "asoditech_new_order",
    category: "UTILITY",
    body: "Nouvelle commande {{1}} reçue ({{2}}). Ouvrez ASODITECH pour la traiter.",
    parameters: ["numéro de commande", "origine (WooCommerce, Shopify, saisie manuelle)"],
    alertTypes: ["NOUVELLE_COMMANDE"],
    approvedV1: false,
  },
  {
    name: "asoditech_order_confirmed",
    category: "UTILITY",
    body: "La commande {{1}} a été confirmée. Elle peut être préparée.",
    parameters: ["numéro de commande"],
    alertTypes: ["COMMANDE_CONFIRMEE"],
    approvedV1: false,
  },
  {
    name: "asoditech_stock_low",
    category: "UTILITY",
    body: "Stock faible : {{1}} — {{2}} unité(s) disponible(s) à {{3}}.",
    parameters: ["produit", "quantité disponible", "emplacement"],
    alertTypes: ["STOCK_FAIBLE"],
    approvedV1: false,
  },
  {
    name: "asoditech_order_returned",
    category: "UTILITY",
    body: "La commande {{1}} a été retournée. Vérifiez la réception du colis.",
    parameters: ["numéro de commande"],
    alertTypes: ["COMMANDE_RETOURNEE"],
    approvedV1: false,
  },
];

/** The template an alert category is sent with. */
export function templateForAlertType(type: WhatsAppAlertType): WhatsAppTemplateSpec {
  return WHATSAPP_TEMPLATE_SPECS.find((t) => t.alertTypes.includes(type))!;
}
