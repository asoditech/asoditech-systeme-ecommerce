import { Badge } from "@/components/ui/badge";

export function StatusBadge({
  status,
  labels,
}: {
  status: string;
  labels: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }>;
}) {
  const meta = labels[status] ?? { label: status, variant: "outline" as const };
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}
