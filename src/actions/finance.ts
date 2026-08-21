"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { createExpenseSchema, updateExpenseSchema, createExpenseCategorySchema } from "@/lib/validation/finance";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import type { ExpenseCategory } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createExpenseAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("finance.manage");

  const parsed = createExpenseSchema.safeParse({
    categoryId: formData.get("categoryId"),
    amount: formData.get("amount"),
    currency: formData.get("currency") || "MAD",
    date: formData.get("date"),
    description: formData.get("description"),
    vendor: formData.get("vendor"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const category = await prisma.expenseCategory.findUnique({ where: { id: parsed.data.categoryId } });
  if (!category) return actionError("Catégorie de dépense introuvable.");

  const expense = await prisma.expense.create({
    data: {
      categoryId: parsed.data.categoryId,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      date: parsed.data.date,
      description: normalizeOptional(parsed.data.description),
      vendor: normalizeOptional(parsed.data.vendor),
      recordedById: user.id,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "expense.created",
    entityType: "Expense",
    entityId: expense.id,
    newValue: { amount: expense.amount.toString() },
  });

  revalidatePath("/finance");
  return actionOk({ id: expense.id });
}

export async function updateExpenseAction(formData: FormData): Promise<ActionResult<IdResult>> {
  const user = await requirePermissionForAction("finance.manage");

  const parsed = updateExpenseSchema.safeParse({
    id: formData.get("id"),
    categoryId: formData.get("categoryId"),
    amount: formData.get("amount"),
    currency: formData.get("currency") || "MAD",
    date: formData.get("date"),
    description: formData.get("description"),
    vendor: formData.get("vendor"),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.expense.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return actionError("Dépense introuvable.");

  if (parsed.data.categoryId !== existing.categoryId) {
    const category = await prisma.expenseCategory.findUnique({ where: { id: parsed.data.categoryId } });
    if (!category) return actionError("Catégorie de dépense introuvable.");
  }

  const expense = await prisma.expense.update({
    where: { id: parsed.data.id },
    data: {
      categoryId: parsed.data.categoryId,
      amount: parsed.data.amount,
      currency: parsed.data.currency,
      date: parsed.data.date,
      description: normalizeOptional(parsed.data.description),
      vendor: normalizeOptional(parsed.data.vendor),
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "expense.updated",
    entityType: "Expense",
    entityId: expense.id,
    previousValue: { amount: existing.amount.toString() },
    newValue: { amount: expense.amount.toString() },
  });

  revalidatePath("/finance");
  return actionOk({ id: expense.id });
}

// Deliberately no deleteExpenseAction: hard-deleting a recorded expense
// would silently rewrite historical Finance figures for whatever period it
// fell in, with no trace of what changed or why — the same "financial data
// must remain historical/permanent" principle audit_log and Refund/Payment
// records follow. This capability was unused (no UI ever called it) and
// was removed during the A–G audit rather than kept as dead, dangerous
// surface — see docs/adr/0007-finance-and-profit.md. If a correction is
// needed, use updateExpenseAction, or add an offsetting expense with a
// note explaining the correction.

export async function createExpenseCategoryAction(formData: FormData): Promise<ActionResult<ExpenseCategory>> {
  const user = await requirePermissionForAction("finance.manage");

  const parsed = createExpenseCategorySchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.expenseCategory.findUnique({ where: { name: parsed.data.name } });
  if (existing) return actionError("Cette catégorie existe déjà.");

  let category;
  try {
    category = await prisma.expenseCategory.create({ data: { name: parsed.data.name } });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return actionError("Cette catégorie existe déjà.");
    }
    throw error;
  }

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "expense.created",
    entityType: "ExpenseCategory",
    entityId: category.id,
    newValue: { name: category.name },
  });

  revalidatePath("/finance");
  return actionOk(category);
}
