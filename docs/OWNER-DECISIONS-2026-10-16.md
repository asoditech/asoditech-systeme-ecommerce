# Owner decisions — 2026-10-16

Open business decisions found during the 2026-10-16 review (local build, not
committed / deployed). **Nothing below has been changed in code**: each item
keeps today's behaviour until the owner answers. Paths and line numbers were
checked against the working tree on 2026-10-16.

## 1. Carrier status mappings (all provisional, unchanged)

None of these meanings is confirmed by the carrier on a real account. The raw
carrier status is always stored; an unknown value maps to `null` (no guess).

| Carrier | Carrier status | Local status today | Evidence | Question for the owner |
|---|---|---|---|---|
| OzonExpress | « non livré », « échec de livraison » | `ECHEC` | `src/lib/integrations/delivery/providers/ozonexpress/mapper.ts:607-609` | Final failure, or an attempt before a redelivery? |
| OzonExpress | « refusé », « refus client », « colis refusé » | `ECHEC` | `ozonexpress/mapper.ts:610-613` | Is the failure fee or the return fee owed? A later `RETOURNE` keeps the `failureCost` already booked. |
| OzonExpress | « retourné », « retour », … | `RETOURNE` | `ozonexpress/mapper.ts:616-621` | A bare « retour » may mean a return still in progress, not arrived. |
| OzonExpress | « annulé » | `ANNULE` | `ozonexpress/mapper.ts:624-627` | Is a fee charged on an OzonExpress cancellation? |
| Sendit | `CANCELED` | `ECHEC` | `src/lib/integrations/delivery/providers/sendit/status.ts:63` | `ECHEC` or `ANNULE`? |
| Sendit | `REJECTED` | `ECHEC` | `sendit/status.ts:64` | Confirm. |
| Sendit | `UNREACHABLE` | `EN_TRANSIT` | `sendit/status.ts:61` | Confirm (customer unreachable, parcel still out). |
| Sendit | `POSTPONED` | `EN_TRANSIT` | `sendit/status.ts:60` | Confirm. |
| Sendit | `NEW_DESTINATION` | `EN_ATTENTE` | `sendit/status.ts:53` | `EN_TRANSIT → EN_ATTENTE` is an illegal local transition, so this status is refused once the parcel is in transit. Which local status? |
| Sendit | `status_return` = `RETURN_STOCK` / `RETURN_SELLER` | `RETOURNE` (takes precedence) | `sendit/status.ts:68,80` | Confirm these two mean « back with the merchant ». |
| Sendit | `status_return` = `RETOUR_PENDING` / `TORETURN` / `RETURN_WAREHOUSE` / `RETURN_TOCHECK` | ignored (main `status` decides) | `sendit/status.ts:40-47,80-81` | Should any of them show as « retour en cours »? |
| Ameex | `REFUSE`, `CANCELED`, `CANCELED_TEAM`, `DOESNT_ORDER`, `WRONG_NUMBER`, `OUT_OF_AREA` | `ECHEC` | `src/lib/integrations/delivery/providers/ameex/status.ts:111-116` | Final or interim? If a second parcel already exists for the order, a later `PREPAR_RETURN` / `RELAUNCH` on the first one is refused. |
| Ameex | `NO_ANSWER*`, `UNREACHABLE*`, `VOICEMAIL*`, `POSTPONED*` | `EN_TRANSIT` | `ameex/status.ts:93-101` | Confirm. |
| Ameex | `PREPAR_RETURN` | `EN_TRANSIT` | `ameex/status.ts:106` | Confirm (after an `ECHEC` it moves the parcel back to `EN_TRANSIT` until `RETURNED`). |
| Ameex | `DISPOSITION` | `EN_TRANSIT` | `ameex/status.ts:92` | Confirm. |
| Ameex | `RELAUNCH_NEW` | `EN_TRANSIT` | `ameex/status.ts:103` | The parcel goes to **another customer**: should the original order leave the parcel? |
| Ameex | `REFUNDED` | `null` (raw kept) | `ameex/status.ts:118` | COD remitted to the merchant, or customer refund? |
| Ameex | unknown sub-status under `IN_PROGRESS` | `null` | `ameex/status.ts:146-147` | Keep (never assume « en cours »)? |
| Aramex (legacy) | « delivery failed », « refused », « bad address », `SH234`, `SH029` | `ECHEC` | `src/lib/integrations/delivery/providers/aramex/mapper.ts:454-459,473-474` | Confirm. |
| Aramex (legacy) | « returned to shipper / origin », `SH033` | `RETOURNE` | `aramex/mapper.ts:460-462,475` | Confirm. |
| Aramex (legacy) | « cancelled » | `ANNULE` | `aramex/mapper.ts:463-464` | Confirm. |
| Aramex (legacy) | `SH001` / `SH014` / `SH005` / `SH006` | `EN_ATTENTE` / `EN_TRANSIT` / `EN_TRANSIT` / `LIVRE` | `aramex/mapper.ts:469-472` | Confirm. |

All Aramex rows are unconfirmed on a real account; Aramex is retired for new
connections (ADR 0060).

## 2. Other decisions

1. **A carrier `ECHEC` frees the order for a new parcel.** `ECHEC` is not an
   active shipment status (`ACTIVE_SHIPMENT_STATUSES`, `src/lib/delivery.ts:163`)
   and an order in `ECHEC` is shippable again (`SHIPPABLE_ORDER_STATUSES`,
   `src/lib/delivery.ts:151`). If the carrier's `ECHEC` is interim and the first
   parcel physically returns later, a second parcel may already have left:
   risk of double shipment / stock counted twice. Keep, or hold re-shipping
   until the first parcel is `RETOURNE` / received?
2. **`viewportFit: "cover"`.** The « Centre d'aide » button and the mobile
   sheet use `env(safe-area-inset-*)` (`src/components/support/support-widget.tsx:88,118`),
   but no `viewport` export sets `viewportFit: "cover"`, so on iOS the insets
   are 0 and the page is letter-boxed instead. Turning it on makes every
   full-bleed element responsible for its own insets. Enable it?
3. **`/platform` tables.** `/commandes`, `/livraison` and `/livraison/retours`
   now hide lower-priority columns on narrow screens; `/platform` tables still
   scroll horizontally (with the scroll hint). Hide columns there too, and which?
4. **Origin location of legacy parcels on `/livraison/retours`.** The column
   shows the order's single `fulfillmentWarehouse` (`src/lib/queries/return-receiving.ts:153`,
   `src/components/returns/return-parcels-table.tsx:166,176`); a legacy order
   without one shows « — » and is visible to OWNER/ADMIN only
   (`return-receiving.ts:21-23`). If its stock came from several locations,
   should the list show them all, or keep « — »?
5. **COD line on an order already paid.** The order page's « À encaisser »
   line (`src/lib/orders/cod-display.ts`) depends on the order status and the
   payment *method* only; a COD order whose payment is already `PAYE`
   (e.g. via the opt-in « livré = payé » rule) still shows its amount minus
   refunds. Show « Encaissé » for `PAYE` instead?
6. **WooCommerce vs Shopify archive asymmetry.** On a store-side deletion, an
   imported product is archived in ASODITECH — for Shopify only if Shopify
   does not show it still exists; the WooCommerce settings note now says so
   (`src/components/integrations/woocommerce-store-settings.tsx:155`).
   « Retirer de la boutique » sets WooCommerce to draft but Shopify to
   archived. Keep the asymmetry?
7. **Aramex `trackingSiteBaseUrl`.** The public tracking link opened by the
   operator is only `https:`-checked (`src/lib/integrations/delivery/providers/aramex/types.ts:140-144`,
   `aramex/mapper.ts:234-236`), not host-restricted like the API URLs.
   Restrict it to `www.aramex.com`?
8. **OzonExpress unclassified `RESULT:ERROR`.** An HTTP-200 `RESULT:ERROR`
   whose message matches no known case is treated as a definite failure
   (message shown redacted — `ozonexpress/client.ts:24-33,316`). Only the
   typed cases are documented by OzonExpress; should an unknown one on
   `add-parcel` become « à vérifier » instead?
9. **Test DB migration `20261016130000_whatsapp_outbox_runtime_grant`.** Not
   yet applied on the local TEST database (an equivalent manual grant is in
   place). Approve applying it there? (Preview / Production: see
   `docs/RELEASE-VERIFICATION-CHECKLIST.md` §0.)
10. **Cron scheduling + `CRON_SECRET`.** `GET|POST /api/cron/whatsapp-outbox`
    exists (`src/app/api/cron/whatsapp-outbox/route.ts`, Bearer `CRON_SECRET`),
    but `vercel.json` has no `crons` entry, so nothing calls it. Which
    schedule (Vercel plan limits apply), and set `CRON_SECRET` on Preview and
    Production?
11. **Generated barcode prefix `20` vs `04`.** ADR 0061 generates
    `20` + sequence + check digit (GS1 restricted circulation 20–29). The
    research note `docs/research/gs1-internal-barcode-prefix-2026-10-16.md`
    discusses the alternative. Keep `20`, or switch before any label is
    printed in production (changing later means two code families)?
12. **Order exchanges — D1 to D8.** The questions in
    `docs/research/morocco-order-exchange-2026-10-16.md` (§7, lines
    450-457): who pays transport per reason and leg (D1), allowed modes (D2),
    replacement price and discounts (D3), time limit and exclusions (D4),
    negative difference (D5), original item never returned (D6), KPI
    treatment (D7), which carriers to ask first and whether v1 stays manual
    (D8). Nothing is built until they are answered and frozen in an ADR
    (next number 0062).
