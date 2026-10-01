/** Hours → a short French duration: « 5,5 h » under two days, else « 3,2 j ». Null → « — ». */
export function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  if (hours < 48) return `${hours.toFixed(1).replace(".", ",")} h`;
  return `${(hours / 24).toFixed(1).replace(".", ",")} j`;
}

export function formatPct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1).replace(".", ",")} %`;
}
