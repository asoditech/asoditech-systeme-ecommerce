import { describe, expect, it } from "vitest";
import { labelQrToken, scanCodeForMessage, scanMissHint, withScanHint } from "@/lib/catalog/scan-input";

/**
 * src/lib/catalog/scan-input.ts — what a received code IS, before the lookup.
 * Hints only explain a miss; nothing is ever converted into another code
 * (the only differently-resolved input is ASODITECH's own label QR).
 */

const TOKEN = "Zm9vYmFyYmF6cXV4LWxhYmVsLXRva2VuLTEyMzQ1Njc"; // 43 chars, base64url — generateRawToken's shape

/** What a US-layout (QWERTY) scanner types on a French AZERTY computer for these digits. */
const AZERTY_ROW: Record<string, string> = { "1": "&", "2": "é", "3": '"', "4": "'", "5": "(", "6": "-", "7": "è", "8": "_", "9": "ç", "0": "à" };
const onAzerty = (digits: string) => [...digits].map((d) => AZERTY_ROW[d]).join("");

describe("labelQrToken — ASODITECH label QR (/scan/<token>)", () => {
  it("extracts the token from the label URL, whatever the host (the token only resolves inside the caller's tenant)", () => {
    expect(labelQrToken(`https://www.asoditech.com/scan/${TOKEN}`)).toBe(TOKEN);
    expect(labelQrToken(`http://localhost:3000/scan/${TOKEN}/`)).toBe(TOKEN);
    expect(labelQrToken(`  HTTPS://WWW.ASODITECH.COM/scan/${TOKEN}\n`)).toBe(TOKEN);
  });

  it("nothing else is a label: SKU, EAN, other paths, short token, query string, garbled URL", () => {
    for (const code of [
      "TEST-RETOUR-1",
      "6111234567895",
      `https://www.asoditech.com/produits/${TOKEN}`,
      "https://www.asoditech.com/scan/short",
      `https://www.asoditech.com/scan/${TOKEN}?x=1`,
      `https://www.asoditech.com/scan/${TOKEN}/extra`,
      `httpsM!!www.asoditech.com!scan!${TOKEN}`,
      "",
      null,
    ]) {
      expect(labelQrToken(code), String(code)).toBeNull();
    }
  });
});

describe("scanMissHint — why an unmatched code may not be the intended one", () => {
  it("a normal SKU, a valid EAN-13 or a valid UPC-A: no hint (simply not in the catalogue)", () => {
    for (const code of ["TEST-RETOUR-1", "tshirt-noir-xl", "6111234567895", "012345678905", "ABC", "   "]) {
      expect(scanMissHint(code), code).toBeNull();
    }
  });

  it("QWERTY scanner on an AZERTY computer: explains the digits it meant — never converts them", () => {
    const typed = onAzerty("6111234567895");
    expect(typed).toBe('-&&&é"\'(-è_ç(');
    const hint = scanMissHint(typed)!;
    expect(hint.kind).toBe("layout-azerty");
    expect(hint.message).toContain("« 6111234567895 »");
    expect(hint.message).toContain("AZERTY");
    expect(scanMissHint(onAzerty("1234567890"))?.message).toContain("« 1234567890 »");
    expect(scanMissHint("§!§!")?.kind).toBe("layout-azerty"); // Belgian AZERTY 6 / 8
  });

  it("AZERTY scanner on a QWERTY computer: the shifted symbols", () => {
    const hint = scanMissHint("^!!!@#$%^*()")!;
    expect(hint.kind).toBe("layout-qwerty");
    expect(hint.message).toContain("« 611123456890 »");
  });

  it("too short to tell (< 4 characters) or mixed with other characters: no layout hint", () => {
    expect(scanMissHint("&é")).toBeNull();
    expect(scanMissHint("&é\"A1")).toBeNull();
  });

  it("a label QR read by a QWERTY scanner on AZERTY (« httpsM!! »): layout + read the bars", () => {
    expect(scanMissHint(`httpsM!!www.asoditech.com!scqn!${TOKEN}`)?.kind).toBe("layout-url");
  });

  it("ASODITECH label QR that matched nothing (other tenant / deleted): says so, reveals nothing else", () => {
    const hint = scanMissHint(`https://www.asoditech.com/scan/${TOKEN}`)!;
    expect(hint.kind).toBe("label-qr");
    expect(hint.message).not.toContain(TOKEN);
  });

  it("any other web link: a QR, not a product code", () => {
    expect(scanMissHint("https://example.com/p/1")?.kind).toBe("web-url");
    expect(scanMissHint("www.example.com")?.kind).toBe("web-url");
  });

  it("AIM symbology prefix sent by the scanner", () => {
    const hint = scanMissHint("]E06111234567895")!;
    expect(hint.kind).toBe("aim-prefix");
    expect(hint.message).toContain("« ]E0 »");
  });

  it("an EAN/UPC-length number with a wrong check digit (partial read / typo)", () => {
    expect(scanMissHint("6111234567890")?.kind).toBe("gtin-check-digit");
    expect(scanMissHint("12345670")).toBeNull(); // valid EAN-8
    expect(scanMissHint("12345678")?.kind).toBe("gtin-check-digit");
    expect(scanMissHint("123456")).toBeNull(); // not a GTIN length: an internal number
  });

  it("whitespace inside the code", () => {
    expect(scanMissHint("611 1234")?.kind).toBe("whitespace");
  });
});

describe("messages", () => {
  it("withScanHint appends the hint only when there is one", () => {
    expect(withScanHint("Code inconnu.", "TEST-1")).toBe("Code inconnu.");
    expect(withScanHint("Code inconnu.", "]E01234")).toMatch(/^Code inconnu\. Le scanner ajoute un préfixe/);
  });

  it("long codes are shortened for display", () => {
    expect(scanCodeForMessage("x".repeat(100))).toHaveLength(60);
    expect(scanCodeForMessage("  abc  ")).toBe("abc");
  });
});
