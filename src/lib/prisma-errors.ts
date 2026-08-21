import { Prisma } from "@prisma/client";

/**
 * True when `error` is a Postgres unique-constraint violation (Prisma error
 * code P2002) — e.g. two concurrent requests both passing a pre-check
 * `findUnique` (SKU, slug, e-mail) before either has committed. The
 * pre-check is still worth doing for the fast, common-case friendly error;
 * this is the defense-in-depth backstop for the rare race, so a duplicate
 * submission surfaces as a normal validation error instead of an unhandled
 * 500. See docs/adr/0002-domain-model.md's audit addendum.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
