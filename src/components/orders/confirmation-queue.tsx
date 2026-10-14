"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Phone, PhoneOff, Check, X, RotateCcw, MapPin, Package, Clock, TriangleAlert } from "lucide-react";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CONFIRMATION_OUTCOME_LABELS as OUTCOME_LABELS } from "@/lib/status-labels";
import { buildCustomerWhatsAppUrl } from "@/lib/whatsapp";
import { StockOverrideDialog } from "@/components/orders/stock-override-dialog";
import { stockShortageOf, type StockShortage } from "@/lib/stock-shortage";

export interface ConfirmationQueueOrder {
  id: string;
  displayNumber: string;
  customerName: string;
  customerPhone: string | null;
  customerWhatsapp: string | null;
  city: string | null;
  total: string;
  currency: string;
  placedAt: string;
  itemCount: number;
  attemptCount: number;
  flagged: boolean;
  /** At least one line requests more than is available at the order's
   * fulfilment warehouse — since P2 confirming is refused unless an
   * authorised user overrides it. */
  stockWarning: boolean;
  /** P2 — at least one line has no stock row there, or its product's stock
   * tracking is off: « Stock non suivi » (never blocks). */
  stockUntracked: boolean;
  recentAttempts: { outcome: string; agentName: string | null; createdAt: string }[];
}

const NO_ANSWER_OUTCOMES = ["PAS_DE_REPONSE", "OCCUPE", "RAPPELER", "FAUX_NUMERO"] as const;

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} fill="currentColor" aria-hidden="true">
      <path d="M16.001 7C11.03 7 7 11.03 7 16c0 1.77.51 3.42 1.4 4.81L7.6 24.4l3.68-.97a8.96 8.96 0 004.72 1.34c4.97 0 9-4.03 9-9s-4.03-9-9-9zm5.2 12.79c-.22.61-1.08 1.12-1.77 1.27-.47.1-1.09.18-3.17-.68-2.66-1.1-4.37-3.78-4.5-3.96-.13-.18-1.08-1.43-1.08-2.73 0-1.29.68-1.93.92-2.19.24-.26.53-.33.7-.33l.5.01c.16 0 .38-.06.59.45.22.53.74 1.82.8 1.95.07.14.11.29.02.47-.09.18-.14.29-.27.45-.14.16-.29.35-.41.47-.14.14-.28.29-.12.56.16.27.71 1.17 1.52 1.9 1.05.94 1.93 1.23 2.2 1.37.27.14.43.11.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.22.61-.13.25.09 1.57.74 1.84.88.27.14.45.2.52.32.07.11.07.65-.15 1.26z" />
    </svg>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function ConfirmationQueue({ orders }: { orders: ConfirmationQueueOrder[] }) {
  return (
    <div className="space-y-3">
      {orders.map((order) => (
        <ConfirmationCard key={order.id} order={order} />
      ))}
    </div>
  );
}

function ConfirmationCard({ order }: { order: ConfirmationQueueOrder }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const [noAnswerKind, setNoAnswerKind] = useState<(typeof NO_ANSWER_OUTCOMES)[number]>("PAS_DE_REPONSE");

  const [shortage, setShortage] = useState<StockShortage | null>(null);

  function submit(outcome: string, override?: { token: string; reason: string }) {
    const fd = new FormData();
    fd.set("id", order.id);
    fd.set("outcome", outcome);
    if (note.trim()) fd.set("note", note.trim());
    if (override) {
      fd.set("stockOverrideToken", override.token);
      fd.set("stockOverrideReason", override.reason);
    }
    setShortage(null);
    startTransition(async () => {
      const res = await recordConfirmationAttemptAction(fd);
      const refusedForStock = stockShortageOf(res);
      if (refusedForStock) {
        setShortage(refusedForStock);
        return;
      }
      if (res.ok) {
        toast.success(
          outcome === "CONFIRME"
            ? "Commande confirmée."
            : outcome === "ANNULE"
              ? "Commande annulée."
              : "Tentative enregistrée."
        );
        setNote("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  const whatsappMessage = `Bonjour ${order.customerName}, nous vous contactons au sujet de votre commande ${order.displayNumber} d'un montant de ${formatCurrency(order.total, order.currency)}. Pouvez-vous confirmer cette commande ?`;
  const whatsappHref = buildCustomerWhatsAppUrl(order.customerWhatsapp ?? order.customerPhone, whatsappMessage);

  return (
    <div className="rounded-card bg-card p-4 shadow-card sm:p-5">
      {/* Header: who, and how urgent */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar>
            <AvatarFallback className="bg-pill-peach text-xs font-semibold text-pill-peach-fg">
              {initials(order.customerName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-tight text-ink">{order.customerName}</p>
            <p className="flex items-center gap-1.5 text-xs text-ink-muted">
              <Link href={`/commandes/${order.id}`} className="font-medium text-ink-secondary hover:underline">
                {order.displayNumber}
              </Link>
              {order.city && (
                <span className="flex items-center gap-0.5">
                  <MapPin className="size-3" /> {order.city}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {order.attemptCount > 0 && (
            <Badge variant={order.flagged ? "destructive" : "secondary"}>
              {order.attemptCount} tentative{order.attemptCount > 1 ? "s" : ""}
            </Badge>
          )}
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="size-3" /> {formatDateTime(order.placedAt)}
          </span>
        </div>
      </div>

      {/* Contact — the two things an agent does first */}
      <div className="mt-3 flex flex-wrap gap-2">
        {order.customerPhone && (
          <Button size="sm" variant="outline" render={<a href={`tel:${order.customerPhone}`} />}>
            <Phone className="size-4" />
            {order.customerPhone}
          </Button>
        )}
        {whatsappHref && (
          <Button
            size="sm"
            variant="outline"
            className="border-transparent bg-pill-green text-pill-green-fg hover:bg-pill-green hover:text-pill-green-fg hover:brightness-95"
            render={<a href={whatsappHref} target="_blank" rel="noopener noreferrer" />}
          >
            <WhatsAppIcon className="size-4" />
            WhatsApp
          </Button>
        )}
      </div>

      {/* Order essentials */}
      <div className="mt-3 flex items-center gap-1.5 rounded-xl bg-pill-neutral px-3 py-2 text-sm">
        <Package className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {order.itemCount} article{order.itemCount > 1 ? "s" : ""}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="font-semibold text-ink tabular-nums">{formatCurrency(order.total, order.currency)}</span>
      </div>

      {order.stockWarning && (
        <Notice tone="warning" size="sm" className="mt-2">
          <TriangleAlert />
          <span>
            Stock insuffisant à l&apos;emplacement de préparation pour au moins un article — la confirmation sera
            refusée, sauf validation motivée d&apos;un responsable.
          </span>
        </Notice>
      )}
      {order.stockUntracked && (
        <p className="mt-2 text-xs text-muted-foreground">Stock non suivi pour au moins un article à cet emplacement.</p>
      )}
      <StockOverrideDialog
        key={shortage?.token ?? "none"}
        shortage={shortage}
        pending={isPending}
        onCancel={() => setShortage(null)}
        onOverride={(token, reason) => submit("CONFIRME", { token, reason })}
      />

      {order.recentAttempts.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-l-2 border-hairline pl-3 text-xs text-ink-muted">
          {order.recentAttempts.map((a, i) => (
            <li key={i}>
              <span className="text-foreground">{OUTCOME_LABELS[a.outcome] ?? a.outcome}</span>
              {a.agentName ? ` — ${a.agentName}` : ""} · {formatDateTime(a.createdAt)}
            </li>
          ))}
        </ul>
      )}

      {/* Outcome actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note d'appel (optionnel)…"
          className="h-9 w-full sm:w-52"
          disabled={isPending}
        />
        <Button size="sm" disabled={isPending} onClick={() => submit("CONFIRME")}>
          <Check className="size-4" /> Confirmer
        </Button>

        <div className="flex items-center gap-1">
          <Select
            value={noAnswerKind}
            onValueChange={(v) => v && setNoAnswerKind(v as (typeof NO_ANSWER_OUTCOMES)[number])}
            disabled={isPending}
          >
            <SelectTrigger className="h-9 w-40">
              <SelectValue>{(v: string) => OUTCOME_LABELS[v] ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {NO_ANSWER_OUTCOMES.map((o) => (
                <SelectItem key={o} value={o}>
                  {OUTCOME_LABELS[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" disabled={isPending} onClick={() => submit(noAnswerKind)}>
            {noAnswerKind === "RAPPELER" ? <RotateCcw className="size-4" /> : <PhoneOff className="size-4" />}
            Enregistrer
          </Button>
        </div>

        <Button
          size="sm"
          variant="ghost"
          className="ml-auto text-destructive hover:text-destructive"
          disabled={isPending}
          onClick={() => submit("ANNULE")}
        >
          <X className="size-4" /> Annuler la commande
        </Button>
      </div>
    </div>
  );
}
