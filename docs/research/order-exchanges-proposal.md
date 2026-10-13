# Order exchanges (« Échange ») — decision required

**Status (2026-10-12): NOT implemented.** The 2026-10-12 audit searched the
schema, `src/`, `tests/`, `docs/` and git history: there is no exchange model,
enum value, action, UI, hidden page or feature flag — nothing to restore.
The only prior work is research (`docs/research/carrier-exchange-capabilities.md`)
and the design below.

Why it was not built in the 2026-10-12 batch: an exchange touches money
(price difference, who pays the second shipping), stock (a replacement leaves,
the original comes back) and carrier integrations (no carrier exchange or
return-pickup API is confirmed — both UNKNOWN). The design needs a dedicated
migration (two tables, an enum value in its own migration) and these
business decisions first:

1. Who pays the replacement shipping by reason (customer choice vs store error)?
2. Price difference: collect a positive difference as COD on the replacement
   parcel? Refund a negative one through the existing Refund flow?
3. Does a replacement count in delivery-rate / order-count KPIs? (proposal: no)
4. Commission: an exchange never re-earns or reverses the confirmation
   commission? (proposal: never)
5. v1 manual for both carriers (normal forward parcel + note), automation only
   once a carrier confirms an exchange / return-pickup service?

Today's supported path without an exchange model: record the returned items
with the existing physical return / returns workspace (stock back exactly once
after inspection), and create a new order for the replacement.

---

## 1. What the adapters implement today

Capability model: `src/lib/integrations/delivery/types.ts:20-48`
(`CREATE_SHIPMENT | CANCEL_SHIPMENT | FETCH_STATUS | FETCH_COST | WEBHOOKS |
FETCH_CITIES | GENERATE_MANIFEST | FETCH_TRACKING`). Capabilities are declared
explicitly and enforced by `assertCapability` (`registry.ts:58`). Reverse or
exchange capabilities do not exist in the model.

| Function | OzonExpress (`providers/ozonexpress/adapter.ts`) | Aramex (`providers/aramex/adapter.ts`) |
|---|---|---|
| Declared capabilities | `:130-137` CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_COST, FETCH_CITIES, GENERATE_MANIFEST | `:116` CREATE_SHIPMENT, FETCH_STATUS, FETCH_TRACKING, FETCH_COST |
| Create parcel | `createShipment` `:197` (`add-parcel`; COD = `parcel-price`, `mapper.ts:216`; free note `parcel-note` `:226`) | `createShipment` `:192` (`CreateShipments`; `Reference1`/`ForeignHAWB` `mapper.ts:134-135`; `CashOnDeliveryAmount` `:152`) |
| Cancel | Not declared. ADR 0013:57 says "no cancellation endpoint is known" | Not declared. ADR 0028:69 says cancel is pickup-scoped (`CancelPickup`) |
| Status / tracking | `fetchStatus` `:232`, `fetchTracking` `:253` | `fetchStatus` `:231`, `fetchTracking` `:251` (`TrackShipments`) |
| Labels | Through the manifest only: `generateManifest` `:276`, BL / A4 / 10×10 PDF URLs (`mapper.ts:319-336`) | `LabelInfo` is requested (`mapper.ts:166`). `LabelURL` is parsed (`mapper.ts:220`) and then thrown away, never stored |
| Return pickup | None | None (`CreatePickup` exists in Aramex sample code but is not wired in) |
| Exchange | None | None |
| Live verification | `TRACKING_LIVE_VERIFIED` (`:85`): tracking and `/cities` tested against a real account on 2026-09-01. `add-parcel` not live-tested | `NOT_LIVE_TESTED` (`:69`) |

## 2. Carrier capability matrix (evidence-graded)

Grades: **DOC** = public or official documentation (URL given); **ACCT** =
evidence in the repo from a real account; **ADAPTER** = inferred from adapter
code or official sample code; **UNKNOWN** = no evidence. UNKNOWN does not
mean impossible.

| Capability | OzonExpress | Aramex |
|---|---|---|
| Create forward parcel | ADAPTER (owner-supplied endpoints; not live-tested) | ADAPTER (official PHP sample code); DOC: the Shipping Services API is described as "create shipments, print labels, request pickup" (aramex.com developers centre) |
| Tracking | **ACCT** (live 2026-09-01, `adapter.ts:74-85`) | ADAPTER (`TrackShipments`, WSDL in `aramex/`) |
| Cancel created parcel | UNKNOWN (none known, ADR 0013) | ADAPTER: pickup-scoped only. A third-party SDK says CancelPickup works "as long as it is un-assigned or pending" (packalyst omar-ehab/laravel-aramex). Cancelling a single AWB: UNKNOWN |
| Labels | ADAPTER (manifest PDFs; not live-tested) | ADAPTER (`PrintLabel` in sample code; `LabelURL` in response) |
| Return pickup at the customer | UNKNOWN | UNKNOWN (`CreatePickup` exists; whether it can collect from the consignee with a return AWB is undocumented in the sources we could read) |
| Exchange (deliver and collect in one visit) | UNKNOWN | UNKNOWN (no exchange ProductType seen in samples; no public "RTC"-type code confirmed) |
| COD on the replacement leg | ADAPTER (`parcel-price` takes any amount) | ADAPTER (`CashOnDeliveryAmount`) |
| COD / collection on a return leg | UNKNOWN | UNKNOWN |
| Merchant reference to link legs | ADAPTER (free `parcel-note` only; OzonExpress assigns its own tracking number, `mapper.ts:195`) | ADAPTER (`Reference1`, `Reference2`, `ForeignHAWB`) |
| Settlement of two legs | UNKNOWN | UNKNOWN |

Web research on 2026-10-10:
- OzonExpress has no public API documentation. ozonexpress.ma is a client-rendered page with no readable service text. The only public third-party integration found (eGrow, https://help2.egrow.com/en/article/how-to-integrate-ozon-express-with-egrow) mentions only "send orders" and "track".
- The official Aramex manual (https://www.aramex.com/docs/default-source/resourses/resourcesdata/shipping-services-api-manual.pdf and the /content/uploads/ mirror) returns HTTP 403 to automated fetches. Its table of contents, seen through search, lists Pickup Creation and Pickup Cancellation methods only. Someone should read it manually.

Nothing in the repo shows a real exchange or return-pickup API response from either carrier. No ACCT entries exist beyond OzonExpress tracking.

## 3. Proposed model

### 3.1 Opt-in
`BusinessSettings.exchangesEnabled Boolean @default(false)`. It follows the
existing feature flags `allowSellerPriceOverride` and
`packingVerificationRequired` (`prisma/schema.prisma:2812-2825`). When it is
off, no UI, action or query path changes.

### 3.2 `OrderExchange` (attached to the ORIGINAL order; never a second Order)
- `id, tenantId, orderId (Restrict), status`
- `status`: `OUVERT → REMPLACEMENT_EXPEDIE → RETOUR_RECU → CLOTURE | ANNULE`
- `reason`: `CHOIX_CLIENT | ERREUR_BOUTIQUE`
- `priceDifference` (signed Decimal), `shippingPaidBy` (`CLIENT | BOUTIQUE`)
- `replacementShipmentId` (nullable, unique)
- `createdById`, `note`, timestamps

`OrderExchangeLine`:
- `orderItemId` (the item being returned) and `returnQuantity`
- replacement `productId / variationId`, `replacementQuantity`, and name/SKU snapshots, following the `OrderReturnLine` convention
- `warehouseId` (the source of the replacement stock)

### 3.3 Replacement shipment: reuse `Shipment`
Add a nullable `Shipment.exchangeId`. Today `Shipment` is only `@@index([orderId])`
with no uniqueness, so several shipments per order are already allowed
(`schema.prisma`, Shipment model ~`:2278-2316`). The replacement is an
ordinary shipment on the original `orderId` with `exchangeId` set, and its
COD is `max(priceDifference, 0)`.

**Required guard.** `applyShipmentStatusTransition`
(`src/lib/delivery.ts:196`) changes the order's status and runs the one-time
`fulfillStockForOrder` deduction (`:304-313`). It also blocks re-shipping
after a return with `RESHIP_AFTER_RETURN_MESSAGE` (`:31`, `:306`). Both must
be skipped when `shipment.exchangeId` is set. Otherwise the replacement
parcel would re-drive the original order (EXPEDIEE, LIVREE, RETOUR) or be
blocked by its own exchange. Its status changes only the `OrderExchange`.

### 3.4 Stock without double counting
Today's ledger:
- `applyStockMovement` (`src/lib/inventory.ts:152`), types `InventoryMovementType` (`schema.prisma:1285`)
- order lifecycle: `reserveStockForOrder` RESERVATION (`inventory.ts:442/449`), `fulfillStockForOrder` VENTE (`:530/531`), `releaseStockForOrder` LIBERATION (`:535`)
- returns: `applyPhysicalReturnLine` RETOUR / ENDOMMAGE (`:579`), called by `recordPhysicalReturn` (`src/lib/returns/physical-return.ts:88`) under an order row lock, idempotency key, and a per-item ceiling of "shipped minus already returned" (`:116-133`)

Proposal:
- **Outbound replacement.** One new movement type, `ECHANGE_SORTIE`, plus a nullable `InventoryMovement.orderExchangeId`, written once when the replacement shipment first moves. It is idempotent: it checks for an existing movement with that `orderExchangeId`. The order's VENTE is never re-run.
  - Optional: a reservation at exchange creation using the existing RESERVATION/LIBERATION pair, scoped by `orderExchangeId`.
- **Inbound returned item.** No new type. It goes through `recordPhysicalReturn` and writes RETOUR (sellable) or ENDOMMAGE (damaged). The existing ceiling keys on original order items, which are exactly the items being exchanged, so double restocking is already impossible.
- Each unit therefore moves exactly once in each direction:
  - VENTE: original out
  - RETOUR / ENDOMMAGE: original back
  - ECHANGE_SORTIE: replacement out
- If the replacement itself comes back, it needs its own inspection path keyed to the exchange line (§3.5). It must not be counted against the original order item's ceiling.

### 3.5 Reception and inspection via `/livraison/retours`
Today `receiveReturnParcel` (`src/lib/returns/reception.ts:69`) accepts only a
shipment with `status === RETURN_ELIGIBLE_SHIPMENT_STATUS` (`"RETOURNE"`,
`src/lib/queries/return-receiving.ts:26`). An exchanged item, however,
usually comes back on the replacement leg's visit (DELIVERED) or by a manual
drop-off. It does not come back on a returned original parcel.

Proposal: a `ReturnReception` may also be opened for an `OrderExchange` in
status `REMPLACEMENT_EXPEDIE`. This adds a nullable
`ReturnReception.orderExchangeId`, and eligibility becomes "RETOURNE shipment
OR open exchange". Everything else stays the same:
- the warehouse is resolved server-side, with `hasLocationAccess`
- the two stages are A_INSPECTER → INSPECTE
- inspection still calls `inspectReturnReception` (`:194`) and `recordPhysicalReturn`
- the "one pending reception per shipment" partial unique index needs a matching rule per exchange

When inspection completes, the exchange moves to `RETOUR_RECU`.

### 3.6 Money
- The original order's revenue is untouched.
- A positive `priceDifference` is collected as COD on the replacement shipment.
- A negative one creates a `Refund` row (`schema.prisma:1852`), using the existing `orders.refund` flow.
- Exchange shipments count as costs in finance: `Shipment.cost` is already frozen per shipment.
- Exchange shipments are excluded from order counts and delivery-rate KPIs.
- `ERREUR_BOUTIQUE` exchanges are flagged for picking-error analytics.

### 3.7 Audit
Every transition calls `recordAuditEvent` (`src/lib/audit`, as used in
`reception.ts:155,329`):
- `entityType: "OrderExchange"`
- `metadata.orderId`, so the events show in the original order's history
- actions: `exchange.created`, `.replacement_shipped`, `.return_received`, `.closed`, `.cancelled`, `.refund_issued`

Movements are traceable through `orderExchangeId`, and the inspection goes
through `orderReturnId`.

### 3.8 Permissions (`src/lib/auth/permissions.ts`)
- Add `orders.exchange` (create, cancel, close) with channel domain ONLINE (`:144` map). Grant it where `orders.return` is granted (`:188`).
- Shipment creation still requires `delivery.manage` (`:77`).
- Reception and inspection keep `orders.return`, which is the gate in `src/actions/returns.ts:53,147`.
- The refund leg keeps `orders.refund`.

## 4. Carrier-supported vs manual fallback
**v1 is manual for both carriers.** The replacement is a normal forward
parcel through the existing `createShipment`.
- OzonExpress: `parcel-note` = "ÉCHANGE CMD-xxxx — récupérer: <article>".
- Aramex: the same note plus `Reference2` / `ForeignHAWB` = exchange id.

The courier collects the old item on a best-effort basis, or the customer
returns it themselves. Staff record arrival through the reception flow.

Automation comes later and only when a carrier confirms a feature:
- a new capability such as `CREATE_EXCHANGE` / `CREATE_RETURN_PICKUP`, added with its method, action and UI together, as the `types.ts:51-56` rule requires
- this happens only after the account managers answer the six questions in `docs/research/carrier-exchange-capabilities.md`
- before that, someone should manually read the Aramex PDF (403 to bots) for return ProductType codes

## 5. Migration and rollout risks
- **Additive migration.** It adds two tables, nullable `Shipment.exchangeId`, `InventoryMovement.orderExchangeId`, `ReturnReception.orderExchangeId`, a defaulted `BusinessSettings.exchangesEnabled`, and the enum value `ECHANGE_SORTIE`.
  - Postgres `ALTER TYPE … ADD VALUE` cannot run inside the same transaction that uses the new value. Keep it in its own migration.
  - Memory: the Preview env has pointed at the prod DB before, so pushing a branch can run `migrate deploy`. Confirm where the DB points before pushing.
- **Runtime-role grants.** New tables need the grants checked by `scripts/prod-check-runtime-role.sql`. The P3 returns migration had the same open item.
- **Order-status regression.** The §3.3 guard is the main correctness risk. It needs tests showing that an exchange shipment never changes `Order.status` or writes VENTE.
- **Analytics leakage.** Every report that counts shipments per order needs an `exchangeId IS NULL` filter: delivery rate, Suivi, invoices, carrier factures, commission.
- **Commission.** An exchange must not re-earn or reverse a confirmation commission (ADR 0022).
- **Carrier semantics.** A replacement parcel the carrier marks RETOURNE (customer refused) needs its own reception path (§3.4). Without it, the replacement units disappear from stock.
- **Rollout.**
  - The flag is off by default.
  - Enable it for one tenant, using a manual-provider (MANUEL) shipment first.
  - Then use OzonExpress with a note.
  - Automate only once carrier answers are on file.
