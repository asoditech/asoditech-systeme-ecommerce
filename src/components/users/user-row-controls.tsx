"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { updateUserRoleAction, updateUserStatusAction } from "@/actions/users";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { UserRole, UserStatus } from "@prisma/client";

const ASSIGNABLE_ROLES = Object.entries(USER_ROLE_LABELS).filter(([value]) => value !== "OWNER");

export function UserRowControls({ userId, role, status }: { userId: string; role: UserRole; status: UserStatus }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (role === "OWNER") {
    return <span className="text-sm text-muted-foreground">Propriétaire</span>;
  }

  return (
    <div className="flex items-center gap-3">
      <Select
        value={role}
        disabled={isPending}
        onValueChange={(value) => {
          if (!value) return;
          startTransition(async () => {
            const formData = new FormData();
            formData.set("id", userId);
            formData.set("role", value);
            const result = await updateUserRoleAction(formData);
            if (result.ok) {
              toast.success("Rôle mis à jour.");
              router.refresh();
            } else {
              toast.error(result.error);
            }
          });
        }}
      >
        <SelectTrigger className="w-40">
          <SelectValue>{(value: string) => USER_ROLE_LABELS[value] ?? value}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ASSIGNABLE_ROLES.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-1.5">
        <Switch
          checked={status === "ACTIVE"}
          disabled={isPending}
          onCheckedChange={(checked) => {
            startTransition(async () => {
              const formData = new FormData();
              formData.set("id", userId);
              formData.set("status", checked ? "ACTIVE" : "DISABLED");
              const result = await updateUserStatusAction(formData);
              if (result.ok) {
                toast.success("Statut mis à jour.");
                router.refresh();
              } else {
                toast.error(result.error);
              }
            });
          }}
        />
        <span className="text-xs text-muted-foreground">{status === "ACTIVE" ? "Actif" : "Désactivé"}</span>
      </div>
    </div>
  );
}
