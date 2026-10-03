/**
 * Critical business-notification emails — docs/adr/0057.
 *
 * One small template for every critical alert (subject, title, short
 * message, optional details, one link back into ASODITECH), and one builder
 * per event so the copy lives here, not at call sites. Only the four
 * critical events below ever email; everything else stays in-app.
 *
 * Content rule: only what the in-app notification already shows its
 * recipient — product name/SKU, location name, order number, carrier,
 * integration name, plan usage. Never a cost, margin, credential, internal
 * id or customer data.
 */

export interface NotificationEmail {
  subject: string;
  title: string;
  message: string;
  details?: [label: string, value: string][];
  /** App-relative page the CTA opens. */
  path: string;
  cta: string;
}

export function outOfStockEmail(p: { productName: string; sku: string; locationName: string }): NotificationEmail {
  return {
    subject: `Rupture de stock : ${p.productName}`,
    title: "Rupture de stock",
    message: `Le produit « ${p.productName} » est en rupture de stock à « ${p.locationName} ».`,
    details: [
      ["Produit", p.productName],
      ...(p.sku ? ([["SKU", p.sku]] as [string, string][]) : []),
      ["Emplacement", p.locationName],
    ],
    path: "/stock",
    cta: "Voir le stock",
  };
}

export function deliveryFailureEmail(p: { orderNumber: string; providerName: string }): NotificationEmail {
  return {
    subject: `Échec de livraison — commande ${p.orderNumber}`,
    title: "Échec de livraison",
    message: "Une ou plusieurs livraisons nécessitent votre attention.",
    details: [
      ["Commande", p.orderNumber],
      ["Transporteur", p.providerName],
    ],
    path: "/livraison",
    cta: "Voir les livraisons",
  };
}

export function integrationErrorEmail(p: { label: string; kind: "Integration" | "ShippingProvider" }): NotificationEmail {
  return {
    subject: `Erreur d'intégration — ${p.label}`,
    title: "Erreur d'intégration",
    message: `Une intégration nécessite votre attention : la connexion à « ${p.label} » a échoué. Vérifiez les identifiants et la configuration.`,
    details: [["Intégration", p.label]],
    path: p.kind === "Integration" ? "/integrations" : "/livraison",
    cta: "Vérifier la configuration",
  };
}

export function planLimitEmail(p: { metricLabel: string; used: number; limit: number }): NotificationEmail {
  return {
    subject: `Limite du forfait atteinte (${p.metricLabel})`,
    title: "Limite du forfait atteinte",
    message: "Votre forfait a atteint sa limite. Une action peut être nécessaire.",
    details: [[`Utilisation (${p.metricLabel})`, `${p.used} / ${p.limit}`]],
    path: "/parametres/abonnement",
    cta: "Voir mon forfait",
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain-text + HTML bodies. `appUrl` comes from the existing APP_URL config. */
export function renderNotificationEmail(email: NotificationEmail, appUrl: string): { subject: string; text: string; html: string } {
  const url = new URL(email.path, appUrl).toString();
  const details = email.details ?? [];
  const text = [
    email.title,
    "",
    email.message,
    ...(details.length ? ["", ...details.map(([k, v]) => `${k} : ${v}`)] : []),
    "",
    `${email.cta} : ${url}`,
    "",
    "— ASODITECH (notification automatique)",
  ].join("\n");
  const rows = details
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#6b7280">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`)
    .join("");
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;max-width:560px">` +
    `<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(email.title)}</h2>` +
    `<p style="margin:0 0 12px">${escapeHtml(email.message)}</p>` +
    (rows ? `<table style="border-collapse:collapse;margin:0 0 16px">${rows}</table>` : "") +
    `<p style="margin:0 0 16px"><a href="${escapeHtml(url)}" style="background:#111827;color:#ffffff;padding:8px 14px;border-radius:6px;text-decoration:none">${escapeHtml(email.cta)}</a></p>` +
    `<p style="margin:0;color:#9ca3af;font-size:12px">ASODITECH — notification automatique</p>` +
    `</div>`;
  return { subject: email.subject.slice(0, 200), text, html };
}
