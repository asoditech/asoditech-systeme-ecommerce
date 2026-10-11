import { ACTIVE_SHIPMENT_STATUSES } from "@/lib/delivery";
import type { ShipmentStatusValue } from "@/lib/validation/delivery";

/**
 * Presentation rules for the order page's « Informations de livraison »
 * (src/components/orders/order-delivery-info.tsx). Pure — reads the shipment
 * rows getOrderDetail already loaded, never writes, never derives a status.
 */

export interface ShipmentForSelection {
  id: string;
  status: ShipmentStatusValue;
  createdAt: Date;
}

/** Statuses a shipment ends in without being delivered. */
const CLOSED_UNDELIVERED: ShipmentStatusValue[] = ["ECHEC", "ANNULE", "RETOURNE"];

function newestFirst<S extends ShipmentForSelection>(a: S, b: S): number {
  const byDate = b.createdAt.getTime() - a.createdAt.getTime();
  return byDate !== 0 ? byDate : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The shipment to present first — there is no "current shipment" column, so
 * this is a display rule only:
 *   1. the newest one still in progress (EN_ATTENTE / EN_TRANSIT);
 *   2. else the newest one not failed / cancelled / returned (e.g. LIVRE);
 *   3. else the newest one.
 * Every other shipment is returned in `previous`, newest first — history is
 * never dropped.
 */
export function splitShipmentsForDisplay<S extends ShipmentForSelection>(
  shipments: readonly S[]
): { primary: S | null; previous: S[] } {
  const sorted = [...shipments].sort(newestFirst);
  const primary =
    sorted.find((s) => ACTIVE_SHIPMENT_STATUSES.includes(s.status)) ??
    sorted.find((s) => !CLOSED_UNDELIVERED.includes(s.status)) ??
    sorted[0] ??
    null;
  return { primary, previous: primary ? sorted.filter((s) => s.id !== primary.id) : [] };
}

/**
 * A carrier tracking page we're willing to link to: an absolute http(s) URL
 * with a host and no embedded credentials or control characters. Anything
 * else (javascript:, data:, relative paths…) → null, shown as plain text.
 */
export function safeTrackingUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? "").trim();
  if (!url || url.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.toString();
}

/**
 * The carrier's own shipment id, only when it says something the tracking
 * number doesn't (today both connectors store the same value in both).
 */
export function carrierReference(externalId: string | null, trackingNumber: string | null): string | null {
  const ref = externalId?.trim();
  if (!ref) return null;
  return ref.toLowerCase() === (trackingNumber ?? "").trim().toLowerCase() ? null : ref;
}

export interface LastTrackingEvent {
  label: string;
  location: string | null;
  timestamp: string | null;
}

/**
 * The last event of the stored carrier history (Shipment.trackingEvents, an
 * array written by the « Suivi » refresh). Defensive: a malformed row yields
 * null rather than a fabricated event.
 */
export function lastTrackingEvent(raw: unknown): LastTrackingEvent | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const e = raw[raw.length - 1] as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return null;
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const label = text(e.label) ?? text(e.rawStatus);
  if (!label) return null;
  return { label, location: text(e.location), timestamp: text(e.timestamp) };
}

/** API-connected (a real carrier shipment id is on file) vs entered by hand. */
export function shipmentConnectionLabel(providerType: string, externalId: string | null): string {
  if (providerType === "API") return externalId ? "Connecté (API)" : "API — non créée chez le transporteur";
  return providerType === "FLOTTE_INTERNE" ? "Flotte interne" : "Manuel";
}
