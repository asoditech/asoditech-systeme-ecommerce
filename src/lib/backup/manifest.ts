import "server-only";

import { readdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import pkg from "../../../package.json";
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  EXCLUDED_MODELS,
  SANITIZED_FIELDS,
  SUPPORTED_BACKUP_FORMAT_VERSIONS,
} from "./constants";

/** The app version, from package.json at build time. */
export const APP_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";

/** Latest applied DB migration folder name — best-effort, for diagnostics
 * and a future cross-deployment compatibility check. Falls back to the
 * backup format's own version tag when the folder can't be read. */
export const SCHEMA_VERSION: string = (() => {
  try {
    const dir = path.join(process.cwd(), "prisma", "migrations");
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    return entries.at(-1) ?? `format-v${BACKUP_FORMAT_VERSION}`;
  } catch {
    return `format-v${BACKUP_FORMAT_VERSION}`;
  }
})();

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  schemaVersion: string;
  createdAt: string;
  createdByUserId: string | null;
  tenant: { id: string; slug: string; name: string };
  counts: Record<string, number>;
  totalRows: number;
  /** `data` = sha256 of the canonical JSON of the `data` map. The container
   * (AES-256-GCM) additionally authenticates the whole package on decrypt;
   * this is the second, independently-recomputable business-data check the
   * restore engine verifies before touching anything. */
  checksum: { algo: "sha256"; data: string };
  encryption: { algo: "AES-256-GCM"; keyId: "backup" | "integration" };
  /** Documentation, echoed into the file so an auditor sees exactly what a
   * package does and does not carry. Never contains a secret VALUE. */
  policy: {
    sanitizedFields: Record<string, readonly string[]>;
    excludedModels: Record<string, string>;
    /** IDs are preserved verbatim; only `tenantId` is (re)assigned on
     * restore. Cross-deployment restore is a Phase-1 non-goal. */
    idStrategy: "preserve-ids; reassign-tenantId-only";
  };
}

/** Deterministic serialization of the `data` map — the thing the manifest
 * checksum covers. Keys sorted so re-serializing yields an identical string. */
export function canonicalDataJson(data: Record<string, unknown[]>): string {
  const sortedKeys = Object.keys(data).sort();
  const ordered: Record<string, unknown[]> = {};
  for (const k of sortedKeys) ordered[k] = data[k];
  return JSON.stringify(ordered);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildManifest(args: {
  tenant: { id: string; slug: string; name: string };
  createdByUserId: string | null;
  counts: Record<string, number>;
  /** sha256 hex of `canonicalDataJson(data)`. */
  dataChecksum: string;
  keyId: "backup" | "integration";
}): BackupManifest {
  const counts = args.counts;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    createdByUserId: args.createdByUserId,
    tenant: args.tenant,
    counts,
    totalRows: Object.values(counts).reduce((a, b) => a + b, 0),
    checksum: { algo: "sha256", data: args.dataChecksum },
    encryption: { algo: "AES-256-GCM", keyId: args.keyId },
    policy: {
      sanitizedFields: SANITIZED_FIELDS,
      excludedModels: EXCLUDED_MODELS,
      idStrategy: "preserve-ids; reassign-tenantId-only",
    },
  };
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/** Structural + version validation of a manifest parsed from an uploaded
 * package. Integrity (checksum) is checked separately by the restore
 * engine once it has the `data`. */
export function validateManifest(value: unknown): ManifestValidation {
  const errors: string[] = [];
  const m = value as Partial<BackupManifest> | null;
  if (!m || typeof m !== "object") {
    return { ok: false, errors: ["Manifeste absent ou illisible."] };
  }
  if (m.format !== BACKUP_FORMAT) {
    errors.push(`Format inattendu : « ${String(m.format)} » (attendu « ${BACKUP_FORMAT} »).`);
  }
  if (typeof m.version !== "number" || !SUPPORTED_BACKUP_FORMAT_VERSIONS.includes(m.version)) {
    errors.push(
      `Version de sauvegarde non prise en charge : ${String(m.version)} ` +
        `(prises en charge : ${SUPPORTED_BACKUP_FORMAT_VERSIONS.join(", ")}).`
    );
  }
  if (!m.tenant || typeof m.tenant.id !== "string") {
    errors.push("Identifiant de tenant manquant dans le manifeste.");
  }
  if (!m.checksum || m.checksum.algo !== "sha256" || typeof m.checksum.data !== "string") {
    errors.push("Informations d'intégrité manquantes ou invalides.");
  }
  if (!m.counts || typeof m.counts !== "object") {
    errors.push("Compteurs d'enregistrements manquants.");
  }
  return { ok: errors.length === 0, errors };
}
