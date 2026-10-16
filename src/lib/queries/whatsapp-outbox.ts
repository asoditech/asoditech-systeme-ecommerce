import "server-only";

import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { isWhatsAppConfigured } from "@/lib/whatsapp/client";
import { WHATSAPP_ALERT_LABELS, WHATSAPP_ALERT_TYPES, isWhatsAppAlertType, type WhatsAppAlertType } from "@/lib/whatsapp/alert-types";
import { WHATSAPP_TEMPLATE_SPECS, templateForAlertType } from "@/lib/whatsapp/templates";
import { isTemplateSendable, type OutboxStatus } from "@/lib/whatsapp/outbox-rules";
import { getEnabledWhatsAppTemplates } from "@/lib/whatsapp/template-config";

/**
 * Intégrations → WhatsApp « Suivi des alertes » (docs/adr/0058 addendum):
 * read-only facts for an `integrations.manage` holder, current tenant only.
 * Never a phone number, a token or a message parameter: recipients are shown
 * by NAME, errors are the sanitized `lastError`.
 */

export interface WhatsAppCategoryRow {
  type: WhatsAppAlertType;
  label: string;
  templateName: string;
  templateAvailable: boolean;
  enabledForCompany: boolean;
}

export interface WhatsAppTemplateRow {
  name: string;
  body: string;
  parameters: string[];
  category: string;
  available: boolean;
  approvedV1: boolean;
}

export interface WhatsAppOutboxRow {
  id: string;
  createdAt: Date;
  sentAt: Date | null;
  alertLabel: string;
  recipientName: string;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
}

export interface WhatsAppOperationsOverview {
  senderConfigured: boolean;
  tenantEnabled: boolean;
  retryScheduleConfigured: boolean;
  categories: WhatsAppCategoryRow[];
  templates: WhatsAppTemplateRow[];
  recent: WhatsAppOutboxRow[];
  counts: { waiting: number; failed: number };
}

export async function getWhatsAppOperationsOverview(): Promise<WhatsAppOperationsOverview> {
  const enabled = getEnabledWhatsAppTemplates();
  const [integration, settings, recent, waiting, failed] = await Promise.all([
    prisma.integration.findFirst({ where: { provider: "WHATSAPP" }, select: { status: true } }),
    prisma.businessSettings.findFirst({ select: { whatsappDisabledAlerts: true } }),
    prisma.whatsAppOutboxMessage.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        createdAt: true,
        sentAt: true,
        alertType: true,
        status: true,
        attempts: true,
        lastError: true,
        user: { select: { name: true } },
      },
    }),
    prisma.whatsAppOutboxMessage.count({ where: { status: { in: ["EN_ATTENTE", "EN_COURS"] } } }),
    prisma.whatsAppOutboxMessage.count({ where: { status: "ECHEC" } }),
  ]);
  const disabled = settings?.whatsappDisabledAlerts ?? [];
  return {
    senderConfigured: isWhatsAppConfigured(),
    tenantEnabled: integration?.status === "CONNECTE",
    retryScheduleConfigured: Boolean(env.CRON_SECRET),
    categories: WHATSAPP_ALERT_TYPES.map((type) => {
      const spec = templateForAlertType(type);
      return {
        type,
        label: WHATSAPP_ALERT_LABELS[type],
        templateName: spec.name,
        templateAvailable: isTemplateSendable(spec.name, enabled),
        enabledForCompany: !disabled.includes(type),
      };
    }),
    templates: WHATSAPP_TEMPLATE_SPECS.map((t) => ({
      name: t.name,
      body: t.body,
      parameters: t.parameters,
      category: t.category,
      available: isTemplateSendable(t.name, enabled),
      approvedV1: t.approvedV1,
    })),
    recent: recent.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      sentAt: r.sentAt,
      alertLabel: r.alertType && isWhatsAppAlertType(r.alertType) ? WHATSAPP_ALERT_LABELS[r.alertType] : (r.alertType ?? "—"),
      recipientName: r.user.name,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
    })),
    counts: { waiting, failed },
  };
}
