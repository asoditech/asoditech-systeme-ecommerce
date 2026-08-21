import { vi } from "vitest";
import { mockCookieStore, mockHeaders } from "./mocks/cookie-store";

// Minimal stand-ins for the request-scoped Next.js APIs our server code
// depends on (cookies/headers/redirect/revalidatePath), so lib/action code
// can run under Vitest without a real HTTP request. See
// tests/mocks/cookie-store.ts for the cookie jar tests manipulate directly.

vi.mock("next/headers", () => ({
  cookies: async () => mockCookieStore,
  headers: async () => ({
    get: (name: string) => mockHeaders.get(name.toLowerCase()) ?? null,
  }),
}));

export class RedirectSignal extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

vi.mock("server-only", () => ({}));
