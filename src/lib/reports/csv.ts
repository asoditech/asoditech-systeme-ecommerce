/**
 * Minimal RFC-4180 CSV builder for the /rapports export routes. No
 * dependency — a report is a header row plus flat rows of
 * string/number/null. Values are quoted only when they contain a comma,
 * quote, or newline; a leading `=`/`+`/`-`/`@` is prefixed with a
 * zero-width guard so a spreadsheet doesn't evaluate it as a formula
 * (CSV-injection defence). A UTF-8 BOM is prepended so Excel opens
 * accented French text correctly.
 */

type Cell = string | number | null | undefined;

function formatCell(value: Cell): string {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : value;
  if (/^[=+\-@]/.test(s)) s = `\t${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(formatCell).join(","), ...rows.map((r) => r.map(formatCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** A downloadable-file Response for a route handler. `filename` gets a
 * `.csv` suffix and today's date appended. */
export function csvResponse(filename: string, headers: string[], rows: Cell[][]): Response {
  return fileResponse(filename, toCsv(headers, rows));
}

export interface CsvSection {
  heading: string;
  headers: string[];
  rows: Cell[][];
}

/**
 * A multi-section report CSV — a title/period block, then one labelled
 * table per section separated by a blank line. Opens cleanly in Excel /
 * Google Sheets and reads as a real document rather than a bare dump.
 */
export function csvDocument(opts: { title: string; meta: string[]; sections: CsvSection[] }): string {
  const lines: string[] = [];
  const push = (cells: Cell[]) => lines.push(cells.map(formatCell).join(","));

  push([opts.title]);
  for (const m of opts.meta) push([m]);
  lines.push("");

  opts.sections.forEach((section, i) => {
    if (i > 0) lines.push("");
    push([section.heading]);
    push(section.headers);
    for (const r of section.rows) push(r);
  });

  return `﻿${lines.join("\r\n")}\r\n`;
}

export function csvDocumentResponse(filename: string, doc: string): Response {
  return fileResponse(filename, doc);
}

function fileResponse(filename: string, body: string): Response {
  const stamped = `${filename}-${new Date().toLocaleDateString("en-CA")}.csv`;
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${stamped}"`,
      "cache-control": "no-store",
    },
  });
}
