"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { runAiToolAction } from "@/actions/ai";

const QUESTIONS = [
  { id: "revenue", label: "Combien ai-je vendu ce mois-ci ?" },
  { id: "profit", label: "Quel est mon bénéfice net ce mois-ci ?" },
  { id: "top-product", label: "Quel produit se vend le mieux ?" },
  { id: "marketing-spend", label: "Combien ai-je dépensé en publicité ?" },
  { id: "low-stock", label: "Quels sont mes produits en rupture prochaine ?" },
  { id: "late-orders", label: "Combien de commandes sont en retard ?" },
  { id: "repeat-customers", label: "Quels clients ont commandé plusieurs fois ?" },
];

export function AiAssistantPanel() {
  const [history, setHistory] = useState<{ question: string; answer: string }[]>([]);
  const [isPending, startTransition] = useTransition();

  function ask(id: string, label: string) {
    startTransition(async () => {
      const result = await runAiToolAction(id);
      setHistory((prev) => [
        ...prev,
        { question: label, answer: result.ok ? result.answer : result.error },
      ]);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {QUESTIONS.map((q) => (
          <Button key={q.id} variant="outline" size="sm" disabled={isPending} onClick={() => ask(q.id, q.label)}>
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
      ) : (
        <div className="space-y-3">
          {history.map((h, i) => (
            <Card key={i}>
              <CardContent className="space-y-1.5 pt-5">
                <p className="text-sm font-medium">{h.question}</p>
                <p className="text-sm text-muted-foreground">{h.answer}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
