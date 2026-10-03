-- ASODITECH — production pre-release check. READ ONLY.
-- Everything runs inside ONE `BEGIN READ ONLY` transaction that is rolled
-- back: the server itself refuses any write. Prints no credential.
-- Run as the MIGRATION role (Vercel DIRECT_URL), with the Prisma query
-- string stripped (psql rejects `?schema=public`), output OUTSIDE the repo:
--   psql "${DIRECT_URL%%\?*}" -X -f scripts/prod-precheck.sql > ~/prod-precheck.out 2>&1
-- The output contains user e-mails: never commit it.
\set ON_ERROR_STOP on
\pset pager off
BEGIN READ ONLY;
SELECT set_config('app.bypass_rls', 'on', true) AS rls_bypass_for_this_tx;

\echo '=== 1a. database identity'
SELECT current_database() AS db, current_user AS role, r.rolsuper, r.rolbypassrls,
       split_part(version(), ' on ', 1) AS server
FROM pg_roles r WHERE r.rolname = current_user;

\echo '=== 1b. applied migrations (last 15)'
SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 15;
SELECT count(*) AS migrations_recorded,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS unfinished
FROM _prisma_migrations;

\echo '=== 1c. the 12 expected-pending migrations (already_recorded must be f)'
WITH expected(name) AS (VALUES
  ('20260919100000_online_offline_foundation'),
  ('20260919110000_user_permission_overrides'),
  ('20260919120000_suppliers_receptions_sales'),
  ('20260919130000_tenant_business_mode'),
  ('20260925120253_variation_saleprice_isactive_imageurl'),
  ('20260927000704_product_publications'),
  ('20260928162511_supplier_payment_allocation_and_qr_labels'),
  ('20260929102757_invitation_channel_scope'),
  ('20260929170907_business_settings_costing_method'),
  ('20260930120000_store_seller_role'),
  ('20260930200000_invitation_scope_precision'),
  ('20261002120000_user_whatsapp_notifications'))
SELECT e.name, m.migration_name IS NOT NULL AS already_recorded
FROM expected e LEFT JOIN _prisma_migrations m ON m.migration_name = e.name ORDER BY e.name;
SELECT migration_name AS location_migration, finished_at IS NOT NULL AS finished
FROM _prisma_migrations WHERE migration_name = '20260917113025_user_location_access';

\echo '=== 1d. objects the pending migrations create (must return 0 rows)'
SELECT 'type' AS kind, t AS name FROM unnest(ARRAY['SalesChannelKind','PermissionEffect','CashPaymentMethod','ReceptionStatus',
  'TenantBusinessMode','InvitationChannelScope','CostingMethod']) t WHERE to_regtype(format('%I', t)) IS NOT NULL
UNION ALL
SELECT 'table', t FROM unnest(ARRAY['sales_channels','sales_channel_locations','product_sales_channels','user_channels','barcodes',
  'user_permission_overrides','suppliers','receptions','reception_lines','supplier_payments','sales','sale_lines','sale_payments',
  'sale_returns','sale_return_lines','product_publications']) t WHERE to_regclass(format('public.%I', t)) IS NOT NULL
UNION ALL
SELECT 'column', table_name || '.' || column_name FROM information_schema.columns
WHERE table_schema = 'public' AND (table_name, column_name) IN (
  ('inventory_movements','onHandDelta'),('inventory_movements','onHandAfter'),('inventory_movements','unitCost'),
  ('inventory_movements','performedByName'),('inventory_movements','receptionLineId'),('inventory_movements','saleId'),
  ('inventory_movements','saleReturnId'),('orders','salesChannelId'),('products','reference'),('products','qrToken'),
  ('tenants','nextReceptionNumber'),('tenants','nextSaleNumber'),('tenants','nextSaleReturnNumber'),('tenants','businessMode'),
  ('product_variations','imageUrl'),('product_variations','isActive'),('product_variations','salePrice'),('product_variations','qrToken'),
  ('invitations','channelScope'),('invitations','offlineChannelIds'),('invitations','warehouseIds'),('business_settings','costingMethod'),
  ('users','whatsappPhone'),('users','whatsappVerifiedAt'),('users','whatsappOptInAt'),('users','whatsappVerification'),
  ('users','whatsappDeliveryFailureNotifiedAt'))
UNION ALL
SELECT 'enum value', 'UserRole.STORE_SELLER' FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
WHERE t.typname = 'UserRole' AND e.enumlabel = 'STORE_SELLER';

\echo '=== 2. active non-admin users with ZERO locations'
SELECT to_regclass('public.user_locations') IS NOT NULL AS has_user_locations \gset
\if :has_user_locations
SELECT count(*) AS zero_location_users FROM users u
WHERE u.role NOT IN ('OWNER','ADMIN') AND u.status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM user_locations l WHERE l."userId" = u.id);
SELECT u."tenantId", u.email, u.role, u.status, u."createdAt"::date AS created
FROM users u
WHERE u.role NOT IN ('OWNER','ADMIN') AND u.status = 'ACTIVE'
  AND NOT EXISTS (SELECT 1 FROM user_locations l WHERE l."userId" = u.id)
ORDER BY u."tenantId", u.role, u.email;
SELECT u.role, count(*) AS active_users, count(l."userId") AS with_locations
FROM users u LEFT JOIN (SELECT DISTINCT "userId" FROM user_locations) l ON l."userId" = u.id
WHERE u.status = 'ACTIVE' GROUP BY u.role ORDER BY u.role;
\else
\echo 'user_locations table does NOT exist'
\endif

\echo '=== 3. tenants'
SELECT t.id, t.name, t.status,
  (SELECT count(*) FROM users u WHERE u."tenantId" = t.id AND u.status = 'ACTIVE') AS active_users,
  (SELECT count(*) FROM warehouses w WHERE w."tenantId" = t.id) AS warehouses,
  (SELECT count(*) FROM warehouses w WHERE w."tenantId" = t.id AND w."isDefault") AS default_warehouses,
  (SELECT count(*) FROM warehouses w WHERE w."tenantId" = t.id AND w.type = 'MAGASIN') AS store_type_warehouses,
  (SELECT count(*) FROM warehouses w WHERE w."tenantId" = t.id AND w."isActive" AND (w.type = 'ENTREPOT' OR w.source = 'SHOPIFY')) AS online_channel_locations_to_map,
  (SELECT count(*) FROM orders o WHERE o."tenantId" = t.id) AS orders,
  (SELECT count(*) FROM integrations i WHERE i."tenantId" = t.id) AS integrations
FROM tenants t ORDER BY t."createdAt";

\echo '=== 4. volumes'
SELECT (SELECT count(*) FROM orders) AS orders,
       (SELECT count(*) FROM products) AS products,
       (SELECT count(*) FROM product_variations) AS variations,
       (SELECT count(*) FROM inventory_items) AS inventory_items,
       (SELECT count(*) FROM warehouses) AS warehouses,
       (SELECT count(*) FROM users WHERE role NOT IN ('OWNER','ADMIN')) AS non_admin_users;

\echo '=== 5. sales_channels'
SELECT to_regclass('public.sales_channels') IS NOT NULL AS has_sales_channels \gset
\if :has_sales_channels
SELECT count(*) AS rows, count(DISTINCT "tenantId") AS tenants,
       count(*) FILTER (WHERE "isDefault" AND kind = 'ONLINE') AS default_online FROM sales_channels;
\else
\echo 'sales_channels table does NOT exist (expected before migration 20260919100000)'
\endif

\echo '=== 6. cross-tenant reference mismatches (must all be 0)'
SELECT
  (SELECT count(*) FROM orders o JOIN customers c ON c.id = o."customerId" WHERE c."tenantId" <> o."tenantId") AS order_customer,
  (SELECT count(*) FROM order_items i JOIN orders o ON o.id = i."orderId" WHERE o."tenantId" <> i."tenantId") AS order_item_order,
  (SELECT count(*) FROM order_items i JOIN products p ON p.id = i."productId" WHERE p."tenantId" <> i."tenantId") AS order_item_product,
  (SELECT count(*) FROM inventory_items ii JOIN warehouses w ON w.id = ii."warehouseId" WHERE w."tenantId" <> ii."tenantId") AS inventory_warehouse,
  (SELECT count(*) FROM product_variations v JOIN products p ON p.id = v."productId" WHERE p."tenantId" <> v."tenantId") AS variation_product,
  (SELECT count(*) FROM shipments s JOIN orders o ON o.id = s."orderId" WHERE o."tenantId" <> s."tenantId") AS shipment_order,
  (SELECT count(*) FROM audit_events a JOIN users u ON u.id = a."actorUserId" WHERE u."tenantId" <> a."tenantId") AS audit_actor_other_tenant;
\if :has_user_locations
SELECT count(*) AS user_location_other_tenant FROM user_locations l JOIN warehouses w ON w.id = l."warehouseId" WHERE w."tenantId" <> l."tenantId";
\endif

\echo '=== 7. bootstrap-tenant audit rows written by the pre-0053 code (unknown-account login failures / rejected webhooks)'
SELECT action, count(*) FROM audit_events
WHERE "tenantId" = 'default' AND (action = 'integration.webhook_rejected' OR (action = 'user.login.failure' AND "entityId" = 'unknown'))
GROUP BY action;

\echo '=== 8. tenant mode consistency (after the migrations only; skipped before)'
SELECT to_regclass('public.sales') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'businessMode') AS has_mode \gset
\if :has_mode
SELECT t.id, t."businessMode",
  (SELECT count(*) FROM sales_channels c WHERE c."tenantId" = t.id AND c.kind = 'OFFLINE') AS offline_channels,
  (SELECT count(*) FROM sales s WHERE s."tenantId" = t.id) AS store_sales,
  (SELECT count(*) FROM sales_channels c WHERE c."tenantId" = t.id AND c."isDefault" AND c.kind = 'ONLINE') AS default_online_channel
FROM tenants t ORDER BY t."createdAt";
\else
\echo 'tenants.businessMode / sales not present yet (expected before the pending migrations)'
\endif

ROLLBACK;
\echo '=== done (rolled back, nothing written)'
