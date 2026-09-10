import { Callout } from "./callout";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DocBlock } from "@/lib/docs/types";

export function BlockRenderer({ blocks }: { blocks: DocBlock[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((block, i) => {
        switch (block.type) {
          case "p":
            return (
              <p key={i} className="leading-relaxed text-foreground/90">
                {block.text}
              </p>
            );
          case "callout":
            return <Callout key={i} tone={block.tone} title={block.title} text={block.text} />;
          case "list":
            return (
              <ul key={i} className="list-disc space-y-1.5 pl-5 text-foreground/90">
                {block.items.map((item, j) => (
                  <li key={j}>{item}</li>
                ))}
              </ul>
            );
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-lg border bg-muted/50 p-3 text-xs">
                <code>{block.code}</code>
              </pre>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {block.headers.map((h, j) => (
                        <TableHead key={j}>{h}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {block.rows.map((row, j) => (
                      <TableRow key={j}>
                        {row.map((cell, k) => (
                          <TableCell key={k}>{cell}</TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
