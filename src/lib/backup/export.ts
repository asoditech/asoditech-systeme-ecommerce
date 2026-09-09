import "server-only";

import { prisma } from "@/lib/prisma";
import { runWithTenant } from "@/lib/tenant/context";
import { BACKUP_MODELS, sanitizeForExport } from "./models";
import { MAX_TOTAL_ROWS } from "./constants";
import { backupKeyId, sealBackup } from "./container";
import { buildManifest, canonicalDataJson, sha256Hex, type BackupManifest } from "./manifest";

/**
 * Build an encrypted `.asb` package for ONE tenant
 * (docs/adr/0034-backup-and-portability.md).
 *
 * Every read goes through the tenant-scoped `prisma` client inside a
 * `runWithTenant` directive — the Phase 2 extension AND the Phase 4 RLS
 * policy both constrain every query to `tenantId`, so this can only ever
 * see the caller's own rows. There is no cross-tenant code path here.
 *
 * Phase 1 is synchronous and holds the dataset in memory; `MAX_TOTAL_ROWS`
 * keeps that safe for a normal tenant. `BACKUP_MODELS` is already shaped
 * for a future per-model cursor/stream rewrite — the container format
 * would not change.
 */

export class BackupTooLargeError extends Error {
  constructor(public readonly totalRows: number) {
    super(
      `Ce tenant compte ${totalRows} enregistrements, au-delà de la limite de génération synchrone (${MAX_TOTAL_ROWS}). ` +
        `La sauvegarde des gros volumes en arrière-plan arrive dans une phase ultérieure.`
    );
    this.name = "BackupTooLargeError";
  }
}

export interface TenantBackup {
  container: Buffer;
  manifest: BackupManifest;
  counts: Record<string, number>;
  sizeBytes: number;
}

type AnyDelegate = { findMany: (args?: unknown) => Promise<Record<string, unknown>[]> };

export async function buildTenantBackup(params: {
  tenantId: string;
  createdByUserId: string | null;
}): Promise<TenantBackup> {
  return runWithTenant(params.tenantId, "backup:export", async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: params.tenantId },
      select: { id: true, slug: true, name: true },
    });

    const data: Record<string, Record<string, unknown>[]> = {};
    const counts: Record<string, number> = {};
    let total = 0;

    for (const m of BACKUP_MODELS) {
      const delegate = (prisma as unknown as Record<string, AnyDelegate>)[m.accessor];
      const rows = await delegate.findMany({ orderBy: { id: "asc" } });
      const sanitized = rows.map((r) => sanitizeForExport(m.model, r));
      data[m.key] = sanitized;
      counts[m.key] = sanitized.length;
      total += sanitized.length;
      if (total > MAX_TOTAL_ROWS) throw new BackupTooLargeError(total);
    }

    // JSON.stringify serializes Prisma Decimal → string and Date → ISO
    // string via their own toJSON(); the restore engine reads those back
    // directly on insert. `canonicalDataJson` sorts keys so the manifest
    // checksum is reproducible.
    const dataJson = canonicalDataJson(data);

    const manifest = buildManifest({
      tenant,
      createdByUserId: params.createdByUserId,
      counts,
      dataChecksum: sha256Hex(dataJson),
      keyId: backupKeyId(),
    });

    const sealed = sealBackup(JSON.stringify({ manifest, data }));

    return { container: sealed.container, manifest, counts, sizeBytes: sealed.sizeBytes };
  });
}
