import "server-only";

import "./providers"; // populate the adapter registry
import { prisma } from "@/lib/prisma";
import type { Order, Prisma, Shipment, ShipmentStatus } from "@prisma/client";
import { loadApiProvider, friendlyDeliveryError, syncShipmentStatus } from "./service";
import { normalizeTrackingStatus, type NormalizedTrackingStatus } from "@/lib/tracking/status";
import type { AdapterTrackingEvent } from "./types";

/**
 * « Suivi » module tracking service (docs/adr/0033). Entirely separate
 * from the existing delivery `service.ts` flows — it only *reads* through
 * the shared `loadApiProvider` + reuses `syncShipmentStatus` (so status
 * stays consistent, no duplicated status logic) and then layers the new
 * `FETCH_TRACKING` event/courier read on top.
 *
 * Nothing here writes to a field the old delivery code reads.
 */

/** One persisted, normalized tracking event (`Shipment.trackingEvents`). */
export interface StoredTrackingEvent {
  rawStatus: string;
  code: NormalizedTrackingStatus;
  label: string | null;
  description: string | null;
  location: string | null;
  timestamp: string | null;
}

export type RefreshTrackingOutcome =
  | { ok: true; statusOutcome: string; eventsFetched: boolean; eventCount: number }
  | { ok: false; error: string };

/**
 * Refreshes ONE shipment's tracking:
 *  1. run the existing `syncShipmentStatus` — keeps status + cost correct,
 *     with all its own "never invent / keep last known" safety.
 *  2. if the provider declares FETCH_TRACKING, pull the event history +
 *     courier + location and persist them. On failure here, the status
 *     from step 1 still stands and the previously-stored events are kept —
 *     only `trackingSyncError` + `lastTrackingSyncAt` change (§16).
 *
 * A shipment with no `externalId` (manual provider) is not refreshable —
 * returns ok:false with a clear message.
 */
/**
 * Courier columns to write after a successful tracking fetch. A carrier only
 * names the courier in some responses, so a response without a courier
 * keeps what is stored — nothing is ever wiped by an empty answer, nothing
 * is invented. But the name and phone describe ONE person:
 *   - a DIFFERENT courier name replaces name AND phone together (the phone
 *     is cleared when the new response has none — never the previous
 *     courier's number next to the new courier's name);
 *   - the same courier (or no name) only refreshes the phone when one is sent.
 */
export function courierUpdateData(
  courier: { name: string | null; phone: string | null } | null | undefined,
  stored: { courierName: string | null; courierPhone: string | null }
): { courierName?: string; courierPhone?: string | null } {
  const name = courier?.name?.trim() || null;
  const phone = courier?.phone?.trim() || null;
  const sameCourier = name !== null && name.toLocaleLowerCase("fr") === (stored.courierName?.trim() ?? "").toLocaleLowerCase("fr");
  if (name !== null && !sameCourier) return { courierName: name, courierPhone: phone };
  return phone !== null ? { courierPhone: phone } : {};
}

export async function refreshShipmentTracking(params: {
  shipment: Shipment;
  order: Order;
  updatedById: string | null;
}): Promise<RefreshTrackingOutcome> {
  const { shipment, order, updatedById } = params;
  if (!shipment.externalId) {
    return { ok: false, error: "Cette expédition n'a pas été créée via un connecteur API." };
  }

  // 1 — reuse the existing status sync verbatim.
  const statusResult = await syncShipmentStatus({ shipment, order, updatedById });
  if (statusResult.outcome === "error") {
    // Keep last-known everything; just record that the sync failed.
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { lastTrackingSyncAt: new Date(), trackingSyncError: statusResult.error },
    });
    return { ok: false, error: statusResult.error };
  }

  // 2 — richer tracking detail, best-effort.
  let adapter, credentials, config;
  try {
    ({ adapter, credentials, config } = await loadApiProvider(shipment.providerId));
  } catch {
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { lastTrackingSyncAt: new Date() },
    });
    return { ok: true, statusOutcome: statusResult.outcome, eventsFetched: false, eventCount: 0 };
  }

  if (!adapter.capabilities.includes("FETCH_TRACKING") || !adapter.fetchTracking) {
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { lastTrackingSyncAt: new Date(), trackingSyncError: null },
    });
    return { ok: true, statusOutcome: statusResult.outcome, eventsFetched: false, eventCount: 0 };
  }

  // The status we just synced (re-read — syncShipmentStatus may have moved it).
  const fresh = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });

  try {
    const detail = await adapter.fetchTracking({ externalId: shipment.externalId }, credentials, config);
    const events = normalizeAdapterEvents(detail.events, fresh.status);
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        trackingEvents: events as unknown as Prisma.InputJsonValue,
        ...courierUpdateData(detail.courier, fresh),
        lastTrackingSyncAt: new Date(),
        trackingSyncError: null,
      },
    });
    return { ok: true, statusOutcome: statusResult.outcome, eventsFetched: true, eventCount: events.length };
  } catch (err) {
    // §16 — a FETCH_TRACKING failure must NOT wipe events or change status.
    await prisma.shipment.update({
      where: { id: shipment.id },
      data: { lastTrackingSyncAt: new Date(), trackingSyncError: friendlyDeliveryError(err) },
    });
    return { ok: true, statusOutcome: statusResult.outcome, eventsFetched: false, eventCount: 0 };
  }
}

/** Attaches the normalized status code to each carrier event. The per-
 * event code is derived from its own raw string against the local status
 * only as a coarse hint — a non-terminal local status keeps the refined
 * bucket; a terminal one still shows the real carrier wording per event. */
function normalizeAdapterEvents(events: AdapterTrackingEvent[], localStatus: ShipmentStatus): StoredTrackingEvent[] {
  // For per-event coding, treat the shipment as in-transit so the event's
  // own raw keywords drive its label (a mid-flight "picked up" event must
  // not be relabelled "delivered" just because the parcel is now
  // delivered). The row-level status still uses the true local status.
  const isTerminal = localStatus === "LIVRE" || localStatus === "ECHEC" || localStatus === "RETOURNE" || localStatus === "ANNULE";
  return events.map((e) => ({
    rawStatus: e.rawStatus,
    code: normalizeTrackingStatus(isTerminal ? "EN_TRANSIT" : localStatus, e.rawStatus),
    label: e.label,
    description: e.description,
    location: e.location,
    timestamp: e.timestamp,
  }));
}
