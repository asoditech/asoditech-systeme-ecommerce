import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { MAX_CONTAINER_BYTES, CONTAINER_MAGIC } from "./constants";

/**
 * Thin, dependency-free client for the Google OAuth 2.0 + Drive v3 REST
 * APIs — Backup Phase 2 (docs/adr/0034 §"Phase 2 — Google Drive").
 *
 * All hosts are hard-coded Google endpoints (no user input in any URL), so
 * there is no SSRF surface. Scope is the least-privilege
 * `drive.file` — the app can only ever see files it created — plus
 * `openid email` so we can show which account is connected.
 *
 * NOTHING here logs a token, a code, or a Google error body. Callers get
 * typed errors with safe messages.
 */

export const GOOGLE_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "openid",
  "email",
].join(" ");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const REQUEST_TIMEOUT_MS = 30_000;

export class GoogleDriveConfigError extends Error {
  constructor(message = "Google Drive n'est pas configuré sur ce déploiement.") {
    super(message);
    this.name = "GoogleDriveConfigError";
  }
}

/** The user must (re)authorize — token revoked, expired past refresh, or
 * consent withdrawn. The UI shows a "reconnect" call to action. */
export class GoogleDriveAuthError extends Error {
  constructor(message = "La connexion Google Drive a expiré ou a été révoquée. Reconnectez-vous.") {
    super(message);
    this.name = "GoogleDriveAuthError";
  }
}

/** A transient / unexpected Drive API failure (network, 5xx, quota). */
export class GoogleDriveApiError extends Error {
  constructor(message = "Google Drive a renvoyé une erreur. Réessayez plus tard.") {
    super(message);
    this.name = "GoogleDriveApiError";
  }
}

// Read at call time (not via the frozen `env` object) so a deployment can
// set these without a rebuild — and so tests can stub them. They are
// optional, unvalidated strings; `env.ts` documents them.
function oauthClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID ?? env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export function isGoogleDriveConfigured(): boolean {
  return oauthClient() !== null;
}

function requireConfig(): { clientId: string; clientSecret: string } {
  const c = oauthClient();
  if (!c) throw new GoogleDriveConfigError();
  return c;
}

export function googleOAuthRedirectUri(): string {
  return `${env.APP_URL.replace(/\/$/, "")}/parametres/sauvegarde/google/callback`;
}

// --- PKCE -------------------------------------------------------------------

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(params: { state: string; codeChallenge: string }): string {
  const { clientId } = requireConfig();
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", googleOAuthRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_DRIVE_SCOPES);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // always return a refresh_token
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

// --- token lifecycle ------------------------------------------------------

export interface TokenBundle {
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string; // ISO
  scope: string;
}

async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    throw new GoogleDriveApiError("Google Drive est injoignable pour le moment.");
  } finally {
    clearTimeout(timer);
  }
}

function expiryFromNow(expiresInSec: number): string {
  return new Date(Date.now() + Math.max(0, (expiresInSec - 60)) * 1000).toISOString();
}

export async function exchangeCodeForTokens(params: { code: string; codeVerifier: string }): Promise<TokenBundle> {
  const { clientId, clientSecret } = requireConfig();
  const res = await googleFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      code_verifier: params.codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleOAuthRedirectUri(),
    }),
  });
  if (!res.ok) {
    // 400/401 here = bad/expired code or PKCE mismatch — a fresh consent is needed.
    throw new GoogleDriveAuthError("Échec de l'autorisation Google. Relancez la connexion.");
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token || !json.refresh_token) {
    throw new GoogleDriveAuthError("Google n'a pas renvoyé de jeton de rafraîchissement. Révoquez l'accès de l'application dans votre compte Google, puis reconnectez-vous.");
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    accessTokenExpiresAt: expiryFromNow(json.expires_in ?? 3600),
    scope: json.scope ?? GOOGLE_DRIVE_SCOPES,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
  const { clientId, clientSecret } = requireConfig();
  const res = await googleFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (res.status === 400 || res.status === 401) {
    // invalid_grant — refresh token revoked / expired.
    throw new GoogleDriveAuthError();
  }
  if (!res.ok) throw new GoogleDriveApiError();
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new GoogleDriveAuthError();
  return { accessToken: json.access_token, accessTokenExpiresAt: expiryFromNow(json.expires_in ?? 3600) };
}

export async function revokeToken(token: string): Promise<void> {
  // Best-effort — a revoke failure must not block a disconnect.
  try {
    await googleFetch(REVOKE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    /* ignore */
  }
}

export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await googleFetch(USERINFO_ENDPOINT, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return null;
    const json = (await res.json()) as { email?: string };
    return json.email ?? null;
  } catch {
    return null;
  }
}

// --- Drive: folder / upload / list / download / delete -------------------

const FOLDER_MIME = "application/vnd.google-apps.folder";
const BACKUP_MIME = "application/octet-stream";
/** Marks our folders/files so a re-auth or a shared account can still find them. */
const APP_TAG = "asoditech-backup";

async function driveJson<T>(accessToken: string, url: string, init?: RequestInit): Promise<T> {
  const res = await googleFetch(url, {
    ...init,
    headers: { authorization: `Bearer ${accessToken}`, ...(init?.headers ?? {}) },
  });
  if (res.status === 401) throw new GoogleDriveAuthError();
  if (res.status === 403 || res.status === 429) {
    throw new GoogleDriveApiError("Google Drive a refusé la requête (autorisation ou quota atteint). Réessayez plus tard.");
  }
  if (!res.ok && res.status !== 204) throw new GoogleDriveApiError();
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

async function findOrCreateFolder(params: {
  accessToken: string;
  name: string;
  parentId: string | null;
  appProperties: Record<string, string>;
}): Promise<{ id: string; name: string }> {
  const qParts = [
    `mimeType='${FOLDER_MIME}'`,
    "trashed=false",
    `name='${params.name.replace(/'/g, "\\'")}'`,
  ];
  if (params.parentId) qParts.push(`'${params.parentId}' in parents`);
  for (const [k, v] of Object.entries(params.appProperties)) {
    qParts.push(`appProperties has { key='${k}' and value='${v}' }`);
  }
  const found = await driveJson<{ files?: { id: string; name: string }[] }>(
    params.accessToken,
    `${DRIVE_FILES}?q=${encodeURIComponent(qParts.join(" and "))}&fields=files(id,name)&spaces=drive`
  );
  if (found.files && found.files.length > 0) return { id: found.files[0].id, name: found.files[0].name };

  const created = await driveJson<{ id: string; name: string }>(params.accessToken, DRIVE_FILES, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: params.name,
      mimeType: FOLDER_MIME,
      ...(params.parentId ? { parents: [params.parentId] } : {}),
      appProperties: { tag: APP_TAG, ...params.appProperties },
    }),
  });
  return { id: created.id, name: created.name };
}

/**
 * Find (or create) this tenant's dedicated backup folder, nested as
 * `ASODITECH Backups / <tenant-slug>`. Idempotent, and resilient to the
 * folder having been deleted in Drive (it is simply re-created). The child
 * folder carries `appProperties.tenantId`, so two tenants on the same
 * Google account never share a folder even if the slugs collide.
 */
export async function ensureBackupFolder(params: {
  accessToken: string;
  tenantId: string;
  tenantSlug: string;
}): Promise<{ id: string; name: string; path: string }> {
  const root = await findOrCreateFolder({
    accessToken: params.accessToken,
    name: "ASODITECH Backups",
    parentId: null,
    appProperties: { root: "1" },
  });
  const child = await findOrCreateFolder({
    accessToken: params.accessToken,
    name: params.tenantSlug || "tenant",
    parentId: root.id,
    appProperties: { tenantId: params.tenantId },
  });
  return { id: child.id, name: child.name, path: `ASODITECH Backups/${child.name}` };
}

export interface DriveFile {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  md5Checksum: string | null;
}

/** List the `.asb` backups in this tenant's folder, newest first. */
export async function listFolderBackups(params: { accessToken: string; folderId: string }): Promise<DriveFile[]> {
  const q = [`'${params.folderId}' in parents`, "trashed=false", `mimeType='${BACKUP_MIME}'`].join(" and ");
  const json = await driveJson<{ files?: { id: string; name: string; size?: string; createdTime?: string; md5Checksum?: string }[] }>(
    params.accessToken,
    `${DRIVE_FILES}?q=${encodeURIComponent(q)}&fields=files(id,name,size,createdTime,md5Checksum)&orderBy=createdTime desc&pageSize=100&spaces=drive`
  );
  return (json.files ?? []).map((f) => ({
    id: f.id,
    name: f.name,
    sizeBytes: Number(f.size ?? 0),
    createdAt: f.createdTime ?? new Date().toISOString(),
    md5Checksum: f.md5Checksum ?? null,
  }));
}

export async function getFileMeta(params: { accessToken: string; fileId: string }): Promise<DriveFile & { parents: string[] }> {
  const f = await driveJson<{ id: string; name: string; size?: string; createdTime?: string; md5Checksum?: string; parents?: string[] }>(
    params.accessToken,
    `${DRIVE_FILES}/${encodeURIComponent(params.fileId)}?fields=id,name,size,createdTime,md5Checksum,parents&supportsAllDrives=false`
  );
  return {
    id: f.id,
    name: f.name,
    sizeBytes: Number(f.size ?? 0),
    createdAt: f.createdTime ?? new Date().toISOString(),
    md5Checksum: f.md5Checksum ?? null,
    parents: f.parents ?? [],
  };
}

/** Resumable upload of an already-built `.asb` container. Returns the
 * created file's metadata (incl. Drive's own md5 of the received bytes). */
export async function uploadBackup(params: {
  accessToken: string;
  folderId: string;
  filename: string;
  bytes: Buffer;
}): Promise<DriveFile> {
  if (params.bytes.length > MAX_CONTAINER_BYTES) {
    throw new GoogleDriveApiError("La sauvegarde dépasse la taille maximale autorisée pour Google Drive.");
  }
  // 1 — start a resumable session.
  const start = await googleFetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id,name,size,createdTime,md5Checksum`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.accessToken}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": BACKUP_MIME,
      "x-upload-content-length": String(params.bytes.length),
    },
    body: JSON.stringify({
      name: params.filename,
      parents: [params.folderId],
      mimeType: BACKUP_MIME,
      appProperties: { tag: APP_TAG },
    }),
  });
  if (start.status === 401) throw new GoogleDriveAuthError();
  if (!start.ok) throw new GoogleDriveApiError("Google Drive a refusé le démarrage de l'envoi.");
  const sessionUrl = start.headers.get("location");
  if (!sessionUrl) throw new GoogleDriveApiError("Google Drive n'a pas fourni d'URL d'envoi.");

  // 2 — PUT the bytes in one shot.
  const put = await googleFetch(sessionUrl, {
    method: "PUT",
    headers: { "content-type": BACKUP_MIME, "content-length": String(params.bytes.length) },
    body: new Uint8Array(params.bytes),
  });
  if (put.status === 401) throw new GoogleDriveAuthError();
  if (!put.ok) throw new GoogleDriveApiError("L'envoi vers Google Drive a échoué.");
  const f = (await put.json()) as { id?: string; name?: string; size?: string; createdTime?: string; md5Checksum?: string };
  if (!f.id) throw new GoogleDriveApiError("Google Drive n'a pas confirmé l'envoi.");
  return {
    id: f.id,
    name: f.name ?? params.filename,
    sizeBytes: Number(f.size ?? params.bytes.length),
    createdAt: f.createdTime ?? new Date().toISOString(),
    md5Checksum: f.md5Checksum ?? null,
  };
}

/** Download a file's bytes, with a hard size cap enforced BEFORE and DURING
 * the read, and a magic-bytes check so a non-`.asb` Drive file is rejected
 * before any Phase-1 parsing. */
export async function downloadFileBytes(params: {
  accessToken: string;
  fileId: string;
  declaredSize: number;
}): Promise<Buffer> {
  if (params.declaredSize > MAX_CONTAINER_BYTES) {
    throw new GoogleDriveApiError("Ce fichier dépasse la taille maximale autorisée pour une sauvegarde.");
  }
  const res = await googleFetch(`${DRIVE_FILES}/${encodeURIComponent(params.fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });
  if (res.status === 401) throw new GoogleDriveAuthError();
  if (res.status === 404) throw new GoogleDriveApiError("Fichier introuvable sur Google Drive.");
  if (!res.ok || !res.body) throw new GoogleDriveApiError("Le téléchargement depuis Google Drive a échoué.");

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CONTAINER_BYTES) {
      await reader.cancel().catch(() => {});
      throw new GoogleDriveApiError("Le fichier téléchargé dépasse la taille maximale autorisée.");
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  if (buf.length < 6 || !buf.subarray(0, 4).equals(CONTAINER_MAGIC)) {
    throw new GoogleDriveApiError("Ce fichier Google Drive n'est pas une sauvegarde ASODITECH (.asb).");
  }
  return buf;
}

export async function deleteFile(params: { accessToken: string; fileId: string }): Promise<void> {
  const res = await googleFetch(`${DRIVE_FILES}/${encodeURIComponent(params.fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${params.accessToken}` },
  });
  if (res.status === 401) throw new GoogleDriveAuthError();
  if (res.status === 404) return; // already gone — fine
  if (!res.ok && res.status !== 204) throw new GoogleDriveApiError("La suppression sur Google Drive a échoué.");
}

export function md5Hex(bytes: Buffer): string {
  return createHash("md5").update(bytes).digest("hex");
}
