import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET/POST /api/cron/whatsapp-outbox — fails closed (docs/adr/0058 addendum).
 * Pure: env and the outbox processor are mocked; nothing is ever sent.
 */

const env = vi.hoisted(() => ({ CRON_SECRET: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env }));
const processor = vi.hoisted(() => ({
  run: vi.fn(async () => ({ tenants: 1, sent: 2, retrying: 0, failed: 0, ignored: 0 })),
}));
vi.mock("@/lib/whatsapp/outbox", () => ({ processWhatsAppOutboxForAllTenants: processor.run }));

import { GET, POST } from "@/app/api/cron/whatsapp-outbox/route";

const req = (authorization?: string) =>
  new Request("http://localhost/api/cron/whatsapp-outbox", authorization ? { headers: { authorization } } : {});

beforeEach(() => {
  env.CRON_SECRET = undefined;
  processor.run.mockClear();
});

describe("cron whatsapp-outbox route", () => {
  it("CRON_SECRET unset (or blank) → 503, processor never runs, even with a bearer", async () => {
    expect((await GET(req("Bearer anything"))).status).toBe(503);
    env.CRON_SECRET = "";
    expect((await POST(req("Bearer "))).status).toBe(503);
    expect(processor.run).not.toHaveBeenCalled();
  });

  it("missing / wrong / non-Bearer authorization → 401, processor never runs", async () => {
    env.CRON_SECRET = "cron-secret-value-123";
    for (const h of [undefined, "cron-secret-value-123", "Bearer cron-secret-value-12", "Bearer cron-secret-value-1234", "Basic cron-secret-value-123"]) {
      expect((await GET(req(h))).status).toBe(401);
    }
    expect(processor.run).not.toHaveBeenCalled();
  });

  it("exact bearer → 200 with counts only, no-store", async () => {
    env.CRON_SECRET = "cron-secret-value-123";
    const res = await GET(req("Bearer cron-secret-value-123"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, tenants: 1, sent: 2, retrying: 0, failed: 0, ignored: 0 });
    expect(processor.run).toHaveBeenCalledTimes(1);
  });
});
