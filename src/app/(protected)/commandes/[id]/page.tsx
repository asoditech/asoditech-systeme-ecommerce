import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Package,
  StickyNote,
  Undo2,
  Truck,
  History,
  User,
  PhoneCall,
  TrendingUp,
  MapPin,
  CreditCard,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { OrderStatusControl, OrderPaymentStatusControl } from "@/components/orders/order-status-control";
import { CancelOrderButton } from "@/components/orders/cancel-order-button";
import { ReopenOrderButton } from "@/components/orders/reopen-order-button";
import { RefundForm } from "@/components/orders/refund-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { getOrderDetail, getOrderAuditTimeline } from "@/lib/queries/orders";
import { listShipmentProviderOptions } from "@/lib/queries/delivery";
import { buildParcelContentsSummary } from "@/lib/delivery";
import { LinkShipmentDialog } from "@/components/delivery/link-shipment-dialog";
import { EditShippingAddressDialog } from "@/components/orders/edit-shipping-address-dialog";
import { OverrideShipmentCostDialog } from "@/components/delivery/override-shipment-cost-dialog";
import { AssignAgentControl } from "@/components/commissions/assign-agent-control";
import { getOrderCommission, listAssignableCommissionAgents } from "@/lib/queries/commissions";
import { getOrderConfirmationAttempts } from "@/lib/queries/order-confirmation";
import { computeOrderProfit } from "@/lib/profitability";
import {
  formatCurrency,
  formatDateTime,
  displayOrderNumber,
  displayOrderChannel,
  displayOrderRecipient,
  orderShippingCountry,
} from "@/lib/format";
import { humanizeAuditAction } from "@/lib/audit-labels";
import { CONFIRMATION_OUTCOME_LABELS, SHIPMENT_COST_SOURCE_LABELS } from "@/lib/status-labels";
import {
  ORDER_STATUS_LABELS,
  ORDER_PAYMENT_STATUS_LABELS,
  PAYMENT_METHOD_LABELS,
  SHIPMENT_STATUS_LABELS,
  REFUND_STATUS_LABELS,
} from "@/lib/status-labels";
import type { OrderStatusValue } from "@/lib/validation/order";

function Row({
  label,
  value,
  muted,
  strong,
  warn,
  negative,
}: {
  label: string;
  value: string;
  muted?: boolean;
  strong?: boolean;
  warn?: boolean;
  negative?: boolean;
}) {
  return (
    <p className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={[
          strong ? "font-medium" : "",
          muted ? "text-muted-foreground" : "text-foreground",
          warn ? "text-amber-600 dark:text-amber-400" : "",
          negative ? "text-destructive" : "",
        ].join(" ")}
      >
        {value}
      </span>
    </p>
  );
}

export default async function CommandeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("orders.view");
  const { id } = await params;
  const order = await getOrderDetail(id);
  if (!order) notFound();

  const timeline = await getOrderAuditTimeline(id);
  const canEdit = hasPermission(user.role, "orders.edit");
  const canCancel = hasPermission(user.role, "orders.cancel");
  const canRefund = hasPermission(user.role, "orders.refund");
  const canManageDelivery = hasPermission(user.role, "delivery.manage");
  const canViewFinance = hasPermission(user.role, "finance.view");
  const canManageFinance = hasPermission(user.role, "finance.manage");
  const profit = canViewFinance
    ? computeOrderProfit({
        status: order.status,
        total: order.total,
        items: order.items,
        refunds: order.refunds,
        shipments: order.shipments,
      })
    : null;
  const canViewCommissions = hasPermission(user.role, "commissions.view");
  const canManageCommissions = hasPermission(user.role, "commissions.manage");
  const canConfirm = hasPermission(user.role, "orders.confirm");
  const [deliveryProviders, orderCommission, commissionAgents, confirmationAttempts] = await Promise.all([
    canManageDelivery ? listShipmentProviderOptions() : Promise.resolve([]),
    canViewCommissions ? getOrderCommission(order.id) : Promise.resolve(null),
    canManageCommissions ? listAssignableCommissionAgents() : Promise.resolve([]),
    canConfirm && order.confirmationAttemptCount > 0
      ? getOrderConfirmationAttempts(order.id)
      : Promise.resolve([]),
  ]);
  const parcelContents = buildParcelContentsSummary(order.items);
  const refundedTotal = order.refunds.filter((r) => r.status === "COMPLETE").reduce((s, r) => s + Number(r.amount), 0);
  const codAmount =
    order.paymentMethod === "PAIEMENT_LIVRAISON" ? Number(order.total) - refundedTotal : null;

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
            {(canEdit || canConfirm) && order.status === "ANNULEE" && order.shippedAt === null && (
              <ReopenOrderButton orderId={order.id} />
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Package className="size-4 text-muted-foreground" />Articles</CardTitle>
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
                  {order.items.map((item) => {
                    const productId = item.productId ?? item.variation?.productId ?? null;
                    return (
                    <TableRow key={item.id}>
                      <TableCell>
                        {productId ? (
                          <Link
                            href={`/produits/${productId}`}
                            className="font-medium hover:underline"
                          >
                            {item.nameSnapshot}
                          </Link>
                        ) : (
                          <p className="font-medium">{item.nameSnapshot}</p>
                        )}
                        <p className="text-xs text-muted-foreground">{item.skuSnapshot}</p>
                      </TableCell>
                      <TableCell>{formatCurrency(item.unitPrice.toString(), order.currency)}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{formatCurrency(item.discount.toString(), order.currency)}</TableCell>
                      <TableCell>{formatCurrency(item.total.toString(), order.currency)}</TableCell>
                    </TableRow>
                    );
                  })}
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
                <CardTitle className="flex items-center gap-2"><StickyNote className="size-4 text-muted-foreground" />Notes</CardTitle>
              </CardHeader>
              <CardContent className="text-sm whitespace-pre-wrap">{order.notes}</CardContent>
            </Card>
          )}

          {canRefund && (order.status === "LIVREE" || order.status === "RETOUR" || order.refunds.length > 0) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Undo2 className="size-4 text-muted-foreground" />Remboursements</CardTitle>
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

          {(order.shipments.length > 0 || canManageDelivery) && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Truck className="size-4 text-muted-foreground" />Livraison</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {order.shipments.length > 0 ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Prestataire</TableHead>
                        <TableHead>Suivi</TableHead>
                        <TableHead>Frais livraison</TableHead>
                        <TableHead>Statut</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {order.shipments.map((s) => (
                        <TableRow key={s.id}>
                          <TableCell>{s.provider.name}</TableCell>
                          <TableCell className="text-muted-foreground">{s.trackingNumber ?? "—"}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {s.cost !== null ? formatCurrency(s.cost.toString(), order.currency) : "— (inconnu)"}
                            {s.costSource ? (
                              <span className="block text-[11px] text-muted-foreground/70">
                                {SHIPMENT_COST_SOURCE_LABELS[s.costSource] ?? s.costSource}
                                {s.costFinalizedAt ? "" : " (estimation)"}
                              </span>
                            ) : null}
                            {s.providerStatusRaw ? (
                              <span className="block text-xs">Transporteur : {s.providerStatusRaw}</span>
                            ) : null}
                            {canManageFinance && (
                              <span className="mt-1 block">
                                <OverrideShipmentCostDialog shipmentId={s.id} currentCost={s.cost?.toString() ?? null} />
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={s.status} labels={SHIPMENT_STATUS_LABELS} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground">Aucune expédition enregistrée pour cette commande.</p>
                )}
                {codAmount !== null && (
                  <p className="text-sm text-muted-foreground">
                    À encaisser à la livraison (COD) :{" "}
                    <span className="text-foreground">{formatCurrency(String(codAmount), order.currency)}</span>
                  </p>
                )}
                {canManageDelivery && (
                  <LinkShipmentDialog
                    orderId={order.id}
                    providers={deliveryProviders}
                    defaultNotes={parcelContents || undefined}
                  />
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><History className="size-4 text-muted-foreground" />Historique</CardTitle>
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
              <CardTitle className="flex items-center gap-2"><User className="size-4 text-muted-foreground" />Client</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="font-medium">{displayOrderRecipient(order)}</p>
              {order.shippingName && order.shippingName.trim() !== order.customer.fullName && (
                <p className="text-xs text-muted-foreground">Compte client : {order.customer.fullName}</p>
              )}
              {(order.shippingPhone || order.customer.phone) && (
                <p className="text-muted-foreground">{order.shippingPhone ?? order.customer.phone}</p>
              )}
              {order.customer.email && <p className="text-muted-foreground">{order.customer.email}</p>}
              <p className="border-t pt-2 text-muted-foreground">
                Canal : <span className="text-foreground">{displayOrderChannel(order)}</span>
              </p>
            </CardContent>
          </Card>

          {canViewCommissions && orderCommission && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><PhoneCall className="size-4 text-muted-foreground" />Agent de confirmation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {canManageCommissions ? (
                  <AssignAgentControl
                    orderId={order.id}
                    currentAgentId={orderCommission.agentId}
                    agents={commissionAgents.map((a) => ({ id: a.id, name: a.name }))}
                    locked={orderCommission.hasEntries}
                  />
                ) : (
                  <p>
                    <span className="text-muted-foreground">Agent : </span>
                    {orderCommission.agentName ?? "—"}
                  </p>
                )}
                {orderCommission.hasEntries ? (
                  <p className={orderCommission.net > 0 ? "text-foreground" : "text-destructive"}>
                    Commission :{" "}
                    <span className="font-medium">{formatCurrency(String(orderCommission.net), order.currency)}</span>
                    {orderCommission.net <= 0 && " (reprise)"}
                  </p>
                ) : orderCommission.agentRate !== null ? (
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(String(orderCommission.agentRate), order.currency)} seront crédités à la livraison.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Aucun agent assigné.</p>
                )}
              </CardContent>
            </Card>
          )}

          {confirmationAttempts.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><PhoneCall className="size-4 text-muted-foreground" />Historique de confirmation</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <ul className="space-y-1.5">
                  {confirmationAttempts.map((a) => (
                    <li key={a.id} className="border-l-2 border-muted pl-3">
                      <span className="font-medium">{CONFIRMATION_OUTCOME_LABELS[a.outcome] ?? a.outcome}</span>
                      {a.agent?.name ? <span className="text-muted-foreground"> — {a.agent.name}</span> : null}
                      <span className="block text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                      {a.note ? <span className="block text-xs">« {a.note} »</span> : null}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {profit && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><TrendingUp className="size-4 text-muted-foreground" />Rentabilité</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {!profit.counted ? (
                  <p className="text-muted-foreground">
                    Commande {order.status.toLowerCase()} — non comptée dans le chiffre d&apos;affaires.
                  </p>
                ) : (
                  <>
                    <Row label="Chiffre d'affaires" value={formatCurrency(String(profit.revenue), order.currency)} />
                    {profit.refundsTotal > 0 && (
                      <Row label="Remboursé" value={`− ${formatCurrency(String(profit.refundsTotal), order.currency)}`} muted />
                    )}
                    <Row
                      label="Coût des marchandises"
                      value={profit.cogs === null ? "coût manquant" : formatCurrency(String(profit.cogs), order.currency)}
                      muted
                      warn={profit.cogs === null}
                    />
                    <Row
                      label="Bénéfice brut"
                      value={
                        profit.grossProfit === null
                          ? "—"
                          : `${formatCurrency(String(profit.grossProfit), order.currency)}${
                              profit.grossMarginPct !== null ? ` (${profit.grossMarginPct.toFixed(1)} %)` : ""
                            }`
                      }
                      strong
                      negative={profit.grossProfit !== null && profit.grossProfit < 0}
                    />
                    {profit.deliveryCost > 0 && (
                      <Row
                        label="Coût de livraison"
                        value={`− ${formatCurrency(String(profit.deliveryCost), order.currency)}`}
                        muted
                      />
                    )}
                    {profit.profitAfterDelivery !== null && (
                      <Row
                        label="Bénéfice après livraison"
                        value={formatCurrency(String(profit.profitAfterDelivery), order.currency)}
                        strong
                        negative={profit.profitAfterDelivery < 0}
                      />
                    )}
                    {profit.itemsMissingCost > 0 && (
                      <p className="border-t pt-2 text-xs text-amber-600 dark:text-amber-400">
                        {profit.itemsMissingCost} article(s) sans coût d&apos;achat renseigné — renseignez-le sur la fiche
                        produit pour un bénéfice exact.
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><MapPin className="size-4 text-muted-foreground" />Adresse de livraison</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {order.shippingAddressLine1 || order.shippingCity ? (
                <>
                  {order.shippingAddressLine1 && <p>{order.shippingAddressLine1}</p>}
                  {order.shippingAddressLine2 && <p>{order.shippingAddressLine2}</p>}
                  <p>
                    <span className="text-muted-foreground">Ville : </span>
                    <span className={order.shippingCity ? "font-medium" : "text-destructive"}>
                      {order.shippingCity ?? "manquante"}
                    </span>
                    {order.shippingRegion ? `, ${order.shippingRegion}` : ""}
                  </p>
                  <p>
                    <span className="text-muted-foreground">Pays : </span>
                    <span>{orderShippingCountry(order)}</span>
                  </p>
                  {order.shippingPhone && <p className="text-muted-foreground">{order.shippingPhone}</p>}
                </>
              ) : (
                <p className="text-destructive">Aucune adresse renseignée — à compléter avant l&apos;expédition.</p>
              )}
              {order.fulfillmentWarehouse && (
                <p className="border-t pt-2 text-muted-foreground">
                  Préparé depuis : <span className="text-foreground">{order.fulfillmentWarehouse.name}</span>
                </p>
              )}
              {canEdit && (
                <div className="pt-2">
                  <EditShippingAddressDialog
                    orderId={order.id}
                    address={{
                      shippingAddressLine1: order.shippingAddressLine1,
                      shippingAddressLine2: order.shippingAddressLine2,
                      shippingCity: order.shippingCity,
                      shippingRegion: order.shippingRegion,
                      shippingCountry: order.shippingCountry,
                      shippingPhone: order.shippingPhone,
                    }}
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><CreditCard className="size-4 text-muted-foreground" />Paiement</CardTitle>
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
