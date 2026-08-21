import { Megaphone } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { ChannelForm } from "@/components/marketing/channel-form";
import { CampaignForm } from "@/components/marketing/campaign-form";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { formatCurrency, formatDate } from "@/lib/format";
import { CAMPAIGN_STATUS_LABELS, MARKETING_CHANNEL_TYPE_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Marketing — ASODITECH Gestion E-commerce" };

export default async function MarketingPage() {
  const user = await requirePermission("marketing.view");
  const canManage = hasPermission(user.role, "marketing.manage");

  const [channels, campaigns] = await Promise.all([
    prisma.marketingChannel.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { campaigns: true } } } }),
    prisma.marketingCampaign.findMany({
      orderBy: { startDate: "desc" },
      include: { channel: true, _count: { select: { orders: true } } },
    }),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title="Marketing"
        description="Canaux et campagnes publicitaires. L'attribution automatique nécessite une intégration connectée."
        actions={canManage ? <ChannelForm /> : undefined}
      />

      {channels.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Aucun canal marketing configuré."
          description="Ajoutez un canal (Meta Ads, Google Ads, TikTok Ads...) pour commencer à suivre vos campagnes."
        />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted-foreground">Campagnes</h2>
            {canManage && <CampaignForm channels={channels} />}
          </div>
          {campaigns.length === 0 ? (
            <EmptyState icon={Megaphone} title="Aucune campagne pour le moment." />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campagne</TableHead>
                    <TableHead>Canal</TableHead>
                    <TableHead>Budget / Dépense</TableHead>
                    <TableHead>Commandes attribuées</TableHead>
                    <TableHead>ROAS</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead>Début</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {campaigns.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.name}</TableCell>
                      <TableCell className="text-muted-foreground">{c.channel.name}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.budget ? formatCurrency(c.budget.toString()) : "—"}
                        {c.spend ? ` / ${formatCurrency(c.spend.toString())}` : ""}
                      </TableCell>
                      <TableCell>{c._count.orders}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {c._count.orders > 0 && c.spend ? "Données d'attribution incomplètes" : "Non calculable"}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} labels={CAMPAIGN_STATUS_LABELS} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(c.startDate)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Canal</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Campagnes</TableHead>
                  <TableHead>Statut</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{MARKETING_CHANNEL_TYPE_LABELS[c.type]}</TableCell>
                    <TableCell>{c._count.campaigns}</TableCell>
                    <TableCell>
                      <Badge variant={c.isActive ? "default" : "secondary"}>{c.isActive ? "Actif" : "Inactif"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
