import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hasPermission } from "@/lib/auth/permissions";
import type { Permission } from "@/lib/auth/permissions";
import type { UserRole } from "@prisma/client";

/**
 * The one place that checks permission before rendering a live deep link
 * — never implies the viewer can perform an action they don't hold the
 * permission for (see the Documentation/Demo Center RBAC note in
 * src/lib/docs/types.ts).
 */
export function TryNowLink({
  tryNow,
  permission,
  role,
}: {
  tryNow?: { label: string; href: string };
  permission?: Permission;
  role: UserRole;
}) {
  if (!tryNow) return null;

  if (permission && !hasPermission(role, permission)) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-3.5" />
        « {tryNow.label} » nécessite une permission que votre rôle ne possède pas.
      </p>
    );
  }

  return (
    <Button size="sm" render={<Link href={tryNow.href} />}>
      {tryNow.label}
      <ArrowRight className="size-4" />
    </Button>
  );
}
