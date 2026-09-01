import { describe, expect, it } from "vitest";
import {
  assertPublicHost,
  isPrivateOrReservedIP,
  InvalidHostError,
} from "@/lib/integrations/shared/private-ip";

describe("isPrivateOrReservedIP", () => {
  it("flags loopback, private, link-local and reserved IPv4 ranges", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0"]) {
      expect(isPrivateOrReservedIP(ip)).toBe(true);
    }
  });

  it("flags IPv6 loopback, unspecified and unique-local addresses", () => {
    for (const ip of ["::1", "::", "fd00::1", "fc00::1", "fe80::1"]) {
      expect(isPrivateOrReservedIP(ip)).toBe(true);
    }
  });

  it("flags IPv4-mapped IPv6 pointing at a private address", () => {
    expect(isPrivateOrReservedIP("::ffff:10.0.0.1")).toBe(true);
  });

  it("treats anything that is not a recognizable IP as unsafe", () => {
    expect(isPrivateOrReservedIP("not-an-ip")).toBe(true);
  });

  it("allows genuine public addresses", () => {
    expect(isPrivateOrReservedIP("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIP("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertPublicHost", () => {
  it("rejects localhost and .local / .localhost suffixes without DNS", async () => {
    for (const host of ["localhost", "api.localhost", "printer.local"]) {
      await expect(assertPublicHost(host)).rejects.toBeInstanceOf(InvalidHostError);
    }
  });

  it("rejects bracketed IPv6 literals as literals — no DNS lookup", async () => {
    // A URL's `hostname` keeps the brackets ("[::1]"); the guard must
    // still classify it directly instead of resolving it, so the check
    // never depends on resolver behaviour or latency.
    await expect(assertPublicHost("[::1]")).rejects.toBeInstanceOf(InvalidHostError);
    await expect(assertPublicHost("[fd00::1]")).rejects.toBeInstanceOf(InvalidHostError);
  });

  it("rejects private IPv4 literals without DNS", async () => {
    await expect(assertPublicHost("127.0.0.1")).rejects.toBeInstanceOf(InvalidHostError);
    await expect(assertPublicHost("169.254.169.254")).rejects.toBeInstanceOf(InvalidHostError);
  });

  it("accepts a public IP literal", async () => {
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
    await expect(assertPublicHost("[2606:4700:4700::1111]")).resolves.toBeUndefined();
  });
});
