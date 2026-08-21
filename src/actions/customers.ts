"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { recordAuditEvent } from "@/lib/audit";
import {
  createCustomerSchema,
  updateCustomerSchema,
  createCustomerAddressSchema,
} from "@/lib/validation/customer";
import { actionError, actionOk, type ActionResult } from "@/actions/types";
import type { Customer, CustomerAddress } from "@prisma/client";

function normalizeOptional(value: string | null | undefined): string | null {
  return value && value.trim().length > 0 ? value.trim() : null;
}

export async function createCustomerAction(formData: FormData): Promise<ActionResult<Customer>> {
  const user = await requirePermissionForAction("customers.create");

  const parsed = createCustomerSchema.safeParse({
    fullName: formData.get("fullName"),
    phone: formData.get("phone"),
    whatsapp: formData.get("whatsapp"),
    email: formData.get("email"),
    city: formData.get("city"),
    region: formData.get("region"),
    country: formData.get("country") || "Maroc",
    notes: formData.get("notes"),
    tags: formData.getAll("tags").map(String).filter(Boolean),
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const customer = await prisma.customer.create({
    data: {
      fullName: parsed.data.fullName,
      phone: normalizeOptional(parsed.data.phone),
      whatsapp: normalizeOptional(parsed.data.whatsapp),
      email: normalizeOptional(parsed.data.email),
      city: normalizeOptional(parsed.data.city),
      region: normalizeOptional(parsed.data.region),
      country: parsed.data.country,
      notes: normalizeOptional(parsed.data.notes),
      tags: parsed.data.tags,
      createdById: user.id,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "customer.created",
    entityType: "Customer",
    entityId: customer.id,
    newValue: { fullName: customer.fullName },
  });

  revalidatePath("/clients");
  return actionOk(customer);
}

export async function updateCustomerAction(formData: FormData): Promise<ActionResult<Customer>> {
  const user = await requirePermissionForAction("customers.edit");

  const parsed = updateCustomerSchema.safeParse({
    id: formData.get("id"),
    fullName: formData.get("fullName"),
    phone: formData.get("phone"),
    whatsapp: formData.get("whatsapp"),
    email: formData.get("email"),
    city: formData.get("city"),
    region: formData.get("region"),
    country: formData.get("country") || "Maroc",
    notes: formData.get("notes"),
    tags: formData.getAll("tags").map(String).filter(Boolean),
    segment: formData.get("segment") || null,
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.customer.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return actionError("Client introuvable.");
  }

  const customer = await prisma.customer.update({
    where: { id: parsed.data.id },
    data: {
      fullName: parsed.data.fullName,
      phone: normalizeOptional(parsed.data.phone),
      whatsapp: normalizeOptional(parsed.data.whatsapp),
      email: normalizeOptional(parsed.data.email),
      city: normalizeOptional(parsed.data.city),
      region: normalizeOptional(parsed.data.region),
      country: parsed.data.country,
      notes: normalizeOptional(parsed.data.notes),
      tags: parsed.data.tags,
      segment: parsed.data.segment ?? null,
    },
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "customer.updated",
    entityType: "Customer",
    entityId: customer.id,
    previousValue: { fullName: existing.fullName, segment: existing.segment },
    newValue: { fullName: customer.fullName, segment: customer.segment },
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${customer.id}`);
  return actionOk(customer);
}

export async function createCustomerAddressAction(
  formData: FormData
): Promise<ActionResult<CustomerAddress>> {
  const user = await requirePermissionForAction("customers.edit");

  const parsed = createCustomerAddressSchema.safeParse({
    customerId: formData.get("customerId"),
    label: formData.get("label"),
    addressLine1: formData.get("addressLine1"),
    addressLine2: formData.get("addressLine2"),
    city: formData.get("city"),
    region: formData.get("region"),
    country: formData.get("country") || "Maroc",
    phone: formData.get("phone"),
    isDefault: formData.get("isDefault") === "on",
  });
  if (!parsed.success) {
    return actionError("Champs invalides.", parsed.error.flatten().fieldErrors);
  }

  const customer = await prisma.customer.findUnique({ where: { id: parsed.data.customerId } });
  if (!customer) {
    return actionError("Client introuvable.");
  }

  // Unsetting the previous default and creating the new address must
  // commit together — a crash between the two would otherwise leave the
  // customer with zero default addresses. Found during the A–G audit.
  const address = await prisma.$transaction(async (tx) => {
    if (parsed.data.isDefault) {
      await tx.customerAddress.updateMany({
        where: { customerId: parsed.data.customerId },
        data: { isDefault: false },
      });
    }

    return tx.customerAddress.create({
      data: {
        customerId: parsed.data.customerId,
        label: normalizeOptional(parsed.data.label),
        addressLine1: parsed.data.addressLine1,
        addressLine2: normalizeOptional(parsed.data.addressLine2),
        city: parsed.data.city,
        region: normalizeOptional(parsed.data.region),
        country: parsed.data.country,
        phone: normalizeOptional(parsed.data.phone),
        isDefault: parsed.data.isDefault,
      },
    });
  });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "customer.address.created",
    entityType: "CustomerAddress",
    entityId: address.id,
    metadata: { customerId: parsed.data.customerId },
  });

  revalidatePath(`/clients/${parsed.data.customerId}`);
  return actionOk(address);
}

export async function deleteCustomerAddressAction(formData: FormData): Promise<ActionResult<undefined>> {
  const user = await requirePermissionForAction("customers.edit");
  const id = formData.get("id");
  const customerId = formData.get("customerId");
  if (typeof id !== "string" || typeof customerId !== "string") {
    return actionError("Adresse invalide.");
  }

  // Verify the address actually belongs to the customer the caller claims
  // it does, rather than trusting the two client-supplied IDs independently
  // — otherwise a crafted request (or a stale second tab) could delete an
  // address belonging to a different customer. Found during the A–G audit;
  // see docs/adr/0003-auth-and-rbac.md.
  const address = await prisma.customerAddress.findUnique({ where: { id } });
  if (!address || address.customerId !== customerId) {
    return actionError("Adresse introuvable pour ce client.");
  }

  await prisma.customerAddress.delete({ where: { id } });

  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "customer.address.deleted",
    entityType: "CustomerAddress",
    entityId: id,
    metadata: { customerId },
  });

  revalidatePath(`/clients/${customerId}`);
  return actionOk(undefined);
}
