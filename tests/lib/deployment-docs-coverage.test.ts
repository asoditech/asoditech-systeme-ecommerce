import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The deployment-documentation equivalent of tests/lib/docs-coverage.test.ts
 * (see docs/CONTRIBUTING.md): a new environment variable must not be able to
 * ship silently undocumented. src/lib/env.ts is the real, single source of
 * truth for every variable this app's Zod schema validates — this test
 * statically parses its declared keys (never imports the module itself,
 * which would trigger real validation against process.env and require a
 * live .env.test entry for every future key) and fails by name if a key is
 * missing from either docs/CLIENT-ENVIRONMENT-VARIABLES.md or
 * .env.production.example.
 *
 * A handful of runtime-config variables are read directly from
 * `process.env`/`import.meta.env` rather than through src/lib/env.ts's Zod
 * schema (DIRECT_URL — prisma.config.ts; SHOPIFY_INTEGRATION_ENABLED — a
 * feature flag read at call time; SEED_OWNER_EMAIL/SEED_OWNER_PASSWORD —
 * prisma/seed.ts). These are hand-maintained in KNOWN_NON_SCHEMA_VARS below
 * specifically because they can't be discovered by parsing env.ts — if you
 * add another one, add it here too, in the same PR that documents it.
 *
 * See docs/CLIENT-DEPLOYMENT-RUNBOOK.md's final section ("Keeping this
 * runbook current") for the maintenance contract this test enforces.
 */

const ENV_TS_PATH = "src/lib/env.ts";
const ENV_EXAMPLE_PATH = ".env.production.example";
const ENV_DOCS_PATH = "docs/CLIENT-ENVIRONMENT-VARIABLES.md";

// Variables read directly from process.env at a call site other than
// src/lib/env.ts's schema — not discoverable by static-parsing env.ts.
const KNOWN_NON_SCHEMA_VARS = [
  "DIRECT_URL", // prisma.config.ts
  "SHOPIFY_INTEGRATION_ENABLED", // src/lib/integrations/shopify/feature-flag.ts
  "SEED_OWNER_EMAIL", // prisma/seed.ts
  "SEED_OWNER_PASSWORD", // prisma/seed.ts
];

function extractSchemaKeys(envTsSource: string): string[] {
  // Matches top-level `  VAR_NAME: z` lines inside envSchema's object
  // literal — every real key is declared exactly this way (see env.ts).
  // Deliberately `z\b`, not `z\.` — a multi-line declaration (e.g.
  // `INTEGRATION_ENCRYPTION_KEY: z` with `.string()` starting the next
  // line) has nothing after the bare `z` on the same line.
  const matches = envTsSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s*z\b/gm);
  return [...matches].map((m) => m[1]);
}

describe("Deployment documentation coverage (CI guardrail)", () => {
  const envTsSource = readFileSync(ENV_TS_PATH, "utf8");
  const envExampleSource = readFileSync(ENV_EXAMPLE_PATH, "utf8");
  const envDocsSource = readFileSync(ENV_DOCS_PATH, "utf8");

  const schemaKeys = extractSchemaKeys(envTsSource);
  const allKnownVars = [...new Set([...schemaKeys, ...KNOWN_NON_SCHEMA_VARS])];

  it("found a non-trivial number of variables in src/lib/env.ts (sanity check that we're reading the real schema)", () => {
    expect(schemaKeys.length).toBeGreaterThanOrEqual(9);
  });

  it.each(allKnownVars)("%s is documented in .env.production.example", (name) => {
    // SEED_OWNER_EMAIL/SEED_OWNER_PASSWORD are deliberately shown commented
    // out (see the file's own note: never a Vercel project variable) — an
    // optional leading "# " is allowed for exactly that reason.
    expect(envExampleSource).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });

  it.each(allKnownVars)("%s is documented in docs/CLIENT-ENVIRONMENT-VARIABLES.md", (name) => {
    expect(envDocsSource).toContain(`\`${name}\``);
  });
});
