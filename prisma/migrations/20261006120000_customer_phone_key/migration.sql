-- Customer identity key (src/lib/customers/identity.ts → customerPhoneKey).
-- Additive: one nullable column + one index, then the new column is filled
-- for existing customers. No existing column is modified; no row is merged,
-- deleted or re-created. A customer IS « normalized name + phoneKey »
-- (src/lib/customers/find-or-create.ts).

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "phoneKey" TEXT;

-- CreateIndex
CREATE INDEX "customers_tenantId_phoneKey_idx" ON "customers"("tenantId", "phoneKey");

-- Backfill: the SAME rule as customerPhoneKey() — kept in sync by
-- tests/actions/customer-phone-key-migration.test.ts (SQL ↔ TypeScript parity).
--   "+"/"00" → international, kept; Moroccan local 0[5-7]XXXXXXXX or
--   [5-7]XXXXXXXX → 212…; valid only 212[5-7]XXXXXXXX or an international
--   8–15 digit number; anything else stays NULL (no matching).
UPDATE "customers" AS c
SET "phoneKey" = k.key
FROM (
  SELECT id,
    CASE
      WHEN p IS NULL THEN NULL
      WHEN p LIKE '212%' THEN CASE WHEN p ~ '^212[5-7][0-9]{8}$' THEN p END
      WHEN intl AND p ~ '^[1-9][0-9]{7,14}$' THEN p
      ELSE NULL
    END AS key
  FROM (
    SELECT id, intl,
      CASE
        WHEN NOT ok OR d2 = '' THEN NULL
        WHEN intl THEN d2
        WHEN d2 ~ '^0[5-7][0-9]{8}$' THEN '212' || substr(d2, 2)
        WHEN d2 ~ '^[5-7][0-9]{8}$' THEN '212' || d2
        ELSE d2
      END AS p
    FROM (
      SELECT id, ok,
        CASE WHEN d LIKE '00%' THEN substr(d, 3) ELSE d END AS d2,
        (v LIKE '+%' OR d LIKE '00%') AS intl
      FROM (
        SELECT id,
          btrim("phone") AS v,
          regexp_replace("phone", '[^0-9]', '', 'g') AS d,
          btrim("phone") ~ '^[+0-9[:space:]()./-]+$' AS ok
        FROM "customers"
        WHERE "phone" IS NOT NULL
      ) raw
    ) prepared
  ) normalized
) AS k
WHERE c.id = k.id AND k.key IS NOT NULL;
