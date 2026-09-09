# ADR 0031 — Delivery & sync UX fixes

## Status
Accepted (2026-09-09). Small, mostly-UX changes from live use; no new
data model beyond a data-only backfill.

## Changes

### 1. One-click « Synchroniser » on Commandes / Produits / Stock
`SyncRefreshButton` + `src/actions/sync.ts`
(`syncConnectedOrdersAction` / `syncConnectedProductsAction`). When the
user has `integrations.manage` and a WooCommerce/Shopify store is
CONNECTE, one click runs the relevant pull (orders, or products+stock)
for every connected platform and reloads the page. Otherwise it is a
plain `router.refresh()` labelled « Actualiser » — a confirmateur /
warehouse user still gets fresh webhook-imported data without a hard
reload. The per-platform sync buttons on `/integrations` are unchanged.

### 2. Country always defaults to Maroc
This deployment ships only within Morocco. `DEFAULT_SHIPPING_COUNTRY` +
`orderShippingCountry(order)` in `format.ts`. WooCommerce/Shopify
mappers normalise empty / `MA` / `Morocco` → `"Maroc"`;
`createOrderAction` defaults a blank country; the order detail no longer
shows "Pays : manquant". `requireAddress` (shipment creation) **no
longer requires country** — only address + city. Migration
`20260909190000_default_shipping_country` backfills existing rows.

### 3. Failed shipment-creation attempts are hidden
A `Shipment` row that never reached the carrier (`status: ECHEC` +
`externalId: null`) is a failed *attempt*, not a shipment.
`listShipments` and `getDeliveryStats` now exclude those (carrier-
reported ECHEC — which carries an `externalId` — still counts). The order
stays in « À expédier » (ECHEC was never an `ACTIVE_SHIPMENT_STATUS`), and
that row now shows the failure reason inline. On a later successful
creation, `createShipmentViaProvider` deletes the stale failed rows for
that order.

### 4. Fix-and-retry from the shipment error
`CreateShipmentDialog` takes `orderAddress`. When creation fails with an
address/city error it renders, in the same dialog, `EditShippingAddressDialog`
and (for API providers) `CityMappingDialog` — the operator fixes the city
or address and hits « Réessayer » without leaving. The « À expédier » row
carries the address through so this works there too.

### 5. Order name everywhere is the per-order recipient
`displayOrderRecipient` (ADR 0030) is now also used in the shipments
table and the « À expédier » table.

### 6. Order detail cards
Icon on every card title (Articles/Livraison/Client/Rentabilité/…) for
scannability. No structural change.

## Not changed (clarified instead)
- **Parcel "prix" 0 on OzonExpress for a bank-transfer order.** That's the
  COD amount — correctly 0 for a prepaid order. The 33 MAD in the
  Expéditions table is the carrier's *delivery fee* (`DELIVERED-PRICE`),
  a different figure. An order that should collect cash must be marked
  `PAIEMENT_LIVRAISON`.
