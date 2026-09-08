import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrintButton } from "@/components/reports/print-button";
import { requirePermission } from "@/lib/auth/guards";
import { getCommissionStatementForPrint } from "@/lib/queries/commission-statement";
import { getReportBusinessInfo } from "@/lib/queries/business-info";
import { formatCurrency, formatDate, displayOrderNumber } from "@/lib/format";

export const metadata = { title: "Relevé de commission — ASODITECH Gestion E-commerce" };

const MONTHS = [
  "", "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

export default async function CommissionStatementPrintPage({
  params,
}: {
  params: Promise<{ agentId: string; statementId: string }>;
}) {
  await requirePermission("commissions.view");
  const { agentId, statementId } = await params;
  const [statement, business] = await Promise.all([
    getCommissionStatementForPrint(agentId, statementId),
    getReportBusinessInfo(),
  ]);
  if (!statement) notFound();

  const currency = statement.currency;
  const money = (v: unknown) => formatCurrency(String(v ?? 0), currency);
  const period = `${MONTHS[statement.periodMonth]} ${statement.periodYear}`;
  const ref = `COM-${statement.periodYear}${String(statement.periodMonth).padStart(2, "0")}-${statement.agent.user.name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()}`;
  const location = [business.city, business.country].filter(Boolean).join(", ");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Button variant="ghost" size="sm" render={<Link href={`/commissions/${agentId}`} />}>
          <ArrowLeft className="size-4" />
          Retour
        </Button>
        <PrintButton label="Imprimer / PDF" />
      </div>

      <div
        data-print-sheet
        className="mx-auto max-w-3xl rounded-lg border bg-white p-8 text-[13px] text-slate-900 shadow-sm dark:bg-white"
      >
        <div className="flex items-start justify-between gap-6 border-b border-slate-200 pb-5">
          <div>
            {business.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={business.logoUrl} alt={business.companyName} className="mb-2 h-12 w-auto object-contain" />
            ) : null}
            <p className="text-lg font-semibold">{business.companyName}</p>
            {business.address && <p>{business.address}</p>}
            {location && <p>{location}</p>}
            {business.phone && <p>Tél. {business.phone}</p>}
            {business.email && <p>{business.email}</p>}
          </div>
          <div className="text-right">
            <p className="text-base font-semibold uppercase tracking-wide">Relevé de commission</p>
            <p className="text-slate-600">{ref}</p>
            <p className="text-slate-600">Émis le {formatDate(new Date())}</p>
            <p className="mt-1">Période : {period}</p>
            <p className="text-slate-600">
              {statement.status === "PAYE" ? `Payé le ${statement.paidAt ? formatDate(statement.paidAt) : "—"}` : "À payer"}
            </p>
          </div>
        </div>

        <div className="py-5">
          <p className="mb-1 font-medium text-slate-500">Agent de confirmation</p>
          <p className="font-medium">{statement.agent.user.name}</p>
          {statement.agent.user.email && <p>{statement.agent.user.email}</p>}
          <p className="text-slate-600">Taux : {money(statement.agent.ratePerOrder)} / commande livrée</p>
        </div>

        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-slate-200 text-left text-slate-500">
              <th className="py-2">Date</th>
              <th className="py-2">Commande</th>
              <th className="py-2">Client</th>
              <th className="py-2">Type</th>
              <th className="py-2 text-right">Montant</th>
            </tr>
          </thead>
          <tbody>
            {statement.entries.map((e) => (
              <tr key={e.id} className="border-b border-slate-100">
                <td className="py-2">{formatDate(e.createdAt)}</td>
                <td className="py-2">{e.order ? displayOrderNumber(e.order) : "—"}</td>
                <td className="py-2">{e.order?.customer.fullName ?? "—"}</td>
                <td className="py-2">{e.type === "EARNED" ? "Commission" : "Reprise"}</td>
                <td className="py-2 text-right tabular-nums">
                  {e.type === "EARNED" ? money(e.amount) : `−${money(e.amount)}`}
                </td>
              </tr>
            ))}
            {statement.entries.length === 0 && (
              <tr>
                <td colSpan={5} className="py-3 text-center text-slate-500">
                  Aucune écriture détaillée sur ce relevé.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="ml-auto mt-4 w-64 space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-500">Commissions ({statement.earnedCount})</span>
            <span className="tabular-nums">{money(statement.earnedAmount)}</span>
          </div>
          {statement.reversedCount > 0 && (
            <div className="flex justify-between">
              <span className="text-slate-500">Reprises ({statement.reversedCount})</span>
              <span className="tabular-nums">−{money(statement.reversedAmount)}</span>
            </div>
          )}
          <div className="flex justify-between border-t border-slate-300 pt-1 text-base font-semibold">
            <span>Net à payer</span>
            <span className="tabular-nums">{money(statement.netAmount)}</span>
          </div>
          {statement.status === "PAYE" && (
            <div className="flex justify-between text-slate-600">
              <span>Payé</span>
              <span className="tabular-nums">{money(statement.paidAmount)}</span>
            </div>
          )}
        </div>

        {statement.note && (
          <div className="mt-5 border-t border-slate-200 pt-3 text-slate-600">
            <p className="font-medium text-slate-500">Note</p>
            <p>{statement.note}</p>
          </div>
        )}

        <p className="mt-8 border-t border-slate-200 pt-3 text-center text-xs text-slate-400">
          {business.companyName} — relevé généré le {formatDate(new Date())}
        </p>
      </div>
    </div>
  );
}
