"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import { createExpenseSchema, updateExpenseSchema, createExpenseCategorySchema } from "@/lib/validation/finance";
import { actionError, actionOk, type ActionResult, type IdResult } from "@/actions/types";
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

export async function deleteExpenseAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("finance.manage");
  const id = formData.get("id");
  if (typeof id !== "string") return actionError("Dépense invalide.");

  const existing = await prisma.expense.findUnique({ where: { id } });
  if (!existing) return actionError("Dépense introuvable.");

  await prisma.expense.delete({ where: { id } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "expense.deleted",
    entityType: "Expense",
    entityId: id,
    previousValue: { amount: existing.amount.toString() },
  });

  revalidatePath("/finance");
  return actionOk(undefined);
}

export async function createExpenseCategoryAction(formData: FormData): Promise<ActionResult<ExpenseCategory>> {
  const user = await requirePermissionForAction("finance.manage");

  const parsed = createExpenseCategorySchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.expenseCategory.findUnique({ where: { name: parsed.data.name } });
  if (existing) return actionError("Cette catégorie existe déjà.");

  const category = await prisma.expenseCategory.create({ data: { name: parsed.data.name } });

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
