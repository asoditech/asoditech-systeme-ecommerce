import { PageHeader } from "@/components/page-header";
import { InviteUserForm } from "@/components/users/invite-user-form";
import { UserRowControls } from "@/components/users/user-row-controls";
import { PendingInvitationsList } from "@/components/users/pending-invitations-list";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/permissions";
import { hasGlobalLocationAccess } from "@/lib/auth/location-access";
import { prisma } from "@/lib/prisma";
import { listPendingInvitations } from "@/lib/queries/users";
import { formatDate } from "@/lib/format";
import { USER_ROLE_LABELS, USER_STATUS_LABELS } from "@/lib/status-labels";
import { ROLE_PERMISSIONS, PERMISSIONS, isPermission } from "@/lib/auth/permissions";
import { permissionAvailable } from "@/lib/tenant/business-mode";
import { isGlobalRole } from "@/lib/auth/effective-access";

export const metadata = { title: "Utilisateurs — ASODITECH Gestion E-commerce" };

export default async function UtilisateursPage() {
  const user = await requirePermission("users.view");
  const canManage = userHasPermission(user, "users.manage");
  // Business mode (docs/adr/0041): channels exist only with `storeChannels`, and
  // a permission whose capability is off is not offered (it would be inert).
  const storeChannelsOn = user.capabilities.has("storeChannels");
  const [users, invitations, warehouses, assignments, channelList, channelAssignments, overrides] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    canManage ? listPendingInvitations() : Promise.resolve([]),
    // Location Access Management v1 (docs/adr/0037): every active
    // warehouse to assign from, and every existing assignment, fetched
    // once up front rather than per row — no N+1 across the user list.
    canManage
      ? prisma.warehouse.findMany({
          where: { isActive: true },
          orderBy: [{ isDefault: "desc" }, { name: "asc" }],
          select: { id: true, name: true, type: true },
        })
      : Promise.resolve([]),
    canManage
      ? prisma.userLocation.findMany({ select: { userId: true, warehouseId: true } })
      : Promise.resolve([]),
    // Individual access (docs/adr/0039): channels, assignments and overrides
    // fetched once up front — no N+1 across the user list.
    canManage && storeChannelsOn
      ? prisma.salesChannel.findMany({
          where: { isActive: true },
          orderBy: [{ kind: "asc" }, { name: "asc" }],
          select: { id: true, name: true, kind: true },
        })
      : Promise.resolve([]),
    canManage && storeChannelsOn
      ? prisma.userChannel.findMany({ select: { userId: true, salesChannelId: true } })
      : Promise.resolve([]),
    canManage
      ? prisma.userPermissionOverride.findMany({ select: { userId: true, permission: true, effect: true } })
      : Promise.resolve([]),
  ]);
  // `users.manage` can never be overridden (it would let a non-admin mint
  // themselves an admin) — so it is not offered.
  const overridable = PERMISSIONS.filter((p) => p !== "users.manage" && permissionAvailable(p, user.capabilities));
  const assignedByUser = new Map<string, string[]>();
  for (const a of assignments) {
    assignedByUser.set(a.userId, [...(assignedByUser.get(a.userId) ?? []), a.warehouseId]);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Utilisateurs"
        description={
          storeChannelsOn
            ? "Comptes d'accès et rôles. Les permissions sont définies par rôle ; des ajustements individuels et les canaux de vente se règlent par utilisateur."
            : "Comptes d'accès et rôles. Les permissions sont définies par rôle ; des ajustements individuels se règlent par utilisateur."
        }
        actions={canManage ? <InviteUserForm /> : undefined}
      />

      {canManage && (
        <PendingInvitationsList
          invitations={invitations.map((i) => ({
            id: i.id,
            email: i.email,
            name: i.name,
            role: i.role,
            expiresAt: i.expiresAt.toISOString(),
            invitedByName: i.invitedBy?.name ?? null,
          }))}
        />
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>E-mail</TableHead>
              <TableHead>Rôle / Statut</TableHead>
              <TableHead>Dernière connexion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-muted-foreground">{u.email}</TableCell>
                <TableCell>
                  {canManage ? (
                    <UserRowControls
                      userId={u.id}
                      name={u.name}
                      email={u.email}
                      role={u.role}
                      status={u.status}
                      warehouses={warehouses}
                      assignedWarehouseIds={assignedByUser.get(u.id) ?? []}
                      hasGlobalLocationAccess={hasGlobalLocationAccess(u.role)}
                      access={
                        isGlobalRole(u.role)
                          ? undefined
                          : {
                              permissions: overridable,
                              baseline: [...ROLE_PERMISSIONS[u.role]],
                              grants: overrides.filter((o) => o.userId === u.id && o.effect === "GRANT" && isPermission(o.permission)).map((o) => o.permission),
                              denies: overrides.filter((o) => o.userId === u.id && o.effect === "DENY" && isPermission(o.permission)).map((o) => o.permission),
                              channels: channelList,
                              channelsEnabled: storeChannelsOn,
                              assignedChannelIds: channelAssignments.filter((a) => a.userId === u.id).map((a) => a.salesChannelId),
                            }
                      }
                    />
                  ) : (
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{USER_ROLE_LABELS[u.role]}</Badge>
                      <Badge variant={USER_STATUS_LABELS[u.status].variant}>{USER_STATUS_LABELS[u.status].label}</Badge>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {u.lastLoginAt ? formatDate(u.lastLoginAt) : "Jamais connecté"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Matrice des permissions par rôle</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="p-2 text-left font-medium">Permission</th>
                {Object.keys(ROLE_PERMISSIONS).map((role) => (
                  <th key={role} className="p-2 text-center font-medium whitespace-nowrap">
                    {USER_ROLE_LABELS[role]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSIONS.filter((perm) => permissionAvailable(perm, user.capabilities)).map((perm) => (
                <tr key={perm} className="border-b last:border-0">
                  <td className="p-2 font-mono text-xs text-muted-foreground">{perm}</td>
                  {Object.entries(ROLE_PERMISSIONS).map(([role, perms]) => (
                    <td key={role} className="p-2 text-center">
                      {(perms as readonly string[]).includes(perm) ? "✓" : ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
