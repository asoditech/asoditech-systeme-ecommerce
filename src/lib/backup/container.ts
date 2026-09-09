import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { env } from "@/lib/env";
import {
  CONTAINER_HEADER_LENGTH,
  CONTAINER_IV_LENGTH,
  CONTAINER_MAGIC,
  CONTAINER_TAG_LENGTH,
  CONTAINER_VERSION,
  MAX_CONTAINER_BYTES,
} from "./constants";

/**
 * The sealed `.asb` container — authenticated encryption for a backup
 * package (docs/adr/0034-backup-and-portability.md).
 *
 * Layout (binary):
 *   [0..3]   magic "ASB1"
 *   [4]      container version (1)
 *   [5]      reserved (0)
 *   [6..17]  AES-GCM IV (12 bytes)
 *   [18..33] AES-GCM auth tag (16 bytes)
 *   [34..]   ciphertext = AES-256-GCM( gzip( utf8 JSON ) )
 *
 * The 6-byte header is the GCM AAD, so a tampered header fails
 * authentication. AES-256-GCM itself provides tamper detection on the
 * body; `sealBackup` additionally records a SHA-256 of the *plaintext*
 * gzip bytes for the manifest, giving a second, human-verifiable integrity
 * check on restore.
 *
 * Key: `BACKUP_ENCRYPTION_KEY` when set, else `INTEGRATION_ENCRYPTION_KEY`
 * (always present) — never hard-coded, never derived from a constant. See
 * the ADR's "Encryption / Key management".
 */

const ALGORITHM = "aes-256-gcm";

export class BackupContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupContainerError";
  }
}

/** Which key the module is using — surfaced in the manifest as `keyId` so a
 * future multi-key rotation can pick the right one on restore. */
export function backupKeyId(): "backup" | "integration" {
  return env.BACKUP_ENCRYPTION_KEY ? "backup" : "integration";
}

function getKey(): Buffer {
  const raw = env.BACKUP_ENCRYPTION_KEY ?? env.INTEGRATION_ENCRYPTION_KEY;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new BackupContainerError("La clé de chiffrement des sauvegardes est invalide (32 octets base64 attendus).");
  }
  return key;
}

function header(): Buffer {
  const buf = Buffer.alloc(CONTAINER_HEADER_LENGTH);
  CONTAINER_MAGIC.copy(buf, 0);
  buf.writeUInt8(CONTAINER_VERSION, 4);
  buf.writeUInt8(0, 5);
  return buf;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface SealedBackup {
  container: Buffer;
  /** SHA-256 (hex) of the gzipped plaintext — recorded in the manifest. */
  gzipSha256: string;
  sizeBytes: number;
}

/** Compress + encrypt a JSON string into a `.asb` container. */
export function sealBackup(json: string): SealedBackup {
  const gz = gzipSync(Buffer.from(json, "utf8"));
  const iv = randomBytes(CONTAINER_IV_LENGTH);
  const head = header();
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  cipher.setAAD(head);
  const ciphertext = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  const container = Buffer.concat([head, iv, tag, ciphertext]);
  if (container.length > MAX_CONTAINER_BYTES) {
    throw new BackupContainerError(
      "La sauvegarde dépasse la taille maximale autorisée pour une génération synchrone. " +
        "Contactez le support — la génération en arrière-plan pour les gros volumes arrive dans une phase ultérieure."
    );
  }
  return { container, gzipSha256: sha256Hex(gz), sizeBytes: container.length };
}

export interface OpenedBackup {
  json: string;
  gzipSha256: string;
}

/** Decrypt + decompress a `.asb` container. Throws `BackupContainerError`
 * for any framing / authentication / decompression failure — a tampered or
 * corrupted package never yields partial data. */
export function openBackup(container: Buffer): OpenedBackup {
  if (!Buffer.isBuffer(container) || container.length < CONTAINER_HEADER_LENGTH + CONTAINER_IV_LENGTH + CONTAINER_TAG_LENGTH) {
    throw new BackupContainerError("Fichier de sauvegarde illisible ou tronqué.");
  }
  const head = container.subarray(0, CONTAINER_HEADER_LENGTH);
  if (!head.subarray(0, 4).equals(CONTAINER_MAGIC)) {
    throw new BackupContainerError("Ce fichier n'est pas une sauvegarde ASODITECH (.asb).");
  }
  if (head.readUInt8(4) !== CONTAINER_VERSION) {
    throw new BackupContainerError(`Version de conteneur non prise en charge (${head.readUInt8(4)}).`);
  }
  const iv = container.subarray(CONTAINER_HEADER_LENGTH, CONTAINER_HEADER_LENGTH + CONTAINER_IV_LENGTH);
  const tagStart = CONTAINER_HEADER_LENGTH + CONTAINER_IV_LENGTH;
  const tag = container.subarray(tagStart, tagStart + CONTAINER_TAG_LENGTH);
  const ciphertext = container.subarray(tagStart + CONTAINER_TAG_LENGTH);

  let gz: Buffer;
  try {
    const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAAD(head);
    decipher.setAuthTag(tag);
    gz = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupContainerError(
      "Échec du déchiffrement : la sauvegarde a été altérée ou a été chiffrée avec une autre clé."
    );
  }

  let json: string;
  try {
    json = gunzipSync(gz).toString("utf8");
  } catch {
    throw new BackupContainerError("Échec de la décompression de la sauvegarde (fichier corrompu).");
  }
  return { json, gzipSha256: sha256Hex(gz) };
}
