/**
 * Lets a maintenance script run under `tsx` load the app's server modules.
 *
 * Every tenant/Prisma module (`src/lib/prisma.ts`, `src/lib/tenant/*`) starts
 * with `import "server-only"`. Inside Next.js that marker resolves, under the
 * `react-server` export condition, to an empty module; anywhere else it is
 * meant to throw. A plain Node CLI has neither: with pnpm the package only
 * exists inside Next (`next/dist/compiled/server-only`), so `tsx` fails with
 * « Cannot find module 'server-only' » before the script's first line runs.
 *
 * A CLI script IS server code, so this maps `server-only` to Next's own
 * server entry (`empty.js`) — exactly what Next does for server bundles — and
 * nothing else. Only processes that import this file are affected; the app,
 * its client bundles and the tests are not. Import it FIRST (tsx loads these
 * scripts as CommonJS, so imports run in order).
 */
import Module from "node:module";

const SERVER_ONLY_SERVER_ENTRY = require.resolve("next/dist/compiled/server-only/empty.js");

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: ResolveFilename };
const resolveFilename = moduleInternals._resolveFilename;

moduleInternals._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "server-only" ? SERVER_ONLY_SERVER_ENTRY : resolveFilename.call(this, request, ...rest);
};
