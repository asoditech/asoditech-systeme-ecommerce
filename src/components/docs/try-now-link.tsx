import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { userHasPermission } from "@/lib/auth/permissions";
import type { Permission } from "@/lib/auth/permissions";

/**
 * The one place that checks permission before rendering a live deep link
 * — never implies the viewer can perform an action they don't hold the
 * permission for (see the Documentation/Demo Center RBAC note in
 * src/lib/docs/types.ts).
 */
export function TryNowLink({
  tryNow,
  permission,
  viewer,
}: {
  tryNow?: { label: string; href: string };
  permission?: Permission;
  /** The viewer's EFFECTIVE permissions (role + overrides, channel-scoped). */
  viewer: { permissions: ReadonlySet<Permission> };
}) {
  if (!tryNow) return null;

  if (permission && !userHasPermission(viewer, permission)) {
    return (
      <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Lock className="size-3.5" />
        « {tryNow.label} » nécessite une permission que vous ne possédez pas.
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
