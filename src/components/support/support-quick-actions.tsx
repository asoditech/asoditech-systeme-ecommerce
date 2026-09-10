"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, Loader2, Sparkles } from "lucide-react";
import { runAiToolAction } from "@/actions/ai";
import type { SupportContext } from "@/lib/support/context";

type Answer = { text: string; href?: string; linkLabel?: string };

/**
 * The support widget's AI quick actions. Reuses the existing controlled
 * tool layer via `runAiToolAction` — every answer is real data or an
 * explicit "indisponible", never invented. `questions` is already filtered
 * to the user's role server-side; the current-screen `context` just
 * reorders them so the most relevant sit on top.
 */
export function SupportQuickActions({
  questions,
  context,
}: {
  questions: { id: string; label: string }[];
  context: SupportContext;
}) {
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [showAll, setShowAll] = useState(false);

  const { featured, rest } = useMemo(() => {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const featured = context.featuredActionIds
      .map((id) => byId.get(id))
      .filter((q): q is { id: string; label: string } => Boolean(q));
    const featuredIds = new Set(featured.map((q) => q.id));
    const rest = questions.filter((q) => !featuredIds.has(q.id));
    return { featured: featured.length > 0 ? featured : questions.slice(0, 3), rest: featured.length > 0 ? rest : questions.slice(3) };
  }, [questions, context.featuredActionIds]);

  function ask(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const result = await runAiToolAction(id);
      setAnswers((prev) => ({
        ...prev,
        [id]: result.ok
          ? { text: result.answer, href: result.href, linkLabel: result.linkLabel }
          : { text: result.error },
      }));
      setPendingId(null);
    });
  }

  const visible = showAll ? [...featured, ...rest] : featured;

  return (
    <section className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase">
        <Sparkles className="size-3.5" />
        Questions rapides
      </div>

      <div className="space-y-1.5">
        {visible.map((q) => (
          <div key={q.id} className="rounded-lg border border-border">
            <button
              type="button"
              disabled={isPending}
              onClick={() => ask(q.id)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:bg-accent disabled:opacity-60"
            >
              {q.label}
              {pendingId === q.id && <Loader2 className="size-3.5 shrink-0 animate-spin" />}
            </button>
            {answers[q.id] && (
              <div className="space-y-1.5 border-t border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">{answers[q.id].text}</p>
                {answers[q.id].href && (
                  <Link
                    href={answers[q.id].href!}
                    className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
                  >
                    {answers[q.id].linkLabel ?? "Voir le détail"}
                    <ArrowUpRight className="size-3" />
                  </Link>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {showAll ? "Moins de questions" : `Plus de questions (${rest.length})`}
        </button>
      )}
    </section>
  );
}
