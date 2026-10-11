import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

/**
 * A fixed bcrypt hash at the same cost as every real one, of a random
 * secret nobody holds (it never matches). Login verifies against it when no
 * real hash was checked — unknown email, disabled account, suspended tenant —
 * so that path costs one bcrypt comparison like a wrong password does,
 * instead of answering measurably faster (account enumeration by timing).
 */
export const DUMMY_PASSWORD_HASH = "$2b$12$5l.StGNCesAoY.TDUlTwL.diO.xQDuhirjmNVdU7xLytEX7/lpbd.";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** Burns one bcrypt comparison against DUMMY_PASSWORD_HASH. Always false. */
export async function verifyDummyPassword(plain: string): Promise<false> {
  await bcrypt.compare(plain, DUMMY_PASSWORD_HASH);
  return false;
}
