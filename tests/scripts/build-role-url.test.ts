import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * scripts/build-role-url.py — builds the restricted runtime role's
 * DATABASE_URL for scripts/r3-provision-and-verify.zsh (docs/adr/0053, R3).
 * Run exactly as the helper runs it (env in, one URL out), then checked with
 * two independent parsers: Node's WHATWG URL and Python's urllib.
 *
 * Regression: a template that was not parsed as a URL (quoted, KEY= prefix,
 * leading space) used to produce "//asoditech_app:<pw>@None/…" — no scheme,
 * no project ref — which libpq then read as a database NAME.
 */

const SCRIPT = path.resolve(import.meta.dirname, "../../scripts/build-role-url.py");

// Every reserved / URL-sensitive character the encoding must neutralise.
const NASTY_PASSWORD = "p@ss:w/rd?x#y%z&a=b+c d[e]f!$'(*),;~é";
const TEMPLATE =
  "postgresql://postgres.projectref:OLD-secret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1";

function run(env: Record<string, string>, args: string[] = []) {
  const result = spawnSync("python3", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr };
}

function build(template: string, password: string, args: string[] = []) {
  const r = run({ TEMPLATE_URL: template, APP_ROLE: "asoditech_app", APP_PW: password }, args);
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return r.stdout;
}

/** Second, independent parser: Python's urllib, decoding the userinfo. */
function parseWithPython(url: string) {
  const r = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, os",
        "from urllib.parse import urlsplit, unquote",
        "u = urlsplit(os.environ['U'])",
        "print(json.dumps({'scheme': u.scheme, 'user': unquote(u.username), 'password': unquote(u.password),",
        "  'host': u.hostname, 'port': u.port, 'path': u.path, 'query': u.query}))",
      ].join("\n"),
    ],
    { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", U: url }, encoding: "utf8" }
  );
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

describe("scripts/build-role-url.py", () => {
  it("encodes a password full of reserved characters so it round-trips exactly (Node URL + Python urllib)", () => {
    const url = build(TEMPLATE, NASTY_PASSWORD);

    expect(url.startsWith("postgresql://asoditech_app.projectref:")).toBe(true);
    expect(url).not.toContain(NASTY_PASSWORD);
    expect(url).not.toContain("OLD-secret");

    const u = new URL(url);
    expect(u.protocol).toBe("postgresql:");
    expect(decodeURIComponent(u.username)).toBe("asoditech_app.projectref");
    expect(decodeURIComponent(u.password)).toBe(NASTY_PASSWORD);
    expect(u.hostname).toBe("aws-0-eu-central-1.pooler.supabase.com");
    expect(u.port).toBe("6543");
    expect(u.pathname).toBe("/postgres");
    expect(u.searchParams.get("pgbouncer")).toBe("true");
    expect(u.searchParams.get("connection_limit")).toBe("1");

    expect(parseWithPython(url)).toEqual({
      scheme: "postgresql",
      user: "asoditech_app.projectref",
      password: NASTY_PASSWORD,
      host: "aws-0-eu-central-1.pooler.supabase.com",
      port: 6543,
      path: "/postgres",
      query: "pgbouncer=true&connection_limit=1",
    });
  });

  it("--no-query drops only the query (for psql), credentials and target unchanged", () => {
    const url = build(TEMPLATE, NASTY_PASSWORD, ["--no-query"]);
    const u = new URL(url);
    expect(u.search).toBe("");
    expect(url).not.toContain("?");
    expect(decodeURIComponent(u.password)).toBe(NASTY_PASSWORD);
    expect(decodeURIComponent(u.username)).toBe("asoditech_app.projectref");
    expect(u.host).toBe("aws-0-eu-central-1.pooler.supabase.com:6543");
    expect(u.pathname).toBe("/postgres");
  });

  it("a hex password (what the helper generates) is passed through unchanged", () => {
    const hex = "79eab0c2cef76e669ed67d10537cde0d4184bce240610cf19949ee3abe09dac7";
    const url = build(TEMPLATE, hex, ["--no-query"]);
    expect(url).toBe(`postgresql://asoditech_app.projectref:${hex}@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`);
  });

  it("accepts the template as copied from an env file / dashboard (regression: '//asoditech_app:…@None')", () => {
    const expected = build(TEMPLATE, NASTY_PASSWORD);
    for (const shape of [
      `"${TEMPLATE}"`,
      `'${TEMPLATE}'`,
      `DATABASE_URL="${TEMPLATE}"`,
      `DATABASE_URL=${TEMPLATE}`,
      `  ${TEMPLATE}\n`,
    ]) {
      expect(build(shape, NASTY_PASSWORD)).toBe(expected);
    }
  });

  it("keeps postgres:// and a non-Supabase user (no project ref → just the role)", () => {
    const url = build("postgres://owner:pw@db.example.com:5432/app_db?sslmode=require", NASTY_PASSWORD);
    const u = new URL(url);
    expect(u.protocol).toBe("postgres:");
    expect(decodeURIComponent(u.username)).toBe("asoditech_app");
    expect(decodeURIComponent(u.password)).toBe(NASTY_PASSWORD);
    expect(u.host).toBe("db.example.com:5432");
    expect(u.pathname).toBe("/app_db");
    expect(u.searchParams.get("sslmode")).toBe("require");
  });

  it("refuses an unusable template and never echoes a URL or a secret", () => {
    for (const bad of [
      "",
      "not a url",
      "//postgres.projectref:OLD-secret@host:6543/postgres",
      "mysql://postgres.projectref:OLD-secret@host:3306/db",
      "postgresql:///postgres",
      "postgresql://postgres.projectref:OLD-secret@host:notaport/postgres",
      "postgresql://host:6543/postgres",
    ]) {
      const r = run({ TEMPLATE_URL: bad, APP_ROLE: "asoditech_app", APP_PW: NASTY_PASSWORD });
      expect(r.status, bad).toBe(2);
      expect(r.stdout, bad).toBe("");
      expect(r.stderr, bad).toMatch(/^build-role-url: /);
      expect(r.stderr).not.toContain(NASTY_PASSWORD);
      expect(r.stderr).not.toContain("OLD-secret");
      expect(r.stderr).not.toContain("://");
    }
  });

  it("refuses an empty role or password", () => {
    expect(run({ TEMPLATE_URL: TEMPLATE, APP_ROLE: "", APP_PW: "x" }).status).toBe(2);
    expect(run({ TEMPLATE_URL: TEMPLATE, APP_ROLE: "asoditech_app", APP_PW: "" }).status).toBe(2);
  });
});
