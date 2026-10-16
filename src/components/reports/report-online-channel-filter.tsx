import { FilterSelect } from "@/components/filter-select";

/**
 * « Canal en ligne » select for the Online /rapports pages — rendered only
 * when the viewer has more than one online channel (one channel = nothing to
 * choose, same rule as /analyses). Navigates with `?canal=`; the page
 * re-resolves it server-side (`resolveReportOnlineChannel`).
 */
export function ReportOnlineChannelFilter({ channels, value }: { channels: { id: string; name: string }[]; value?: string }) {
  if (channels.length < 2) return null;
  return (
    <FilterSelect
      paramKey="canal"
      value={value}
      allLabel="Tous les canaux en ligne"
      ariaLabel="Canal en ligne"
      options={channels.map((c) => ({ value: c.id, label: c.name }))}
      className="h-8 w-auto max-w-full min-w-52"
    />
  );
}
