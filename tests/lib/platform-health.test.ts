import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prismaBase } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import {
  classifyDbError,
  deploymentInfo,
  evaluateMigrations,
  HealthCheckTimeoutError,
  supabaseLinks,
  supabaseProjectRef,
  vercelLinks,
  withTimeout,
} from "@/lib/platform/health-signals";
import { runPlatformHealthChecks } from "@/lib/queries/platform-health";
import { resetDb } from "../helpers/db";
import { loginAsTestUser } from "../helpers/auth";
import { mockCookieStore } from "../mocks/cookie-store";
import { RedirectSignal } from "../setup";

/**
 * /platform/sante — what the health panel reports and, as importantly, what
 * it refuses to claim: unverified checks are "unknown", errors are
 * categories (never raw messages / connection details), links are only built
 * from verified identifiers.
 */

const REF = "abcdefghijklmnopqrst"; // 20 lowercase alphanumerics, Supabase project-ref shape

describe("classifyDbError — sanitized categories by error code", () => {
  it("maps Prisma connection codes", () => {
    expect(classifyDbError({ errorCode: "P1000", message: "auth failed for postgres.x:secret@host" })).toBe("auth");
    expect(classifyDbError({ errorCode: "P1001" })).toBe("unreachable");
    expect(classifyDbError({ errorCode: "P1017" })).toBe("unreachable");
    expect(classifyDbError({ errorCode: "P1002" })).toBe("timeout");
    expect(classifyDbError({ errorCode: "P1003" })).toBe("missing-database");
    expect(classifyDbError({ code: "P2024" })).toBe("pool");
  });

  it("recognises a permission failure and our own timeout; anything else is unknown", () => {
    expect(classifyDbError({ code: "P2010", meta: { code: "42501" } })).toBe("permission");
    expect(classifyDbError(new HealthCheckTimeoutError(5000))).toBe("timeout");
    expect(classifyDbError(new Error("boom"))).toBe("unknown");
    expect(classifyDbError(null)).toBe("unknown");
  });
});

describe("withTimeout", () => {
  it("resolves fast work and rejects hung work with HealthCheckTimeoutError", async () => {
    await expect(withTimeout(Promise.resolve(1), 50)).resolves.toBe(1);
    await expect(withTimeout(new Promise(() => {}), 20)).rejects.toBeInstanceOf(HealthCheckTimeoutError);
  });
});

describe("supabaseProjectRef — only from the configured URL, never guessed", () => {
  it("pooler URL: the ref is the suffix of the user name", () => {
    expect(supabaseProjectRef(`postgresql://postgres.${REF}:p%40ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true`)).toBe(REF);
    expect(supabaseProjectRef(`postgresql://asoditech_app.${REF}:x@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`)).toBe(REF);
  });

  it("direct URL: the ref is in the host", () => {
    expect(supabaseProjectRef(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`)).toBe(REF);
  });

  it("local, other providers, malformed or non-ref values give null", () => {
    expect(supabaseProjectRef("postgresql://asoditech_app:x@localhost:5432/asoditech_ecommerce")).toBeNull();
    expect(supabaseProjectRef("postgresql://u.someref:x@ep-1.neon.tech/db")).toBeNull();
    expect(supabaseProjectRef("postgresql://postgres.SHORT:x@aws-0-eu-central-1.pooler.supabase.com/postgres")).toBeNull();
    expect(supabaseProjectRef("not a url")).toBeNull();
    expect(supabaseProjectRef(undefined)).toBeNull();
  });
});

describe("dashboard links", () => {
  it("Supabase links are https dashboard URLs for the ref — no credential", () => {
    const links = supabaseLinks(REF);
    expect(links.map((l) => l.href)).toEqual([
      `https://supabase.com/dashboard/project/${REF}`,
      `https://supabase.com/dashboard/project/${REF}/logs/explorer`,
    ]);
  });

  it("Vercel links point at this project's deployments and runtime logs", () => {
    expect(vercelLinks().map((l) => l.href)).toEqual([
      "https://vercel.com/asoditech/asoditech-systeme-ecommerce/deployments",
      "https://vercel.com/asoditech/asoditech-systeme-ecommerce/logs",
    ]);
  });
});

describe("deploymentInfo", () => {
  it("reads Vercel system variables and reports absent ones as null", () => {
    expect(
      deploymentInfo({ VERCEL_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_123", VERCEL_GIT_COMMIT_SHA: "0123456789abcdef", VERCEL_REGION: "fra1", VERCEL_URL: "x.vercel.app" })
    ).toEqual({ environment: "production", deploymentId: "dpl_123", commit: "0123456", region: "fra1", url: "x.vercel.app" });
    expect(deploymentInfo({ NODE_ENV: "development", VERCEL_GIT_COMMIT_SHA: "" })).toEqual({
      environment: "development",
      deploymentId: null,
      commit: null,
      region: null,
      url: null,
    });
  });
});

describe("evaluateMigrations", () => {
  const at = new Date("2026-10-01T00:00:00Z");
  const row = (name: string, finished = true) => ({ name, finishedAt: finished ? at : null, rolledBackAt: null });

  it("ok when every shipped migration is applied", () => {
    const r = evaluateMigrations([row("a"), row("b")], ["a", "b"]);
    expect(r.state).toBe("ok");
    expect(r.pending).toEqual([]);
    expect(r.lastApplied?.name).toBe("b");
  });

  it("warning with the list of pending migrations", () => {
    const r = evaluateMigrations([row("a")], ["a", "b", "c"]);
    expect(r.state).toBe("warning");
    expect(r.pending).toEqual(["b", "c"]);
  });

  it("error when a migration started but never finished", () => {
    const r = evaluateMigrations([row("a"), row("b", false)], ["a", "b"]);
    expect(r.state).toBe("error");
    expect(r.unfinished).toEqual(["b"]);
  });

  it("unknown (never green) when the deployment's own list is unreadable", () => {
    const r = evaluateMigrations([row("a")], null);
    expect(r.state).toBe("unknown");
    expect(r.pending).toBeNull();
  });
});

describe("runPlatformHealthChecks (local test database)", () => {
  beforeEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });
  afterEach(async () => {
    await resetDb();
    mockCookieStore.clear();
  });

  it("reports a reachable database, migrations matching this checkout, no Supabase link for a local DB — and writes nothing", async () => {
    const before = await Promise.all([prismaBase.auditEvent.count(), prismaBase.integration.count(), prismaBase.syncRun.count()]);
    const report = await runPlatformHealthChecks();
    const byKey = Object.fromEntries(report.checks.map((c) => [c.key, c]));

    expect(byKey.app.state).toBe("ok");
    expect(byKey.database.state).toBe("ok");
    expect(byKey.migrations.state).toBe("ok");
    expect(report.migrations?.pending).toEqual([]);
    expect(byKey.integrations.state).toBe("unknown"); // nothing configured → nothing claimed
    expect(report.links.supabase).toBeNull();
    expect(await Promise.all([prismaBase.auditEvent.count(), prismaBase.integration.count(), prismaBase.syncRun.count()])).toEqual(before);
  });

  it("never exposes connection details in the report", async () => {
    const report = JSON.stringify(await runPlatformHealthChecks());
    const url = new URL(process.env.DATABASE_URL!);
    expect(report).not.toContain(process.env.DATABASE_URL!);
    if (url.password) expect(report).not.toContain(decodeURIComponent(url.password));
    expect(report).not.toContain(`${url.hostname}:${url.port}`);
    expect(report).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("is a platform-admin page: a tenant OWNER is refused", async () => {
    await loginAsTestUser({ role: "OWNER", isPlatformAdmin: false });
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(RedirectSignal);
  });
});
