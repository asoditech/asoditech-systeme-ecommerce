"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Phone, PhoneOff, Check, X, RotateCcw, MapPin, Package, Clock } from "lucide-react";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  function submit(outcome: string) {
    const fd = new FormData();
    fd.set("id", order.id);
    fd.set("outcome", outcome);
    if (note.trim()) fd.set("note", note.trim());
    startTransition(async () => {
      const res = await recordConfirmationAttemptAction(fd);
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
    <div className="rounded-xl border p-4">
      {/* Header: who, and how urgent */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar>
            <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
              {initials(order.customerName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold leading-tight">{order.customerName}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Link href={`/commandes/${order.id}`} className="font-medium hover:underline">
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
            className="border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
            render={<a href={whatsappHref} target="_blank" rel="noopener noreferrer" />}
          >
            <WhatsAppIcon className="size-4" />
            WhatsApp
          </Button>
        )}
      </div>

      {/* Order essentials */}
      <div className="mt-3 flex items-center gap-1.5 rounded-lg bg-muted/40 px-3 py-2 text-sm">
        <Package className="size-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">
          {order.itemCount} article{order.itemCount > 1 ? "s" : ""}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="font-semibold">{formatCurrency(order.total, order.currency)}</span>
      </div>

      {order.recentAttempts.length > 0 && (
        <ul className="mt-3 space-y-0.5 border-l-2 border-muted pl-3 text-xs text-muted-foreground">
          {order.recentAttempts.map((a, i) => (
            <li key={i}>
              <span className="text-foreground">{OUTCOME_LABELS[a.outcome] ?? a.outcome}</span>
              {a.agentName ? ` — ${a.agentName}` : ""} · {formatDateTime(a.createdAt)}
            </li>
          ))}
        </ul>
      )}

      {/* Outcome actions */}
      <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t pt-3.5">
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
