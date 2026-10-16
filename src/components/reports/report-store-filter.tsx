import { FilterSelect } from "@/components/filter-select";

/**
 * « Magasin » select for the store sections of /rapports (and the dashboard),
 * twin of `ReportOnlineChannelFilter` — rendered only when the viewer has
 * more than one store. Navigates with `?magasin=`; the page re-resolves it
 * server-side (`resolveReportStoreChannel`).
 */
export function ReportStoreFilter({ channels, value }: { channels: { id: string; name: string }[]; value?: string }) {
  if (channels.length < 2) return null;
  return (
    <FilterSelect
      paramKey="magasin"
      value={value}
      allLabel="Tous les magasins"
      ariaLabel="Magasin"
      options={channels.map((c) => ({ value: c.id, label: c.name }))}
      className="h-8 w-auto max-w-full min-w-52"
    />
  );
}
