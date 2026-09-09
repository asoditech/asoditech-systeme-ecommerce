import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma, type PrismaTransactionClient } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { openBackup, BackupContainerError } from "./container";
import { canonicalDataJson, sha256Hex, validateManifest, type BackupManifest } from "./manifest";
import { BACKUP_MODELS, patchForRestore, splitRowForInsert, type BackupModel } from "./models";
import { MAX_TOTAL_ROWS } from "./constants";

/**
 * Restore engine for the Backup & Portability module
 * (docs/adr/0034-backup-and-portability.md).
 *
 * Safety model:
 *  - `inspectBackup` decrypts + authenticates + verifies the business-data
 *    checksum + validates the manifest BEFORE anything is shown or touched.
 *  - The caller (src/actions/backup.ts) takes a `PRE_RESTORE_SNAPSHOT`
 *    of the tenant's current data first, and only then calls
 *    `restoreTenantBackup`.
 *  - `restoreTenantBackup` runs entirely inside ONE `runWithTenant`
 *    directive and ONE `$transaction`: the wipe + reinsert + FK patch +
 *    count check either all commit or all roll back. A cancelled restore
 *    changes nothing.
 *  - It NEVER deletes user accounts (lockout risk) and NEVER wipes the
 *    audit trail — those are merged / appended.
 *  - Cross-tenant / cross-deployment restore is refused in Phase 1:
 *    `manifest.tenant.id` must equal the active tenant.
 */

type RestoreRow = Record<string, unknown>;

export interface InspectedBackup {
  manifest: BackupManifest;
  data: Record<string, RestoreRow[]>;
  /** True only when the package is structurally valid, the version is
   * supported, and the recomputed data checksum matches. */
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Per-model counts actually present in the package `data`. */
  counts: Record<string, number>;
  totalRows: number;
}

export class BackupInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupInspectionError";
  }
}

export class CrossTenantRestoreError extends Error {
  constructor(backupTenantId: string, activeTenantId: string) {
    super(
      `Cette sauvegarde appartient au tenant « ${backupTenantId} » et ne peut pas être restaurée ` +
        `dans le tenant « ${activeTenantId} ». La portabilité entre tenants/déploiements arrive dans une phase ultérieure.`
    );
    this.name = "CrossTenantRestoreError";
  }
}

/** Decrypt, authenticate and validate an uploaded `.asb` package. Throws
 * `BackupInspectionError` only for a package that cannot be parsed at all;
 * a package that decrypts but fails validation comes back `valid: false`
 * with `errors` populated. */
export function inspectBackup(container: Buffer): InspectedBackup {
  let json: string;
  try {
    json = openBackup(container).json;
  } catch (err) {
    if (err instanceof BackupContainerError) throw new BackupInspectionError(err.message);
    throw new BackupInspectionError("Fichier de sauvegarde illisible.");
  }

  let parsed: { manifest?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(json) as typeof parsed;
  } catch {
    throw new BackupInspectionError("Contenu de sauvegarde corrompu (JSON invalide).");
  }

  const manifestCheck = validateManifest(parsed.manifest);
  const errors = [...manifestCheck.errors];
  const warnings: string[] = [];

  const manifest = parsed.manifest as BackupManifest;
  const rawData = (parsed.data ?? {}) as Record<string, RestoreRow[]>;
  const data: Record<string, RestoreRow[]> = {};
  const counts: Record<string, number> = {};
  let totalRows = 0;
  for (const m of BACKUP_MODELS) {
    const rows = Array.isArray(rawData[m.key]) ? rawData[m.key] : [];
    data[m.key] = rows;
    counts[m.key] = rows.length;
    totalRows += rows.length;
    const declared = manifest?.counts?.[m.key];
    if (typeof declared === "number" && declared !== rows.length) {
      warnings.push(`Compteur « ${m.key} » : manifeste ${declared}, contenu ${rows.length}.`);
    }
  }

  // Integrity — recompute the business-data checksum over the package's
  // `data` map exactly as stored (not the normalized copy above).
  if (manifestCheck.ok) {
    const recomputed = sha256Hex(canonicalDataJson(rawData as Record<string, unknown[]>));
    if (recomputed !== manifest.checksum.data) {
      errors.push("Contrôle d'intégrité échoué : le contenu ne correspond pas à l'empreinte du manifeste (fichier altéré).");
    }
  }

  if (totalRows > MAX_TOTAL_ROWS) {
    errors.push(`Sauvegarde trop volumineuse pour une restauration synchrone (${totalRows} > ${MAX_TOTAL_ROWS}).`);
  }

  return {
    manifest,
    data,
    valid: errors.length === 0,
    errors,
    warnings,
    counts,
    totalRows,
  };
}

const REPLACE_MODELS: BackupModel[] = BACKUP_MODELS.filter((m) => m.strategy === "replace");

type AnyDelegate = {
  deleteMany: (args?: unknown) => Promise<{ count: number }>;
  createMany: (args: { data: RestoreRow[] }) => Promise<{ count: number }>;
  count: (args?: unknown) => Promise<number>;
  findMany: (args?: unknown) => Promise<RestoreRow[]>;
  update: (args: { where: { id: string }; data: RestoreRow }) => Promise<unknown>;
  create: (args: { data: RestoreRow }) => Promise<unknown>;
};

function delegateOf(tx: PrismaTransactionClient, accessor: string): AnyDelegate {
  return (tx as unknown as Record<string, AnyDelegate>)[accessor];
}

export interface RestoreResult {
  restoredCounts: Record<string, number>;
  usersCreatedDisabled: number;
  usersUpdated: number;
  auditEventsAppended: number;
}

/**
 * Wipe-and-reinsert the tenant's business data from an already-inspected,
 * valid package. MUST be called with `inspected.valid === true`.
 */
export async function restoreTenantBackup(params: {
  activeTenantId: string;
  inspected: InspectedBackup;
}): Promise<RestoreResult> {
  const { activeTenantId, inspected } = params;
  if (!inspected.valid) {
    throw new BackupInspectionError("Refus de restaurer une sauvegarde invalide.");
  }
  if (inspected.manifest.tenant.id !== activeTenantId) {
    throw new CrossTenantRestoreError(inspected.manifest.tenant.id, activeTenantId);
  }

  const data = inspected.data;
  const mergeStats = { usersCreatedDisabled: 0, usersUpdated: 0, auditAppended: 0 };

  return runWithTenant(activeTenantId, "backup:restore", () =>
    prisma.$transaction(
      async (tx) => {
        // 1 — wipe every "replace" model, child-first.
        for (const m of [...REPLACE_MODELS].reverse()) {
          await delegateOf(tx, m.accessor).deleteMany({});
        }

        const deferredWork: { model: BackupModel; rows: { id: string; patch: RestoreRow }[] }[] = [];

        // 2 — insert, dependency order.
        for (const m of BACKUP_MODELS) {
          const rows = data[m.key] ?? [];
          if (m.strategy === "mergeUser") {
            const r = await mergeUsers(tx, rows);
            mergeStats.usersCreatedDisabled += r.created;
            mergeStats.usersUpdated += r.updated;
            continue;
          }
          if (m.strategy === "upsertSettings") {
            await upsertSettings(tx, rows);
            continue;
          }
          if (m.strategy === "appendAudit") {
            mergeStats.auditAppended += await appendAudit(tx, rows);
            continue;
          }

          // strategy: "replace"
          const toInsert: RestoreRow[] = [];
          const deferredRows: { id: string; patch: RestoreRow }[] = [];
          for (const raw of rows) {
            const patched = patchForRestore(m.model, raw);
            const { insert, deferred } = splitRowForInsert(patched, m.deferredFks);
            toInsert.push(insert);
            if (Object.keys(deferred).length > 0 && typeof insert.id === "string") {
              deferredRows.push({ id: insert.id, patch: deferred });
            }
          }
          if (toInsert.length > 0) {
            await delegateOf(tx, m.accessor).createMany({ data: toInsert });
          }
          if (deferredRows.length > 0) {
            deferredWork.push({ model: m, rows: deferredRows });
          }
        }

        // 3 — patch deferred (self / forward) FKs.
        for (const { model, rows } of deferredWork) {
          const delegate = delegateOf(tx, model.accessor);
          for (const { id, patch } of rows) {
            await delegate.update({ where: { id }, data: patch });
          }
        }

        // 4 — verify every replaced model's row count matches the package.
        const restoredCounts: Record<string, number> = {};
        for (const m of REPLACE_MODELS) {
          const expected = (data[m.key] ?? []).length;
          const actual = await delegateOf(tx, m.accessor).count({});
          restoredCounts[m.key] = actual;
          if (actual !== expected) {
            throw new Error(
              `Vérification post-restauration échouée pour « ${m.key} » : ${actual} enregistrement(s) au lieu de ${expected}. Restauration annulée.`
            );
          }
        }

        return {
          restoredCounts,
          usersCreatedDisabled: mergeStats.usersCreatedDisabled,
          usersUpdated: mergeStats.usersUpdated,
          auditEventsAppended: mergeStats.auditAppended,
        };
      },
      { maxWait: 15_000, timeout: 120_000 }
    )
  );
}

// --- merge strategies ---------------------------------------------------

async function mergeUsers(
  tx: PrismaTransactionClient,
  rows: RestoreRow[]
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  const emails = rows.map((r) => String(r.email)).filter(Boolean);
  const existing = await tx.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  const byEmail = new Map(existing.map((u) => [u.email, u.id]));

  for (const raw of rows) {
    const email = String(raw.email ?? "").trim();
    if (!email) continue;
    const role = raw.role as Prisma.UserCreateInput["role"];
    const status = raw.status as Prisma.UserCreateInput["status"];
    const name = String(raw.name ?? email);
    const hit = byEmail.get(email);
    if (hit) {
      // Existing account: refresh only safe business fields. Never touch
      // passwordHash or isPlatformAdmin.
      await tx.user.update({ where: { id: hit }, data: { name, role, status } });
      updated++;
    } else {
      // New account from the backup — created LOGIN-DISABLED with an empty
      // password hash (bcrypt.compare(x, "") is always false). An OWNER
      // must re-invite / reset it. See the ADR's "User & role policy".
      await tx.user.create({
        data: {
          id: typeof raw.id === "string" ? raw.id : undefined,
          email,
          name,
          role,
          status: "DISABLED",
          passwordHash: "",
        },
      });
      created++;
    }
  }
  return { created, updated };
}

async function upsertSettings(tx: PrismaTransactionClient, rows: RestoreRow[]): Promise<void> {
  const row = rows[0];
  if (!row) return;
  const patched = patchForRestore("BusinessSettings", row);
  const { insert } = splitRowForInsert(patched, undefined);
  delete insert.id;
  delete insert.tenantId;
  // The tenant extension scopes this upsert to the active tenant; the
  // BusinessSettings row is unique per tenantId.
  const current = await tx.businessSettings.findFirst({ select: { id: true } });
  if (current) {
    await tx.businessSettings.update({ where: { id: current.id }, data: insert as Prisma.BusinessSettingsUpdateInput });
  } else {
    await tx.businessSettings.create({ data: insert as unknown as Prisma.BusinessSettingsCreateInput });
  }
}

async function appendAudit(tx: PrismaTransactionClient, rows: RestoreRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => String(r.id)).filter(Boolean);
  const existing = await tx.auditEvent.findMany({ where: { id: { in: ids } }, select: { id: true } });
  const known = new Set(existing.map((e) => e.id));
  const fresh: RestoreRow[] = [];
  for (const raw of rows) {
    if (typeof raw.id !== "string" || known.has(raw.id)) continue;
    const { insert } = splitRowForInsert({ ...raw, tenantId: undefined }, undefined);
    fresh.push(insert);
  }
  if (fresh.length === 0) return 0;
  const res = await (tx as unknown as Record<string, AnyDelegate>).auditEvent.createMany({ data: fresh });
  return res.count;
}
