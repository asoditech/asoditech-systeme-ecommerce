import { PageHeader } from "@/components/page-header";
import { CreateTenantForm } from "@/components/platform/create-tenant-form";
import { TenantRowControls } from "@/components/platform/tenant-row-controls";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listTenantsForPlatform } from "@/actions/tenants";
import { formatDate } from "@/lib/format";

export const metadata = { title: "Plateforme — ASODITECH Gestion E-commerce" };

export default async function PlatformPage() {
  const tenants = await listTenantsForPlatform();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tenants"
        description="Espaces de travail provisionnés sur ce déploiement."
        actions={<CreateTenantForm />}
      />

      <div className="rounded-lg border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nom</TableHead>
              <TableHead>Identifiant</TableHead>
              <TableHead>Utilisateurs</TableHead>
              <TableHead>Créé le</TableHead>
              <TableHead>Statut</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="text-muted-foreground">{t.slug}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{t._count.users}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDate(t.createdAt)}</TableCell>
                <TableCell>
                  <TenantRowControls tenantId={t.id} status={t.status} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
