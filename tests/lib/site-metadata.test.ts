import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { buildRootMetadata, siteOrigin, SITE_NAME } from "@/lib/site-metadata";
import manifest from "@/app/manifest";
import { proxy } from "@/proxy";

/**
 * Sharing / home-screen branding: absolute origin for crawler-visible
 * metadata, the file-convention images exist with the right sizes, the
 * manifest points at real icons, and the cookie-less fetches a crawler or
 * browser makes for them are never bounced to /connexion.
 */

const root = path.resolve(import.meta.dirname, "../..");

function pngSize(rel: string) {
  const buf = readFileSync(path.join(root, rel));
  expect(buf.subarray(1, 4).toString()).toBe("PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe("siteOrigin / metadataBase", () => {
  it("uses only the origin of APP_URL", () => {
    expect(siteOrigin("https://www.asoditech.com").href).toBe("https://www.asoditech.com/");
    expect(siteOrigin("https://user:secret@www.asoditech.com/some/path?x=1").href).toBe("https://www.asoditech.com/");
  });

  it("falls back to localhost for a missing or non-http value", () => {
    expect(siteOrigin(undefined).href).toBe("http://localhost:3000/");
    expect(siteOrigin("javascript:alert(1)").href).toBe("http://localhost:3000/");
    expect(siteOrigin("not a url").href).toBe("http://localhost:3000/");
  });
});

describe("buildRootMetadata", () => {
  it("sets an absolute base and Open Graph / Twitter large-image cards", () => {
    const m = buildRootMetadata("https://www.asoditech.com");
    expect(String(m.metadataBase)).toBe("https://www.asoditech.com/");
    expect(m.openGraph).toMatchObject({ siteName: SITE_NAME, type: "website", url: "/" });
    expect(m.twitter).toMatchObject({ card: "summary_large_image" });
    expect(m.applicationName).toBe(SITE_NAME);
  });
});

describe("branding files (Next.js metadata file conventions)", () => {
  it("favicon, Apple touch icon and share images exist with the expected sizes", () => {
    expect(pngSize("src/app/icon.png")).toEqual({ width: 740, height: 740 });
    expect(pngSize("src/app/apple-icon.png")).toEqual({ width: 180, height: 180 });
    expect(pngSize("src/app/opengraph-image.png")).toEqual({ width: 1200, height: 630 });
    expect(pngSize("src/app/twitter-image.png")).toEqual({ width: 1200, height: 630 });
    expect(readFileSync(path.join(root, "src/app/opengraph-image.alt.txt"), "utf8")).toContain("ASODITECH");
  });

  it("the manifest's icons exist in public/ with their declared sizes", () => {
    const m = manifest();
    expect(m.short_name).toBe(SITE_NAME);
    for (const icon of m.icons ?? []) {
      const file = path.join("public", icon.src);
      expect(existsSync(path.join(root, file))).toBe(true);
      const { width, height } = pngSize(file);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });
});

describe("proxy: cookie-less fetches of branding assets", () => {
  const get = (p: string) => proxy(new NextRequest(new URL(p, "https://www.asoditech.com")));
  const redirected = (r: Response) => r.status >= 300 && r.status < 400;

  it("lets crawlers and browsers fetch the manifest, icons and share images without a session", () => {
    for (const p of ["/manifest.webmanifest", "/icon.png", "/apple-icon.png", "/opengraph-image.png", "/twitter-image.png", "/icons/icon-192.png"]) {
      expect(redirected(get(p)), p).toBe(false);
    }
  });

  it("still sends an unauthenticated visitor of an app page to /connexion", () => {
    const r = get("/commandes");
    expect(redirected(r)).toBe(true);
    expect(r.headers.get("location")).toContain("/connexion");
  });
});
