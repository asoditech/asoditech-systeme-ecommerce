import { PageHeader } from "@/components/page-header";
import { CreateUserForm } from "@/components/users/create-user-form";
import { UserRowControls } from "@/components/users/user-row-controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { USER_ROLE_LABELS, USER_STATUS_LABELS } from "@/lib/status-labels";
import { ROLE_PERMISSIONS, PERMISSIONS } from "@/lib/auth/permissions";

export const metadata = { title: "Utilisateurs — ASODITECH Gestion E-commerce" };

export default async function UtilisateursPage() {
  const user = await requirePermission("users.view");
  const isOwner = user.role === "OWNER";
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });

  return (
    <div className="space-y-8">
      <PageHeader
        title="Utilisateurs"
        description="Comptes d'accès et rôles. Les permissions sont définies par rôle."
        actions={isOwner ? <CreateUserForm /> : undefined}
      />

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
                  {isOwner ? (
                    <UserRowControls userId={u.id} role={u.role} status={u.status} />
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
              {PERMISSIONS.map((perm) => (
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
