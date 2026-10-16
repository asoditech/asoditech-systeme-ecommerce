import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellLogoSrc } from "@/lib/branding/shell-logo";

/**
 * Company logo in the app shell (platform grant, owner decision 2026-10-16).
 * Pure rules + source checks of the wiring — no database.
 */

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("shellLogoSrc", () => {
  it("nothing unless the platform granted it", () => {
    expect(shellLogoSrc(false, "https://cdn.example.ma/logo.png")).toBeNull();
    expect(shellLogoSrc(false, PNG)).toBeNull();
  });

  it("granted: an https URL or a raster data URI", () => {
    expect(shellLogoSrc(true, "https://cdn.example.ma/logo.png")).toBe("https://cdn.example.ma/logo.png");
    expect(shellLogoSrc(true, `  ${PNG}  `)).toBe(PNG);
  });

  it("granted but missing / unusable → null (ASODITECH mark)", () => {
    for (const bad of [null, undefined, "", "   ", "http://cdn.example.ma/logo.png", "javascript:alert(1)", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PGI+", "https://"]) {
      expect(shellLogoSrc(true, bad)).toBeNull();
    }
    expect(shellLogoSrc(true, `data:image/png;base64,${"A".repeat(1_500_001)}`)).toBeNull();
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(path.resolve(import.meta.dirname, "../..", p), "utf8");

  it("the shell reads the grant for the viewer's own tenant and passes it to the sidebar and the mobile header/drawer", () => {
    const shell = read("src/components/layout/app-shell.tsx");
    expect(shell).toMatch(/getShellLogo\(user\.tenantId\)/);
    expect(shell).toMatch(/companyLogo=\{companyLogo\}/);
    expect(read("src/components/layout/sidebar-shell.tsx")).toMatch(/<CompanyLogo[\s\S]*compact=\{collapsed\}/);
    expect(read("src/components/layout/mobile-nav.tsx")).toMatch(/<CompanyLogo/);
  });

  it("the grant action is platform-admin only and audited", () => {
    const actions = read("src/actions/tenants.ts");
    const body = actions.slice(actions.indexOf("export async function setTenantBrandLogoGrantAction"));
    expect(body).toMatch(/requirePlatformAdminForAction\(\)/);
    expect(body).toMatch(/"tenant\.brand_logo_grant_changed"/);
  });

  it("a broken image falls back to the ASODITECH mark", () => {
    expect(read("src/components/layout/company-logo.tsx")).toMatch(/onError=\{\(\) => setFailed\(true\)\}/);
  });
});
