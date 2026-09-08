import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrintButton } from "@/components/reports/print-button";
import { requirePermission } from "@/lib/auth/guards";
import { getDeliveryInvoiceData } from "@/lib/queries/delivery-invoice";
import { formatCurrency, formatDate, displayOrderNumber } from "@/lib/format";
import { PAYMENT_METHOD_LABELS, ORDER_PAYMENT_STATUS_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Facture de livraison — ASODITECH Gestion E-commerce" };

export default async function FactureLivraisonPage({
  params,
}: {
  params: Promise<{ shipmentId: string }>;
}) {
  await requirePermission("delivery.view");
  const { shipmentId } = await params;
  const data = await getDeliveryInvoiceData(shipmentId);
  if (!data) notFound();

  const { shipment, settings } = data;
  const order = shipment.order;
  const currency = order.currency;
  const money = (v: unknown) => formatCurrency(String(v ?? 0), currency);

  const codDue = order.paymentStatus !== "PAYE" ? Number(order.total) : 0;
  const invoiceRef = `FL-${displayOrderNumber(order).replace(/^#/, "")}`;

  const addressLines = [
    order.shippingAddressLine1,
    order.shippingAddressLine2,
    [order.shippingCity, order.shippingRegion].filter(Boolean).join(", "),
    order.shippingCountry,
  ].filter(Boolean);

  return (
    <div>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Button variant="ghost" size="sm" render={<Link href="/livraison/factures" />}>
          <ArrowLeft className="size-4" />
          Retour
        </Button>
        <PrintButton label="Imprimer / PDF" />
      </div>

      <div
        data-print-sheet
        className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 shadow-sm dark:bg-white"
      >
        <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-5">
          <div>
            {settings.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={settings.logoUrl} alt={settings.companyName || "Logo"} className="mb-2 h-12 w-auto object-contain" />
            ) : null}
            <p className="text-lg font-semibold">{settings.companyName || "—"}</p>
            {settings.address && <p>{settings.address}</p>}
            <p>{[settings.city, settings.country].filter(Boolean).join(", ")}</p>
            {settings.phone && <p>Tél. {settings.phone}</p>}
            {settings.email && <p>{settings.email}</p>}
          </div>
          <div className="text-right">
            <p className="text-base font-semibold uppercase tracking-wide">Facture de livraison</p>
            <p className="text-slate-600">{invoiceRef}</p>
            <p className="text-slate-600">Émise le {formatDate(new Date())}</p>
            <p className="mt-1">Commande {displayOrderNumber(order)}</p>
            <p className="text-slate-600">Passée le {formatDate(order.placedAt)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6 py-5">
          <div>
            <p className="mb-1 font-medium text-slate-500">Destinataire</p>
            <p className="font-medium">{order.customer.fullName}</p>
            {addressLines.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
            {(order.shippingPhone || order.customer.phone) && (
              <p>Tél. {order.shippingPhone ?? order.customer.phone}</p>
            )}
          </div>
          <div>
            <p className="mb-1 font-medium text-slate-500">Expédition</p>
            <p>Transporteur : {shipment.provider?.name ?? "—"}</p>
            {shipment.trackingNumber && <p>Suivi : {shipment.trackingNumber}</p>}
            <p>Mode de paiement : {PAYMENT_METHOD_LABELS[order.paymentMethod] ?? order.paymentMethod}</p>
            <p>Paiement : {ORDER_PAYMENT_STATUS_LABELS[order.paymentStatus]?.label ?? order.paymentStatus}</p>
            {shipment.cost != null && <p>Frais transporteur : {money(shipment.cost)}</p>}
          </div>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-slate-200 text-left text-slate-500">
              <th className="py-2">Article</th>
              <th className="py-2 text-right">PU</th>
              <th className="py-2 text-right">Qté</th>
              <th className="py-2 text-right">Remise</th>
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {order.items.map((it, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-2">
                  {it.nameSnapshot}
                  <span className="block text-xs text-slate-500">{it.skuSnapshot}</span>
                </td>
                <td className="py-2 text-right tabular-nums">{money(it.unitPrice)}</td>
                <td className="py-2 text-right tabular-nums">{it.quantity}</td>
                <td className="py-2 text-right tabular-nums">{Number(it.discount) > 0 ? `−${money(it.discount)}` : "—"}</td>
                <td className="py-2 text-right tabular-nums">{money(it.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto mt-4 w-64 space-y-1">
          <div className="flex justify-between"><span className="text-slate-500">Sous-total</span><span className="tabular-nums">{money(order.subtotal)}</span></div>
          {Number(order.discountTotal) > 0 && (
            <div className="flex justify-between"><span className="text-slate-500">Remise</span><span className="tabular-nums">−{money(order.discountTotal)}</span></div>
          )}
          <div className="flex justify-between"><span className="text-slate-500">Livraison</span><span className="tabular-nums">{money(order.shippingCost)}</span></div>
          <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold">
            <span>Total</span><span className="tabular-nums">{money(order.total)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-300 pt-1 font-semibold">
            <span>Montant à encaisser</span>
            <span className="tabular-nums">{money(codDue)}</span>
          </div>
        </div>

        {order.notes && (
          <div className="mt-5 border-t border-slate-200 pt-3 text-slate-600">
            <p className="font-medium text-slate-500">Note</p>
            <p>{order.notes}</p>
          </div>
        )}

        <p className="mt-8 border-t border-slate-200 pt-3 text-center text-xs text-slate-400">
          {settings.companyName || "ASODITECH"} — document généré le {formatDate(new Date())}
        </p>
      </div>
    </div>
  );
}
