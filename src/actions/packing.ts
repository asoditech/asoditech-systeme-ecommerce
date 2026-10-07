"use server";

import { revalidatePath } from "next/cache";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { requirePermissionForAction } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { resolveExactCode } from "@/lib/catalog/exact-code";
import { productLineLabel } from "@/lib/catalog/product-chips";
import {
  isPackingComplete,
  PACKING_MESSAGES,
  packingCounts,
  packingKey,
  packingLines,
  scanVerdict,
  type PackingLine,
} from "@/lib/packing";
import { actionError, actionOk, type ActionResult } from "@/actions/types";

/**
 * Packing verification (« Emballage » = OrderStatus EN_PREPARATION). The scan
 * reuses the catalogue lookup (src/lib/catalog/lookup.ts) — but only an EXACT
 * barcode / SKU that resolves to ONE unit counts: no name, no partial match,
 * no parent SKU standing for several variations. Progress lives in the
 * browser; `validatePackingAction` re-checks everything from the raw codes.
 */

const NOT_PACKING_STAGE = "La commande doit être à l'étape « Emballage » pour vérifier son emballage.";

type Db = typeof prisma | PrismaTransactionClient;

async function loadPackingOrder(db: Db, orderId: string) {
  // Same access as the order page and the status actions: `orders.pack`
  // (permission) + the tenant-scoped client — no extra row filter.
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      packedAt: true,
      items: {
        select: {
          productId: true,
          variationId: true,
          nameSnapshot: true,
          skuSnapshot: true,
          quantity: true,
          variation: { select: { attributes: true } },
        },
      },
    },
  });
  if (!order) return null;
  const lines = packingLines(
    order.items.map((i) => ({ ...i, label: productLineLabel(i.nameSnapshot, i.variation?.attributes) }))
  );
  return { order, lines };
}

/** Exact code → one unit key (shared resolver), or the reason it can't be counted. */
async function resolvePackingCode(db: Db, code: string): Promise<{ ok: true; key: string } | { ok: false; error: string }> {
  const resolved = await resolveExactCode(db, code);
  return resolved.ok ? { ok: true, key: packingKey(resolved.unit) } : { ok: false, error: resolved.error };
}

/** Live feedback for one scan; the counts sent by the browser only shape the message. */
export async function checkPackingScanAction(input: {
  orderId: string;
  code: string;
  scannedKeys: string[];
  manualKeys?: string[];
}): Promise<ActionResult<{ key: string; label: string }>> {
  await requirePermissionForAction("orders.pack");
  const loaded = await loadPackingOrder(prisma, input.orderId);
  if (!loaded) return actionError("Commande introuvable.");
  if (loaded.order.status !== "EN_PREPARATION") return actionError(NOT_PACKING_STAGE);
  const resolved = await resolvePackingCode(prisma, input.code);
  if (!resolved.ok) return actionError(resolved.error);
  const verdict = scanVerdict(loaded.lines, packingCounts(loaded.lines, input.scannedKeys, input.manualKeys), resolved.key);
  if (!verdict.ok) return actionError(verdict.error);
  return actionOk({ key: verdict.key, label: loaded.lines.find((l) => l.key === verdict.key)!.label });
}

/**
 * Final validation: every code is resolved again, every line must be exactly
 * complete. Manual lines (no / damaged code) need `orders.pack_manual` and a
 * reason; they are recorded in the audit event and make the method MANUAL.
 */
export async function validatePackingAction(input: {
  orderId: string;
  codes: string[];
  manual?: { keys: string[]; reason: string };
}): Promise<ActionResult<{ id: string }>> {
  const user = await requirePermissionForAction("orders.pack");
  const manualKeys = [...new Set(input.manual?.keys ?? [])];
  const reason = input.manual?.reason?.trim() ?? "";
  if (manualKeys.length > 0) {
    if (!userHasPermission(user, "orders.pack_manual")) {
      return actionError("Non autorisé : la validation manuelle de l'emballage est réservée aux responsables.");
    }
    if (reason.length < 3) return actionError("Indiquez le motif de la validation manuelle.");
  }

  type Outcome =
    | { ok: false; error: string }
    | { ok: true; orderId: string; method: "SCAN" | "MANUAL"; lines: PackingLine[]; scannedKeys: string[] };
  // One transaction: the order, every code's resolution and the conditional
  // update see the same state; a concurrent validation matches 0 rows.
  const outcome: Outcome = await prisma.$transaction(async (tx) => {
    const loaded = await loadPackingOrder(tx, input.orderId);
    if (!loaded) return { ok: false, error: "Commande introuvable." };
    const { order, lines } = loaded;
    if (order.status !== "EN_PREPARATION") return { ok: false, error: NOT_PACKING_STAGE };
    if (order.packedAt) return { ok: false, error: "L'emballage de cette commande est déjà vérifié." };
    if (manualKeys.some((k) => !lines.some((l) => l.key === k))) return { ok: false, error: PACKING_MESSAGES.notInOrder };

    // Replay every scan exactly as the packer did — a wrong / extra / ambiguous
    // code fails the whole validation, it is never silently ignored.
    const scannedKeys: string[] = [];
    for (const code of input.codes) {
      const resolved = await resolvePackingCode(tx, code);
      if (!resolved.ok) return { ok: false, error: `« ${code} » : ${resolved.error}` };
      const verdict = scanVerdict(lines, packingCounts(lines, scannedKeys, manualKeys), resolved.key);
      if (!verdict.ok) return { ok: false, error: `« ${code} » : ${verdict.error}` };
      scannedKeys.push(verdict.key);
    }
    const counts = packingCounts(lines, scannedKeys, manualKeys);
    if (!isPackingComplete(lines, counts)) {
      const missing = lines.filter((l) => (counts[l.key] ?? 0) < l.required);
      return { ok: false, error: `Emballage incomplet : ${missing.map((l) => `${l.label} ${counts[l.key] ?? 0}/${l.required}`).join(", ")}.` };
    }

    const method = manualKeys.length > 0 ? ("MANUAL" as const) : ("SCAN" as const);
    const result = await tx.order.updateMany({
      where: { id: order.id, status: "EN_PREPARATION", packedAt: null },
      data: { packedAt: new Date(), packedById: user.id, packingMethod: method },
    });
    if (result.count === 0) return { ok: false, error: "Cette commande a été modifiée entre-temps. Rechargez la page." };
    return { ok: true, orderId: order.id, method, lines, scannedKeys };
  });
  if (!outcome.ok) return actionError(outcome.error);
  const { method, lines, scannedKeys } = outcome;
  const order = { id: outcome.orderId };

  const label = (k: string) => lines.find((l: PackingLine) => l.key === k)?.label ?? k;
  await recordAuditEvent({
    actorType: "USER",
    actorUserId: user.id,
    action: "order.packed",
    entityType: "Order",
    entityId: order.id,
    newValue: { packingMethod: method },
    metadata: {
      scannedUnits: scannedKeys.length,
      ...(manualKeys.length > 0 ? { manualLines: manualKeys.map(label), reason } : {}),
    },
  });

  revalidatePath(`/commandes/${order.id}`);
  revalidatePath("/commandes");
  revalidatePath("/livraison");
  return actionOk({ id: order.id });
}
