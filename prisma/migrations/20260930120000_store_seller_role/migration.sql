-- Phase 4A — STORE_SELLER role. See docs/adr/0042-store-seller-role.md.
--
-- Fully additive: one new UserRole value. No existing row is changed and no
-- user is backfilled to it. The value is only ADDED here, never used in this
-- migration, so it is safe in the single wrapping transaction on
-- PostgreSQL 12+ (same precedent as 20260913010000_stock_insufficient_notification).
ALTER TYPE "UserRole" ADD VALUE 'STORE_SELLER';
