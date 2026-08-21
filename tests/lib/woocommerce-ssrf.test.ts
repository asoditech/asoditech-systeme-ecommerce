import { describe, expect, it } from "vitest";
import { validateStoreUrl, InvalidStoreUrlError } from "@/lib/integrations/woocommerce/ssrf";

describe("validateStoreUrl — SSRF protection", () => {
  it("rejects plain HTTP", async () => {
    await expect(validateStoreUrl("http://example.com")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects malformed URLs", async () => {
    await expect(validateStoreUrl("not-a-url")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects a URL carrying embedded credentials", async () => {
    await expect(validateStoreUrl("https://user:pass@example.com")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects localhost", async () => {
    await expect(validateStoreUrl("https://localhost")).rejects.toThrow(InvalidStoreUrlError);
    await expect(validateStoreUrl("https://sub.localhost")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects loopback and private IPv4 literals without needing DNS", async () => {
    await expect(validateStoreUrl("https://127.0.0.1")).rejects.toThrow(InvalidStoreUrlError);
    await expect(validateStoreUrl("https://10.0.0.5")).rejects.toThrow(InvalidStoreUrlError);
    await expect(validateStoreUrl("https://192.168.1.1")).rejects.toThrow(InvalidStoreUrlError);
    await expect(validateStoreUrl("https://172.16.0.1")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects the cloud metadata link-local address", async () => {
    await expect(validateStoreUrl("https://169.254.169.254")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("rejects IPv6 loopback and unique-local literals", async () => {
    await expect(validateStoreUrl("https://[::1]")).rejects.toThrow(InvalidStoreUrlError);
    await expect(validateStoreUrl("https://[fd00::1]")).rejects.toThrow(InvalidStoreUrlError);
  });

  it("accepts a public IPv4 literal over HTTPS and normalizes to origin only", async () => {
    // 8.8.8.8 (Google public DNS) — a stable, unambiguously public address,
    // used only to prove the "public IP passes" path; no request is ever
    // made to it here.
    const result = await validateStoreUrl("https://8.8.8.8/some/path?x=1");
    expect(result).toBe("https://8.8.8.8");
  });
});
