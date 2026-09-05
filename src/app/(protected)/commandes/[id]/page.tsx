import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { OrderStatusControl, OrderPaymentStatusControl } from "@/components/orders/order-status-control";
import { CancelOrderButton } from "@/components/orders/cancel-order-button";
import { RefundForm } from "@/components/orders/refund-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getOrderDetail, getOrderAuditTimeline } from "@/lib/queries/orders";
import { formatCurrency, formatDateTime, displayOrderNumber, displayOrderChannel } from "@/lib/format";
import { humanizeAuditAction } from "@/lib/audit-labels";
import {
  ORDER_STATUS_LABELS,
  ORDER_PAYMENT_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  SHIPMENT_STATUS_LABELS,
  REFUND_STATUS_LABELS,
} from "@/lib/status-labels";
import type { OrderStatusValue } from "@/lib/validation/order";

export default async function CommandeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("orders.view");
  const { id } = await params;
  const order = await getOrderDetail(id);
  if (!order) notFound();

  const timeline = await getOrderAuditTimeline(id);
  const canEdit = hasPermission(user.role, "orders.edit");
  const canCancel = hasPermission(user.role, "orders.cancel");
  const canRefund = hasPermission(user.role, "orders.refund");
  const refundedTotal = order.refunds.filter((r) => r.status === "COMPLETE").reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div>
      <PageHeader
        title={displayOrderNumber(order)}
        breadcrumbs={[{ label: "Commandes", href: "/commandes" }, { label: displayOrderNumber(order) }]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={order.status} labels={ORDER_STATUS_LABELS} />
            <OrderStatusControl orderId={order.id} currentStatus={order.status as OrderStatusValue} canEdit={canEdit} />
            {canCancel && !["ANNULEE", "REMBOURSEE"].includes(order.status) && (
              <CancelOrderButton orderId={order.id} />
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Articles</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produit</TableHead>
                    <TableHead>Prix</TableHead>
                    <TableHead>Qté</TableHead>
                    <TableHead>Remise</TableHead>
                    <TableHead>Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <p className="font-medium">{item.nameSnapshot}</p>
                        <p className="text-xs text-muted-foreground">{item.skuSnapshot}</p>
                      </TableCell>
                      <TableCell>{formatCurrency(item.unitPrice.toString(), order.currency)}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{formatCurrency(item.discount.toString(), order.currency)}</TableCell>
                      <TableCell>{formatCurrency(item.total.toString(), order.currency)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-4 ml-auto max-w-56 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Sous-total</span>
                  <span>{formatCurrency(order.subtotal.toString(), order.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Remise</span>
                  <span>-{formatCurrency(order.discountTotal.toString(), order.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Livraison</span>
                  <span>{formatCurrency(order.shippingCost.toString(), order.currency)}</span>
                </div>
                <div className="flex justify-between border-t pt-1 font-medium">
                  <span>Total</span>
                  <span>{formatCurrency(order.total.toString(), order.currency)}</span>
                </div>
                {refundedTotal > 0 && (
                  <div className="flex justify-between text-destructive">
                    <span>Remboursé</span>
                    <span>-{formatCurrency(refundedTotal, order.currency)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {order.notes && (
            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap">{order.notes}</CardContent>
            </Card>
          )}

          {canRefund && (order.status === "LIVREE" || order.status === "RETOUR" || order.refunds.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Remboursements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {order.refunds.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Montant</TableHead>
                        <TableHead>Motif</TableHead>
                        <TableHead>Statut</TableHead>
                        <TableHead>Date</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.refunds.map((r) => (
                        <TableRow key={r.id}>
                          <TableCell>{formatCurrency(r.amount.toString(), order.currency)}</TableCell>
                          <TableCell className="text-muted-foreground">{r.reason ?? "—"}</TableCell>
                          <TableCell>
                            <StatusBadge status={r.status} labels={REFUND_STATUS_LABELS} />
                          </TableCell>
                          <TableCell className="text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
                <RefundForm orderId={order.id} maxAmount={Number(order.total) - refundedTotal} />
              </CardContent>
            </Card>
          )}

          {order.shipments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Livraison</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Prestataire</TableHead>
                      <TableHead>Suivi</TableHead>
                      <TableHead>Statut</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.shipments.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>{s.provider.name}</TableCell>
                        <TableCell className="text-muted-foreground">{s.trackingNumber ?? "—"}</TableCell>
                        <TableCell>
                          <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Historique</CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">Aucun évènement enregistré.</p>
              ) : (
                <ul className="space-y-3">
                  {timeline.map((e) => (
                    <li key={e.id} className="text-sm">
                      <p>
                        <span className="font-medium">{e.actorUser?.name ?? "Système"}</span>{" "}
                        <span className="text-muted-foreground">— {humanizeAuditAction(e.action)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(e.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Client</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium">{order.customer.fullName}</p>
              {order.customer.phone && <p className="text-muted-foreground">{order.customer.phone}</p>}
              {order.customer.email && <p className="text-muted-foreground">{order.customer.email}</p>}
              <p className="border-t pt-2 text-muted-foreground">
                Canal : <span className="text-foreground">{displayOrderChannel(order)}</span>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Livraison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {order.shippingAddressLine1 ? (
                <>
                  <p>{order.shippingAddressLine1}</p>
                  {order.shippingAddressLine2 && <p>{order.shippingAddressLine2}</p>}
                  <p>
                    {order.shippingCity}
                    {order.shippingRegion ? `, ${order.shippingRegion}` : ""}
                  </p>
                  {order.shippingPhone && <p className="text-muted-foreground">{order.shippingPhone}</p>}
                </>
              ) : (
                <p className="text-muted-foreground">Aucune adresse renseignée.</p>
              )}
              {order.fulfillmentWarehouse && (
                <p className="border-t pt-2 text-muted-foreground">
                  Préparé depuis : <span className="text-foreground">{order.fulfillmentWarehouse.name}</span>
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Paiement</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</p>
              <OrderPaymentStatusControl orderId={order.id} currentPaymentStatus={order.paymentStatus} canEdit={canEdit} />
              {!canEdit && <Badge variant="secondary">{ORDER_PAYMENT_STATUS_LABELS[order.paymentStatus].label}</Badge>}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
