import type { ReportBusinessInfo } from "@/lib/queries/business-info";

/**
 * Print-only letterhead for a report ("Télécharger PDF" → the browser's
 * Save-as-PDF). Hidden on screen (the page already has its PageHeader);
 * `print:block` brings in the company logo + coordinates on the left and
 * the report title / period / generation date on the right, matching the
 * delivery-invoice sheet.
 */
export function ReportDocumentHeader({
  business,
  title,
  periodLabel,
}: {
  business: ReportBusinessInfo;
  title: string;
  periodLabel: string;
}) {
  const generatedAt = new Date().toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const location = [business.city, business.country].filter(Boolean).join(", ");

  return (
    <div className="mb-6 hidden border-b border-slate-300 pb-4 print:block">
      <div className="flex items-start justify-between gap-6">
        <div className="flex items-start gap-3">
          {business.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={business.logoUrl} alt={business.companyName} className="h-12 w-auto max-w-[160px] object-contain" />
          ) : null}
          <div className="text-[12px] leading-tight text-slate-700">
            <p className="text-sm font-semibold text-slate-900">{business.companyName}</p>
            {business.address && <p>{business.address}</p>}
            {location && <p>{location}</p>}
            {business.phone && <p>Tél. {business.phone}</p>}
            {business.email && <p>{business.email}</p>}
          </div>
        </div>
        <div className="text-right text-[12px] leading-tight text-slate-700">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-900">{title}</p>
          <p>Période : {periodLabel}</p>
          <p>Généré le {generatedAt}</p>
        </div>
      </div>
    </div>
  );
}
