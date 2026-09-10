import { vi } from "vitest";
import { createHash } from "node:crypto";

/**
 * In-memory fake for the Google OAuth 2.0 + Drive v3 REST APIs used by the
 * Backup Phase-2 module (src/lib/backup/google-drive.ts). No real network
 * call ever leaves the process — same approach as
 * tests/helpers/fake-reference-carrier.ts.
 *
 * Each fake Drive is a distinct "Google account" so tests can model both
 * "two tenants, two accounts" and "two tenants, ONE shared account".
 */

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  createdTime: string;
  bytes?: Buffer;
}

export interface FakeDriveState {
  /** files keyed by id */
  files: Map<string, DriveFile>;
  nextId: number;
  /** access token -> this account */
  accountEmail: string;
  /** refresh token that this account's connection holds */
  refreshToken: string;
  /** knobs */
  revokeRefreshToken: boolean; // refresh + exchange fail with invalid_grant
  failUpload: boolean;
  failDownload: boolean;
  /** upload responds with a deliberately wrong md5 */
  mismatchMd5: boolean;
  /** when set, a downloaded file's bytes are corrupted */
  corruptDownloadFileId?: string;
  /** resumable upload sessions: sessionId -> pending metadata */
  sessions: Map<string, { name: string; parents: string[]; appProperties: Record<string, string> }>;
  nextSession: number;
}

export function makeFakeDrive(email: string): FakeDriveState {
  return {
    files: new Map(),
    nextId: 1,
    accountEmail: email,
    refreshToken: `refresh-${email}`,
    revokeRefreshToken: false,
    failUpload: false,
    failDownload: false,
    mismatchMd5: false,
    sessions: new Map(),
    nextSession: 1,
  };
}

const OK = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Installs a fake global `fetch` that routes Google endpoints to the given
 * accounts. `accounts` maps an OAuth *access token prefix* to a fake Drive
 * — the module mints access tokens like `access-<email>-<n>`, so we route
 * by "startsWith". Anything not Google falls through to the real fetch
 * (there is none in these tests).
 */
export function installFakeGoogle(accounts: FakeDriveState[]) {
  const byRefresh = new Map(accounts.map((a) => [a.refreshToken, a]));
  const realFetch = globalThis.fetch;

  function driveForAccessToken(token: string | null): FakeDriveState | null {
    if (!token) return null;
    const email = token.replace(/^access-/, "").replace(/-\d+$/, "");
    return accounts.find((a) => a.accountEmail === email) ?? null;
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;

      // ---- OAuth token endpoint ----
      if (url === "https://oauth2.googleapis.com/token" && method === "POST") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const grant = params.get("grant_type");
        if (grant === "authorization_code") {
          // code is "code-for-<email>"
          const email = (params.get("code") ?? "").replace("code-for-", "");
          const acct = accounts.find((a) => a.accountEmail === email);
          if (!acct || acct.revokeRefreshToken) return OK({ error: "invalid_grant" }, 400);
          return OK({
            access_token: `access-${email}-1`,
            refresh_token: acct.refreshToken,
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/drive.file openid email",
          });
        }
        if (grant === "refresh_token") {
          const acct = byRefresh.get(params.get("refresh_token") ?? "");
          if (!acct || acct.revokeRefreshToken) return OK({ error: "invalid_grant" }, 400);
          return OK({ access_token: `access-${acct.accountEmail}-${Date.now()}`, expires_in: 3600 });
        }
        return OK({ error: "unsupported_grant_type" }, 400);
      }

      if (url === "https://oauth2.googleapis.com/revoke" && method === "POST") return OK({});

      if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
        const acct = driveForAccessToken(bearer);
        if (!acct) return OK({ error: "invalid_token" }, 401);
        return OK({ email: acct.accountEmail, sub: acct.accountEmail });
      }

      // ---- Drive: resumable upload session start ----
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files") && method === "POST") {
        const acct = driveForAccessToken(bearer);
        if (!acct) return OK({ error: "unauthorized" }, 401);
        if (acct.failUpload) return OK({ error: "backend error" }, 500);
        const meta = JSON.parse(String(init?.body ?? "{}")) as {
          name: string;
          parents?: string[];
          appProperties?: Record<string, string>;
        };
        const sid = `sess-${acct.nextSession++}`;
        acct.sessions.set(sid, { name: meta.name, parents: meta.parents ?? [], appProperties: meta.appProperties ?? {} });
        return new Response(null, {
          status: 200,
          headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${sid}` },
        });
      }

      // ---- Drive: resumable upload PUT ----
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files?upload_id=") && method === "PUT") {
        const sid = new URL(url).searchParams.get("upload_id")!;
        const acct = accounts.find((a) => a.sessions.has(sid));
        if (!acct) return OK({ error: "gone" }, 404);
        if (acct.failUpload) return OK({ error: "backend error" }, 500);
        const pending = acct.sessions.get(sid)!;
        acct.sessions.delete(sid);
        const raw = init?.body as Uint8Array | ArrayBuffer | string;
        const bytes =
          typeof raw === "string"
            ? Buffer.from(raw)
            : raw instanceof ArrayBuffer
              ? Buffer.from(new Uint8Array(raw))
              : Buffer.from(raw);
        const id = `file-${acct.accountEmail}-${acct.nextId++}`;
        acct.files.set(id, {
          id,
          name: pending.name,
          mimeType: "application/octet-stream",
          parents: pending.parents,
          appProperties: pending.appProperties,
          createdTime: new Date().toISOString(),
          bytes,
        });
        return OK({
          id,
          name: pending.name,
          size: String(bytes.length),
          createdTime: new Date().toISOString(),
          md5Checksum: acct.mismatchMd5 ? "0".repeat(32) : createHash("md5").update(bytes).digest("hex"),
        });
      }

      // ---- Drive: files list / create folder ----
      if (url.startsWith("https://www.googleapis.com/drive/v3/files") && !url.includes("alt=media")) {
        const acct = driveForAccessToken(bearer);
        if (!acct) return OK({ error: "unauthorized" }, 401);
        const u = new URL(url);

        // GET one file by id: .../files/<id>?fields=...
        const idMatch = u.pathname.match(/\/drive\/v3\/files\/([^/]+)$/);
        if (idMatch && method === "GET") {
          const f = acct.files.get(decodeURIComponent(idMatch[1]));
          if (!f) return OK({ error: "notFound" }, 404);
          return OK({
            id: f.id,
            name: f.name,
            size: f.bytes ? String(f.bytes.length) : undefined,
            createdTime: f.createdTime,
            md5Checksum: f.bytes ? createHash("md5").update(f.bytes).digest("hex") : undefined,
            parents: f.parents,
          });
        }
        if (idMatch && method === "DELETE") {
          acct.files.delete(decodeURIComponent(idMatch[1]));
          return new Response(null, { status: 204 });
        }

        if (method === "POST") {
          const meta = JSON.parse(String(init?.body ?? "{}")) as {
            name: string;
            mimeType: string;
            appProperties?: Record<string, string>;
            parents?: string[];
          };
          const id = `folder-${acct.accountEmail}-${acct.nextId++}`;
          acct.files.set(id, {
            id,
            name: meta.name,
            mimeType: meta.mimeType,
            parents: meta.parents ?? [],
            appProperties: meta.appProperties ?? {},
            createdTime: new Date().toISOString(),
          });
          return OK({ id, name: meta.name });
        }

        // list: q=... — a naive but faithful evaluator of the AND-only
        // queries this module builds.
        const q = u.searchParams.get("q") ?? "";
        let files = [...acct.files.values()];

        const mimeMatch = q.match(/mimeType='([^']+)'/);
        if (mimeMatch) files = files.filter((f) => f.mimeType === mimeMatch[1]);

        const nameMatch = q.match(/name='([^']+)'/);
        if (nameMatch) files = files.filter((f) => f.name === nameMatch[1].replace(/\\'/g, "'"));

        const parentMatch = q.match(/'([^']+)' in parents/);
        if (parentMatch) files = files.filter((f) => f.parents.includes(parentMatch[1]));

        // every `appProperties has { key='K' and value='V' }` clause
        for (const m of q.matchAll(/appProperties has \{ key='([^']+)' and value='([^']+)' \}/g)) {
          files = files.filter((f) => f.appProperties[m[1]] === m[2]);
        }
        return OK({
          files: files.map((f) => ({
            id: f.id,
            name: f.name,
            size: f.bytes ? String(f.bytes.length) : undefined,
            createdTime: f.createdTime,
            md5Checksum: f.bytes ? createHash("md5").update(f.bytes).digest("hex") : undefined,
          })),
        });
      }

      // ---- Drive: download media ----
      if (url.includes("alt=media")) {
        const acct = driveForAccessToken(bearer);
        if (!acct) return OK({ error: "unauthorized" }, 401);
        if (acct.failDownload) return OK({ error: "backend error" }, 500);
        const id = decodeURIComponent(url.match(/\/files\/([^?]+)\?/)?.[1] ?? "");
        const f = acct.files.get(id);
        if (!f?.bytes) return OK({ error: "notFound" }, 404);
        let out = f.bytes;
        if (acct.corruptDownloadFileId === id) {
          out = Buffer.from(f.bytes);
          out[out.length - 3] ^= 0xff; // break GCM auth
        }
        return new Response(new Uint8Array(out), { status: 200, headers: { "content-type": "application/octet-stream" } });
      }

      return realFetch(input as string, init);
    })
  );
}
