"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, Eye, EyeOff, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { runAiToolAction } from "@/actions/ai";

type HistoryEntry = { id: string; question: string; answer: string; href?: string; linkLabel?: string };

export function AiAssistantPanel({ questions }: { questions: { id: string; label: string }[] }) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [answersHidden, setAnswersHidden] = useState(false);

  function ask(id: string, label: string) {
    setPendingId(id);
    startTransition(async () => {
      const result = await runAiToolAction(id);
      const entry: HistoryEntry = result.ok
        ? { id, question: label, answer: result.answer, href: result.href, linkLabel: result.linkLabel }
        : { id, question: label, answer: result.error };
      // Re-asking a question already in the history updates its existing
      // card in place (data may have changed since) instead of appending a
      // duplicate below it.
      setHistory((prev) => {
        const existingIndex = prev.findIndex((h) => h.id === id);
        if (existingIndex === -1) return [...prev, entry];
        const next = [...prev];
        next[existingIndex] = entry;
        return next;
      });
      setPendingId(null);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {questions.map((q) => (
          <Button key={q.id} variant="outline" size="sm" disabled={isPending} onClick={() => ask(q.id, q.label)}>
            {pendingId === q.id && <Loader2 className="size-3.5 animate-spin" />}
            {q.label}
          </Button>
        ))}
      </div>

      {history.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Sparkles className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Choisissez une question ci-dessus. Les réponses proviennent exclusivement de vos données réelles.
            </p>
          </CardContent>
        </Card>
      ) : answersHidden ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <EyeOff className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Réponses masquées ({history.length}). Cliquez sur « Afficher les réponses » pour les revoir.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((h) => (
            <Card key={h.id}>
              <CardContent className="space-y-1.5 pt-5">
                <p className="text-sm font-medium">{h.question}</p>
                <p className="text-sm text-muted-foreground">{h.answer}</p>
                {h.href && (
                  <Link
                    href={h.href}
                    className="inline-flex items-center gap-0.5 text-sm font-medium text-primary hover:underline"
                  >
                    {h.linkLabel ?? "Voir le détail"}
                    <ArrowUpRight className="size-3.5" />
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setAnswersHidden((prev) => !prev)}>
            {answersHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
            {answersHidden ? "Afficher les réponses" : "Masquer les réponses"}
          </Button>
        </div>
      )}
    </div>
  );
}
