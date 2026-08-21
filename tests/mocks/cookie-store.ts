/**
 * A minimal in-memory stand-in for Next.js's request-scoped cookies() /
 * headers() so src/lib/auth/session.ts can be exercised outside an actual
 * HTTP request. Tests manipulate this directly to simulate "the browser
 * currently holds this session cookie."
 */

interface StoredCookie {
  value: string;
}

class MockCookieStore {
  private store = new Map<string, StoredCookie>();

  get(name: string) {
    const entry = this.store.get(name);
    return entry ? { name, value: entry.value } : undefined;
  }

  has(name: string) {
    return this.store.has(name);
  }

  set(name: string, value: string) {
    this.store.set(name, { value });
  }

  delete(name: string) {
    this.store.delete(name);
  }

  clear() {
    this.store.clear();
  }
}

export const mockCookieStore = new MockCookieStore();

export const mockHeaders = new Map<string, string>([
  ["user-agent", "vitest"],
  ["x-forwarded-for", "127.0.0.1"],
]);
