"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { reconcileOrderCommission, monthBounds } from "@/lib/commissions";
import {
  upsertCommissionAgentSchema,
  updateCommissionAgentSchema,
  assignOrderAgentSchema,
  closeCommissionStatementSchema,
  markStatementPaidSchema,
} from "@/lib/validation/commission";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

class EmptyPeriodError extends Error {}

/** Make a user a confirmation agent (or reactivate one) with a rate. */
export async function createCommissionAgentAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("commissions.manage");

  const parsed = upsertCommissionAgentSchema.safeParse({
    userId: formData.get("userId"),
    ratePerOrder: formData.get("ratePerOrder"),
  });
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true, name: true } });
  if (!user) return actionError("Utilisateur introuvable.");

  let agent;
  try {
    agent = await prisma.commissionAgent.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ratePerOrder: parsed.data.ratePerOrder },
      update: { ratePerOrder: parsed.data.ratePerOrder, isActive: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return actionError("Cet utilisateur est déjà un agent de confirmation.");
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "commission.agent_created",
    entityType: "CommissionAgent",
    entityId: agent.id,
    newValue: { userId: user.id, ratePerOrder: parsed.data.ratePerOrder },
  });

  revalidatePath("/commissions");
  return actionOk({ id: agent.id });
}

/** Change an agent's rate (future earnings only — past entries keep their snapshot) or (de)activate. */
export async function updateCommissionAgentAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("commissions.manage");

  const parsed = updateCommissionAgentSchema.safeParse({
    agentId: formData.get("agentId"),
    ratePerOrder: formData.get("ratePerOrder"),
    isActive: formData.get("isActive"),
  });
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const existing = await prisma.commissionAgent.findUnique({ where: { id: parsed.data.agentId } });
  if (!existing) return actionError("Agent introuvable.");

  const agent = await prisma.commissionAgent.update({
    where: { id: existing.id },
    data: { ratePerOrder: parsed.data.ratePerOrder, isActive: parsed.data.isActive },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "commission.agent_updated",
    entityType: "CommissionAgent",
    entityId: agent.id,
    previousValue: { ratePerOrder: Number(existing.ratePerOrder), isActive: existing.isActive },
    newValue: { ratePerOrder: parsed.data.ratePerOrder, isActive: parsed.data.isActive },
  });

  revalidatePath("/commissions");
  return actionOk({ id: agent.id });
}

/** Assign / clear the confirmation agent on an order, then reconcile its ledger. */
export async function assignOrderConfirmationAgentAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("commissions.manage");

  const parsed = assignOrderAgentSchema.safeParse({
    orderId: formData.get("orderId"),
    agentId: formData.get("agentId"),
  });
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, select: { id: true, confirmationAgentId: true } });
  if (!order) return actionError("Commande introuvable.");

  const nextAgentId = normalizeOptional(parsed.data.agentId);
  if (nextAgentId) {
    const agent = await prisma.commissionAgent.findUnique({ where: { id: nextAgentId } });
    if (!agent) return actionError("Agent introuvable.");
  }

  // Once a commission has been earned/reversed for an order, its agent is
  // locked — re-pointing it would strand the ledger entry on a different
  // agent than the order shows.
  const hasEntry = await prisma.commissionEntry.count({ where: { orderId: order.id } });
  if (hasEntry > 0 && nextAgentId !== order.confirmationAgentId) {
    return actionError("Une commission a déjà été calculée pour cette commande — l'agent ne peut plus être changé.");
  }

  await prisma.order.update({ where: { id: order.id }, data: { confirmationAgentId: nextAgentId } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "commission.order_assigned",
    entityType: "Order",
    entityId: order.id,
    previousValue: { confirmationAgentId: order.confirmationAgentId },
    newValue: { confirmationAgentId: nextAgentId },
  });

  await reconcileOrderCommission(order.id, actor.id);

  revalidatePath(`/commandes/${order.id}`);
  revalidatePath("/commissions");
  return actionOk({ id: order.id });
}

/**
 * Close a calendar month for one agent: sweep every not-yet-settled entry
 * dated in that month into a frozen CommissionStatement. Idempotent by the
 * `@@unique([agentId, periodYear, periodMonth])` constraint.
 */
export async function closeCommissionStatementAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("commissions.manage");

  const parsed = closeCommissionStatementSchema.safeParse({
    agentId: formData.get("agentId"),
    periodYear: formData.get("periodYear"),
    periodMonth: formData.get("periodMonth"),
  });
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  const { agentId, periodYear, periodMonth } = parsed.data;

  const now = new Date();
  const { start, end } = monthBounds(periodYear, periodMonth);
  if (start > now) return actionError("Impossible de clôturer un mois qui n'a pas commencé.");

  const agent = await prisma.commissionAgent.findUnique({ where: { id: agentId } });
  if (!agent) return actionError("Agent introuvable.");

  let statementId: string;
  try {
    statementId = await prisma.$transaction(async (tx) => {
      const entries = await tx.commissionEntry.findMany({
        where: { agentId, statementId: null, createdAt: { gte: start, lt: end } },
      });
      if (entries.length === 0) {
        throw new EmptyPeriodError();
      }
      const earned = entries.filter((e) => e.type === "EARNED");
      const reversed = entries.filter((e) => e.type === "REVERSED");
      const earnedAmount = earned.reduce((s, e) => s.plus(e.amount), new Prisma.Decimal(0));
      const reversedAmount = reversed.reduce((s, e) => s.plus(e.amount), new Prisma.Decimal(0));
      const netAmount = earnedAmount.plus(reversedAmount);

      const statement = await tx.commissionStatement.create({
        data: {
          agentId,
          periodYear,
          periodMonth,
          status: "CLOTURE",
          earnedCount: earned.length,
          reversedCount: reversed.length,
          earnedAmount,
          reversedAmount,
          netAmount,
          currency: agent.currency,
          closedById: actor.id,
        },
      });
      await tx.commissionEntry.updateMany({
        where: { id: { in: entries.map((e) => e.id) } },
        data: { statementId: statement.id },
      });
      return statement.id;
    });
  } catch (error) {
    if (error instanceof EmptyPeriodError) return actionError("Aucune commission à clôturer pour cette période.");
    if (isUniqueConstraintError(error)) return actionError("Ce mois est déjà clôturé pour cet agent.");
    throw error;
  }

  const statement = await prisma.commissionStatement.findUniqueOrThrow({ where: { id: statementId } });
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "commission.statement_closed",
    entityType: "CommissionStatement",
    entityId: statementId,
    newValue: {
      agentId,
      period: `${periodYear}-${String(periodMonth).padStart(2, "0")}`,
      netAmount: Number(statement.netAmount),
      earnedCount: statement.earnedCount,
    },
  });

  revalidatePath("/commissions");
  return actionOk({ id: statementId });
}

/** Record a payment against a closed statement. */
export async function markCommissionStatementPaidAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const actor = await requirePermissionForAction("commissions.manage");

  const parsed = markStatementPaidSchema.safeParse({
    statementId: formData.get("statementId"),
    paidAmount: formData.get("paidAmount") || undefined,
    note: formData.get("note"),
  });
  if (!parsed.success) return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);

  const statement = await prisma.commissionStatement.findUnique({ where: { id: parsed.data.statementId } });
  if (!statement) return actionError("Relevé introuvable.");
  if (statement.status === "PAYE") return actionError("Ce relevé est déjà marqué payé.");

  const paidAmount = parsed.data.paidAmount ?? Number(statement.netAmount);

  const updated = await prisma.commissionStatement.update({
    where: { id: statement.id },
    data: {
      status: "PAYE",
      paidAmount,
      paidAt: new Date(),
      paidById: actor.id,
      note: normalizeOptional(parsed.data.note) ?? statement.note,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: actor.id,
    action: "commission.statement_paid",
    entityType: "CommissionStatement",
    entityId: statement.id,
    previousValue: { status: statement.status },
    newValue: { status: "PAYE", paidAmount: Number(updated.paidAmount) },
  });

  revalidatePath("/commissions");
  return actionOk({ id: statement.id });
}
