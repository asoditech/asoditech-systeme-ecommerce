import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Maintenance scripts run under `tsx` (a plain Node CLI): their server-only
 * app modules (`import "server-only"`) only load once `scripts/server-only-cli.ts`
 * has mapped that marker to Next's own server entry. Verified WITHOUT running
 * any script: a child process loads exactly the modules each script imports —
 * no `main()`, no query — with DATABASE_URL pointing at a closed local port and
 * every other variable removed, so no database can be reached.
 */

const ROOT = process.cwd();
const SCRIPTS = ["scripts/backfill-tenant-baseline.ts", "scripts/cleanup-variation-products.ts"];
const SHIM = "./server-only-cli";

const importsOf = (file: string) =>
  [...readFileSync(join(ROOT, file), "utf8").matchAll(/^import\s+(?:[^"']*\sfrom\s+)?["']([^"']+)["'];/gm)].map((m) => m[1]);

function loadInChild(modules: string[]) {
  const code = [...modules.map((m) => `require(${JSON.stringify(m)});`), 'console.log("IMPORT_OK");'].join("");
  return spawnSync(join(ROOT, "node_modules/.bin/tsx"), ["-e", code], {
    cwd: ROOT,
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: "postgresql://startup:probe@127.0.0.1:1/none" },
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe("maintenance scripts start under tsx", () => {
  it.each(SCRIPTS)("%s imports the server-only shim first", (file) => {
    expect(importsOf(file)[0]).toBe(SHIM);
  });

  it.each(SCRIPTS)("%s: every module it imports loads in a plain Node process (no query, no DB)", (file) => {
    const modules = importsOf(file).map((m) => (m === SHIM ? "./scripts/server-only-cli" : m));
    const run = loadInChild(modules);
    expect(run.stderr).not.toMatch(/Cannot find module|cannot be imported from a Client Component/);
    expect(run.stdout).toContain("IMPORT_OK");
    expect(run.status).toBe(0);
  }, 90_000);

  it("root cause: without the shim, the same modules fail on `server-only` before any script code runs", () => {
    const run = loadInChild(importsOf("scripts/backfill-tenant-baseline.ts").filter((m) => m !== SHIM));
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Cannot find module 'server-only'");
  }, 90_000);

  it("the shim maps only `server-only`, to Next's own server entry, and is not imported by the app", () => {
    const shim = readFileSync(join(ROOT, "scripts/server-only-cli.ts"), "utf8");
    expect(shim).toContain('request === "server-only" ? SERVER_ONLY_SERVER_ENTRY');
    expect(shim).toContain('require.resolve("next/dist/compiled/server-only/empty.js")');
    const run = spawnSync("grep", ["-rl", "server-only-cli", join(ROOT, "src")], { encoding: "utf8" });
    expect(run.stdout.trim()).toBe("");
  });
});
