import { describe, expect, it } from "vitest";
import {
  generatedValueAction,
  nameCode,
  nextSequencedCode,
  productReferenceBase,
  productSkuBase,
  withSequence,
} from "@/lib/catalog/sku-suggestion";
import { suggestVariationSku } from "@/lib/catalog/variations";
import { skuSchema } from "@/lib/validation/product";

/** Pure « Générer » suggestion rules (no database). */

describe("name code", () => {
  it("initials of each word, accents stripped, uppercase", () => {
    expect(nameCode("T-shirt Basic Noir")).toBe("TBN");
    expect(nameCode("Écharpe Élégante Été")).toBe("EEE");
    expect(nameCode("  chemise   lin  ")).toBe("CL");
  });
  it("one word → its first 3 characters; empty → empty", () => {
    expect(nameCode("Casquette")).toBe("CAS");
    expect(nameCode("T-shirt")).toBe("TSH");
    expect(nameCode("   ")).toBe("");
    expect(nameCode(null)).toBe("");
  });
  it("special characters never reach the code; long names are capped at 5 initials", () => {
    expect(nameCode("Hoodie cachmir")).toBe("HC");
    expect(nameCode("Sac (cuir) & pochette !")).toBe("SCP");
    expect(nameCode("Chemise lin premium collection été 2026 blanc")).toBe("CLPCE");
  });
});

const seq = (base: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => withSequence(base, from + i));

describe("SKU and reference formats", () => {
  it("Hoodie cachmir → HC → REF-HC-0001 / SKU-HC-0001", () => {
    expect(nameCode("Hoodie cachmir")).toBe("HC");
    expect(nextSequencedCode(productReferenceBase("Hoodie cachmir"), [])).toBe("REF-HC-0001");
    expect(nextSequencedCode(productSkuBase("Hoodie cachmir"), [])).toBe("SKU-HC-0001");
  });
  it("T-shirt Basic Noir → TBN → REF-TBN-0001 / SKU-TBN-0001", () => {
    expect(nameCode("T-shirt Basic Noir")).toBe("TBN");
    expect(nextSequencedCode(productReferenceBase("T-shirt Basic Noir"), [])).toBe("REF-TBN-0001");
    expect(nextSequencedCode(productSkuBase("T-shirt Basic Noir"), [])).toBe("SKU-TBN-0001");
  });
  it("never the old formats", () => {
    const sku = nextSequencedCode(productSkuBase("Hoodie cachmir"), [])!;
    const ref = nextSequencedCode(productReferenceBase("Hoodie cachmir"), [])!;
    for (const old of ["HC-001", "HC-0001", "SKU-HC-001", "REF-HC-001"]) {
      expect(sku).not.toBe(old);
      expect(ref).not.toBe(old);
    }
  });
  it("empty name → no suggestion", () => {
    expect(productSkuBase("  ")).toBe("");
    expect(productReferenceBase("")).toBe("");
    expect(nextSequencedCode(productSkuBase(""), [])).toBeNull();
  });
});

describe("four-digit sequence", () => {
  it("increments 0001 → 0002 → 0003, skipping taken codes (case-insensitive)", () => {
    expect(nextSequencedCode("SKU-HC", [])).toBe("SKU-HC-0001");
    expect(nextSequencedCode("SKU-HC", ["SKU-HC-0001"])).toBe("SKU-HC-0002");
    expect(nextSequencedCode("SKU-HC", ["sku-hc-0001", "SKU-HC-0002"])).toBe("SKU-HC-0003");
  });
  it("crosses 0099 → 0100 and 0999 → 1000", () => {
    expect(nextSequencedCode("SKU-HC", seq("SKU-HC", 1, 99))).toBe("SKU-HC-0100");
    expect(nextSequencedCode("REF-HC", seq("REF-HC", 1, 999))).toBe("REF-HC-1000");
  });
  it("grows past 9999 → 10000 (never truncated or reset)", () => {
    expect(withSequence("SKU-HC", 9999)).toBe("SKU-HC-9999");
    expect(withSequence("SKU-HC", 10000)).toBe("SKU-HC-10000");
    expect(nextSequencedCode("SKU-HC", seq("SKU-HC", 1, 9999))).toBe("SKU-HC-10000");
    expect(nextSequencedCode("SKU-HC", seq("SKU-HC", 1, 10001))).toBe("SKU-HC-10002");
  });
  it("every generated SKU passes skuSchema, even for long or exotic names", () => {
    for (const name of ["Hoodie cachmir", "Écharpe", "Sac (cuir) & pochette !", "A B", "Chemise lin premium collection été 2026 blanc"]) {
      for (const n of [1, 9999, 10000, 123456]) {
        const value = withSequence(productSkuBase(name), n);
        expect(skuSchema.safeParse(value).success, value).toBe(true);
      }
    }
  });
});

describe("never overwrite silently", () => {
  it("empty field → fill; a different manual value → confirm; same value → nothing", () => {
    expect(generatedValueAction("", "SKU-HC-0001")).toBe("fill");
    expect(generatedValueAction("   ", "SKU-HC-0001")).toBe("fill");
    expect(generatedValueAction("MY-CUSTOM-SKU", "SKU-HC-0001")).toBe("confirm"); // manual SKU
    expect(generatedValueAction("SKOUBA", "REF-HC-0001")).toBe("confirm"); // manual reference
    expect(generatedValueAction("SKU-HC-0001", "SKU-HC-0001")).toBe("none");
  });
});

describe("variation SKU generation is unchanged", () => {
  it("still reference/name + literal option values", () => {
    expect(suggestVariationSku("TSB", { Couleur: "Noir", Taille: "S" })).toBe("TSB-NOIR-S");
    expect(suggestVariationSku("Chaussures Homme", { Taille: "42" })).toBe("CHAUSSURES-HOMME-42");
    expect(suggestVariationSku(null, { Couleur: "Été" })).toBe("ETE");
  });
});
