"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Phone, PhoneOff, Check, X, RotateCcw } from "lucide-react";
import { recordConfirmationAttemptAction } from "@/actions/order-confirmation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CONFIRMATION_OUTCOME_LABELS as OUTCOME_LABELS } from "@/lib/status-labels";

export interface ConfirmationQueueOrder {
  id: string;
  displayNumber: string;
  customerName: string;
  customerPhone: string | null;
  total: string;
  currency: string;
  placedAt: string;
  itemCount: number;
  attemptCount: number;
  flagged: boolean;
  recentAttempts: { outcome: string; agentName: string | null; createdAt: string }[];
}

const NO_ANSWER_OUTCOMES = ["PAS_DE_REPONSE", "OCCUPE", "RAPPELER", "FAUX_NUMERO"] as const;

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

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link href={`/commandes/${order.id}`} className="font-medium hover:underline">
              {order.displayNumber}
            </Link>
            {order.attemptCount > 0 && (
              <Badge variant={order.flagged ? "destructive" : "secondary"}>
                {order.attemptCount} tentative{order.attemptCount > 1 ? "s" : ""}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-sm">
            {order.customerName}
            {order.customerPhone && (
              <a
                href={`tel:${order.customerPhone}`}
                className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Phone className="size-3.5" />
                {order.customerPhone}
              </a>
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {order.itemCount} article{order.itemCount > 1 ? "s" : ""} · {formatCurrency(order.total, order.currency)} ·
            reçue le {formatDateTime(order.placedAt)}
          </p>
        </div>
      </div>

      {order.recentAttempts.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-l-2 border-muted pl-3 text-xs text-muted-foreground">
          {order.recentAttempts.map((a, i) => (
            <li key={i}>
              <span className="text-foreground">{OUTCOME_LABELS[a.outcome] ?? a.outcome}</span>
              {a.agentName ? ` — ${a.agentName}` : ""} · {formatDateTime(a.createdAt)}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note d'appel (optionnel)…"
          className="h-9 w-full sm:w-56"
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
          className="text-destructive hover:text-destructive"
          disabled={isPending}
          onClick={() => submit("ANNULE")}
        >
          <X className="size-4" /> Annuler la commande
        </Button>
      </div>
    </div>
  );
}
