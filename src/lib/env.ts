import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(20, "AUTH_SECRET must be at least 20 characters"),
  INTEGRATION_ENCRYPTION_KEY: z
    .string()
    .min(1, "INTEGRATION_ENCRYPTION_KEY is required")
    .refine((value) => {
      try {
        return Buffer.from(value, "base64").length === 32;
      } catch {
        return false;
      }
    }, "INTEGRATION_ENCRYPTION_KEY must be a base64-encoded 32-byte key"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Base URL used to build absolute links inside transactional emails
  // (invitation/password-reset — see src/lib/email.ts). Server-rendered
  // pages can build these from the incoming request, but a queued email
  // has no request to read from, so this must be set explicitly in any
  // deployed environment (production's real domain, not a *.vercel.app
  // preview URL — those change per-deployment).
  APP_URL: z.url().default("http://localhost:3000"),
  // Both optional: src/lib/email.ts falls back to logging the email
  // (previous behavior) when either is absent, so every existing
  // environment — including this test suite — keeps working unchanged
  // until an operator deliberately turns real delivery on.
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment variables. Check .env against .env.example.");
  }
  return parsed.data;
}

export const env = loadEnv();
