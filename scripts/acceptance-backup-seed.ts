/**
 * ACCEPTANCE-TEST FIXTURE for the Backup & Portability module
 * (docs/adr/0034). NOT production code — seeds two realistic tenants into
 * the LOCAL dev database and prints ready-to-use session cookies so the
 * running `next dev` server can be driven end-to-end.
 *
 *   npx dotenv -e .env -- npx tsx scripts/acceptance-backup-seed.ts
 *
 * Connects via DIRECT_URL (superuser) so it can seed rows into any tenant.
 * The dev server itself still runs as the restricted, NOBYPASSRLS role.
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHmac, randomBytes } from "node:crypto";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "";
// Destructive — refuse anything that isn't an obviously-local dev/test DB.
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url) || /prod|supabase|amazonaws|neon\.tech/i.test(url)) {
  throw new Error(`Refusing to run the acceptance seed against a non-local database: ${url.replace(/:[^:@/]+@/, ":***@")}`);
}
const prisma = new PrismaClient({ datasources: { db: { url } } });

const AUTH_SECRET = process.env.AUTH_SECRET!;
const INTEGRATION_ENCRYPTION_KEY = process.env.INTEGRATION_ENCRYPTION_KEY!;

function hashToken(raw: string) {
  return createHmac("sha256", AUTH_SECRET).update(raw).digest("hex");
}

// Mirrors src/lib/crypto.ts encryptSecret (so "credentials" look real).
import { createCipheriv } from "node:crypto";
function encryptSecret(plaintext: string) {
  const iv = randomBytes(12);
  const key = Buffer.from(INTEGRATION_ENCRYPTION_KEY, "base64");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

async function wipe() {
  // Order mirrors tests/helpers/db.ts::resetDb.
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  const tables = [
    "audit_events", "backup_runs", "password_reset_tokens", "invitations", "notifications",
    "webhook_events", "sync_runs", "integrations", "marketing_campaigns", "marketing_channels",
    "expenses", "expense_categories", "shipment_webhook_events", "shipments", "delivery_manifests",
    "shipping_providers", "commission_entries", "commission_statements", "commission_agents",
    "refunds", "order_items", "orders", "stocktake_lines", "stocktake_sessions",
    "inventory_movements", "stock_transfer_lines", "stock_transfers", "inventory_items",
    "warehouses", "product_variations", "product_images", "products", "categories",
    "customer_addresses", "customers", "business_settings", "sessions", "users",
    "delivery_city_mappings",
  ];
  for (const t of tables) await prisma.$executeRawUnsafe(`DELETE FROM "${t}"`);
  await prisma.$executeRawUnsafe(`DELETE FROM "tenants" WHERE id <> 'default'`);
  await prisma.$executeRawUnsafe(`SET session_replication_role = origin`);
}

async function seedTenant(opts: {
  tenantId: string;
  name: string;
  slug: string;
  tag: string;
  scale: number;
}) {
  const { tenantId, tag, scale } = opts;
  await prisma.tenant.upsert({
    where: { id: tenantId },
    update: { name: opts.name, slug: opts.slug },
    create: { id: tenantId, name: opts.name, slug: opts.slug },
  });
  await prisma.businessSettings.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId, companyName: opts.name, currency: "MAD", city: "Casablanca", country: "Maroc" },
  });

  const wh = await prisma.warehouse.create({
    data: { tenantId, name: `Entrepôt ${tag}`, isDefault: true, type: "ENTREPOT" },
  });
  const shop = await prisma.warehouse.create({
    data: { tenantId, name: `Magasin ${tag}`, type: "MAGASIN" },
  });

  const catParent = await prisma.category.create({ data: { tenantId, name: `Vêtements ${tag}`, slug: `vetements-${tenantId}` } });
  const catChild = await prisma.category.create({
    data: { tenantId, name: `Tabliers ${tag}`, slug: `tabliers-${tenantId}`, parentId: catParent.id },
  });

  const products: { id: string; variationIds: string[] }[] = [];
  for (let i = 0; i < scale; i++) {
    const isVariable = i % 3 === 0;
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: `Tablier ${tag}-${i}`,
        sku: `SKU-${tenantId}-${i}`,
        price: (80 + i * 5).toFixed(2),
        cost: (30 + i * 2).toFixed(2),
        status: i % 5 === 0 ? "BROUILLON" : "ACTIF",
        categoryId: catChild.id,
        trackInventory: true,
      },
    });
    const variationIds: string[] = [];
    if (isVariable) {
      for (const color of ["Rouge", "Bleu"]) {
        const v = await prisma.productVariation.create({
          data: {
            tenantId,
            productId: p.id,
            sku: `SKU-${tenantId}-${i}-${color}`,
            attributes: { Couleur: color },
            price: (85 + i * 5).toFixed(2),
            cost: (32 + i * 2).toFixed(2),
          },
        });
        variationIds.push(v.id);
        await prisma.inventoryItem.create({
          data: { tenantId, warehouseId: wh.id, variationId: v.id, quantityOnHand: 40 + i },
        });
      }
    } else {
      await prisma.inventoryItem.create({
        data: { tenantId, warehouseId: wh.id, productId: p.id, quantityOnHand: 50 + i, quantityReserved: i % 4 },
      });
      await prisma.inventoryItem.create({
        data: { tenantId, warehouseId: shop.id, productId: p.id, quantityOnHand: 10 + i },
      });
    }
    products.push({ id: p.id, variationIds });
  }

  // Inventory movements (stock ledger).
  const items = await prisma.inventoryItem.findMany({ where: { tenantId }, take: 10 });
  for (const it of items) {
    await prisma.inventoryMovement.create({
      data: {
        tenantId,
        inventoryItemId: it.id,
        warehouseId: it.warehouseId,
        type: "RECEPTION",
        quantity: 20,
        reason: "Réception initiale",
      },
    });
  }

  // A stock transfer + a stocktake.
  const transfer = await prisma.stockTransfer.create({
    data: {
      tenantId,
      sourceWarehouseId: wh.id,
      destinationWarehouseId: shop.id,
      status: "RECU",
      dispatchedAt: new Date(),
      receivedAt: new Date(),
      lines: {
        create: [{ tenantId, productId: products[1].id, quantitySent: 5, quantityReceived: 5 }],
      },
    },
  });
  await prisma.inventoryMovement.create({
    data: { tenantId, inventoryItemId: items[0].id, warehouseId: wh.id, type: "TRANSFERT_SORTIE", quantity: -5, stockTransferId: transfer.id },
  });
  const stocktake = await prisma.stocktakeSession.create({
    data: {
      tenantId,
      warehouseId: wh.id,
      status: "CLOTURE",
      closedAt: new Date(),
      lines: {
        create: items.slice(0, 3).map((it) => ({
          tenantId,
          inventoryItemId: it.id,
          systemQuantityAtCount: 50,
          countedQuantity: 50,
          countedAt: new Date(),
        })),
      },
    },
  });
  void stocktake;

  // Delivery provider (API, with a secret) + orders + shipments.
  const provider = await prisma.shippingProvider.create({
    data: {
      tenantId,
      name: `OzonExpress ${tag}`,
      type: "API",
      providerKey: "ozonexpress",
      connectionStatus: "CONNECTE",
      lastConnectionCheckAt: new Date(),
      capabilities: ["CREATE_SHIPMENT", "FETCH_STATUS"],
      credentialsEncrypted: encryptSecret(JSON.stringify({ customerId: `CID-${tag}`, apiKey: `OZ-APIKEY-SECRET-${tag}` })),
      config: { customerId: `CID-${tag}`, apiKey: `OZ-APIKEY-SECRET-${tag}`, defaultCity: "Casablanca" },
      returnCost: "15.00",
      failureCost: "10.00",
    },
  });
  await prisma.deliveryCityMapping.create({
    data: {
      tenantId,
      shippingProviderId: provider.id,
      localCityKey: "casablanca",
      localCityLabel: "Casablanca",
      providerCityId: "1",
      providerCityName: "Casablanca",
    },
  });

  const statuses = ["NOUVELLE", "CONFIRMEE", "EN_PREPARATION", "EXPEDIEE", "LIVREE", "ANNULEE"] as const;
  const orderIds: string[] = [];
  for (let i = 0; i < scale * 2; i++) {
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        fullName: `Client ${tag} ${i}`,
        phone: `06${String(10000000 + i).slice(0, 8)}`,
        city: "Casablanca",
        country: "Maroc",
        addresses: {
          create: [{ tenantId, addressLine1: `${i} rue de Test`, city: "Casablanca", country: "Maroc", isDefault: true }],
        },
      },
    });
    const prod = products[i % products.length];
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: statuses[i % statuses.length],
        paymentMethod: "PAIEMENT_LIVRAISON",
        source: "INTERNE",
        channel: "WHATSAPP",
        subtotal: "160.00",
        total: "160.00",
        currency: "MAD",
        shippingName: `Client ${tag} ${i}`,
        shippingAddressLine1: `${i} rue de Test`,
        shippingCity: "Casablanca",
        shippingCountry: "Maroc",
        shippingPhone: `06${String(10000000 + i).slice(0, 8)}`,
        fulfillmentWarehouseId: wh.id,
        items: {
          create: [
            {
              tenantId,
              productId: prod.variationIds.length ? null : prod.id,
              variationId: prod.variationIds[0] ?? null,
              nameSnapshot: `Tablier ${tag}-${i % products.length}`,
              skuSnapshot: `SKU-${tenantId}-${i % products.length}`,
              quantity: 2,
              unitPrice: "80.00",
              total: "160.00",
              costSnapshot: "30.00",
            },
          ],
        },
      },
    });
    orderIds.push(order.id);

    if (["EXPEDIEE", "LIVREE"].includes(statuses[i % statuses.length])) {
      await prisma.shipment.create({
        data: {
          tenantId,
          orderId: order.id,
          providerId: provider.id,
          status: statuses[i % statuses.length] === "LIVREE" ? "LIVRE" : "EN_TRANSIT",
          externalId: `OZ-${tenantId}-${i}`,
          trackingNumber: `TRK-${tenantId}-${i}`,
          trackingUrl: `https://tracking.example.com/${tenantId}-${i}`,
          providerStatusRaw: statuses[i % statuses.length] === "LIVREE" ? "Livré" : "En cours",
          cost: "25.00",
          costSource: "CARRIER_API",
          costFinalizedAt: statuses[i % statuses.length] === "LIVREE" ? new Date() : null,
          trackingEvents: [
            { rawStatus: "Nouveau colis", code: "CREATED", label: null, description: null, location: null, timestamp: new Date().toISOString() },
          ],
          lastTrackingSyncAt: new Date(),
        },
      });
    }
    if (i % 7 === 3) {
      await prisma.refund.create({ data: { tenantId, orderId: order.id, amount: "20.00", reason: "Geste commercial", status: "COMPLETE" } });
    }
  }

  // Confirmation attempts on a couple of orders.
  for (const oid of orderIds.slice(0, 3)) {
    await prisma.orderConfirmationAttempt.create({
      data: { tenantId, orderId: oid, outcome: "CONFIRME", note: "Confirmé par téléphone" },
    });
  }

  // Finance: expense categories + expenses.
  const expCat = await prisma.expenseCategory.create({ data: { tenantId, name: `Publicité ${tag}`, isSystem: false } });
  for (let i = 0; i < 4; i++) {
    await prisma.expense.create({
      data: { tenantId, categoryId: expCat.id, amount: (200 + i * 50).toFixed(2), currency: "MAD", date: new Date(), description: `Campagne ${i}`, vendor: "Meta" },
    });
  }

  // Marketing.
  const channel = await prisma.marketingChannel.create({ data: { tenantId, name: `Meta ${tag}`, type: "META" } });
  await prisma.marketingCampaign.create({
    data: { tenantId, channelId: channel.id, name: `Soldes ${tag}`, startDate: new Date(), budget: "5000.00", spend: "3200.00", status: "ACTIVE" },
  });

  // A WooCommerce + a Shopify integration, both with secrets.
  await prisma.integration.create({
    data: {
      tenantId,
      provider: "WOOCOMMERCE",
      status: "CONNECTE",
      lastConnectionCheckAt: new Date(),
      lastSyncAt: new Date(),
      capabilities: ["IMPORT_PRODUCTS", "IMPORT_ORDERS"],
      config: { storeUrl: `https://${opts.slug}.example.com`, consumerKey: `ck_${tag}`, consumerSecret: `cs_SECRET_${tag}`, webhookSecret: `whsec_SECRET_${tag}` },
      credentialsEncrypted: encryptSecret(JSON.stringify({ consumerKey: `ck_${tag}`, consumerSecret: `cs_SECRET_${tag}`, webhookSecret: `whsec_SECRET_${tag}` })),
    },
  });
  await prisma.integration.create({
    data: {
      tenantId,
      provider: "META_ADS",
      status: "CONNECTE",
      config: { accountId: `act_${tag}`, accessToken: `EAAB_ACCESS_TOKEN_SECRET_${tag}` },
      credentialsEncrypted: encryptSecret(JSON.stringify({ accessToken: `EAAB_ACCESS_TOKEN_SECRET_${tag}` })),
    },
  });

  // Commission agent + entries need a User — created below.
  return { warehouseId: wh.id, providerId: provider.id };
}

async function makeUser(opts: { tenantId: string; email: string; role: string; name: string; platformAdmin?: boolean }) {
  const user = await prisma.user.create({
    data: {
      tenantId: opts.tenantId,
      email: opts.email,
      name: opts.name,
      passwordHash: await bcrypt.hash("acceptance-Pass-123", 12),
      role: opts.role as never,
      status: "ACTIVE",
      isPlatformAdmin: opts.platformAdmin ?? false,
    },
  });
  const raw = randomBytes(32).toString("base64url");
  await prisma.session.create({
    data: { userId: user.id, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + 30 * 864e5) },
  });
  return { user, cookie: raw };
}

async function main() {
  await wipe();

  await seedTenant({ tenantId: "default", name: "Boutique A (défaut)", slug: "boutique-a", tag: "A", scale: 6 });
  await seedTenant({ tenantId: "tenant-acme", name: "ACME Store B", slug: "acme-store-b", tag: "B", scale: 4 });

  const aOwner = await makeUser({ tenantId: "default", email: "owner.a@acceptance.test", role: "OWNER", name: "Amina A", platformAdmin: true });
  const aWarehouse = await makeUser({ tenantId: "default", email: "wh.a@acceptance.test", role: "WAREHOUSE", name: "Karim A" });
  const bOwner = await makeUser({ tenantId: "tenant-acme", email: "owner.b@acceptance.test", role: "OWNER", name: "Bilal B" });

  // Commission agent for tenant A's owner + a couple of ledger entries.
  const agent = await prisma.commissionAgent.create({
    data: { tenantId: "default", userId: aOwner.user.id, ratePerOrder: "12.00", currency: "MAD" },
  });
  const livree = await prisma.order.findFirst({ where: { tenantId: "default", status: "LIVREE" } });
  if (livree) {
    await prisma.commissionEntry.create({
      data: { tenantId: "default", agentId: agent.id, orderId: livree.id, type: "EARNED", amount: "12.00", rateApplied: "12.00", currency: "MAD" },
    });
  }

  // Some audit history for tenant A.
  for (let i = 0; i < 5; i++) {
    await prisma.auditEvent.create({
      data: { tenantId: "default", actorType: "USER", actorUserId: aOwner.user.id, action: "order.created", entityType: "Order", entityId: `seed-${i}`, metadata: { seeded: true } },
    });
  }

  const counts: Record<string, number> = {};
  for (const [label, model] of [
    ["products", prisma.product], ["variations", prisma.productVariation], ["customers", prisma.customer],
    ["orders", prisma.order], ["orderItems", prisma.orderItem], ["shipments", prisma.shipment],
    ["inventoryItems", prisma.inventoryItem], ["inventoryMovements", prisma.inventoryMovement],
    ["integrations", prisma.integration], ["expenses", prisma.expense], ["auditEvents", prisma.auditEvent],
  ] as const) {
    counts[label] = await (model as { count: (a: unknown) => Promise<number> }).count({ where: { tenantId: "default" } });
  }

  console.log(JSON.stringify({
    ok: true,
    tenantA: { id: "default", ownerCookie: aOwner.cookie, warehouseCookie: aWarehouse.cookie, counts },
    tenantB: { id: "tenant-acme", ownerCookie: bOwner.cookie },
    login: "email owner.a@acceptance.test / owner.b@acceptance.test / wh.a@acceptance.test — password acceptance-Pass-123",
  }, null, 2));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
