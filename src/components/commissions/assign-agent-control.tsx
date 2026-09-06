"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { assignOrderConfirmationAgentAction } from "@/actions/commissions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const NONE = "__none__";

/**
 * Assigns / clears the confirmation agent on an order. Locked (read-only)
 * once a commission has been earned or reversed — the server enforces this
 * too.
 */
export function AssignAgentControl({
  orderId,
  currentAgentId,
  agents,
  locked,
}: {
  orderId: string;
  currentAgentId: string | null;
  agents: { id: string; name: string }[];
  locked: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (locked) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">Agent : </span>
        {agents.find((a) => a.id === currentAgentId)?.name ?? "—"}{" "}
        <span className="text-xs text-muted-foreground">(commission calculée — verrouillé)</span>
      </p>
    );
  }

  return (
    <Select
      value={currentAgentId ?? NONE}
      disabled={isPending}
      onValueChange={(next) => {
        if (!next) return;
        startTransition(async () => {
          const fd = new FormData();
          fd.set("orderId", orderId);
          fd.set("agentId", next === NONE ? "" : next);
          const result = await assignOrderConfirmationAgentAction(fd);
          if (result.ok) {
            toast.success("Agent de confirmation mis à jour.");
            router.refresh();
          } else {
            toast.error(result.error);
          }
        });
      }}
    >
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Aucun agent">
          {(value: string) => (value === NONE ? "Aucun agent" : agents.find((a) => a.id === value)?.name ?? "Aucun agent")}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>Aucun agent</SelectItem>
        {agents.map((a) => (
          <SelectItem key={a.id} value={a.id}>
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
