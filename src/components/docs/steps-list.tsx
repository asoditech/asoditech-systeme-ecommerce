export function StepsList({ steps }: { steps: string[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-pill-peach text-xs font-semibold text-pill-peach-fg">
            {i + 1}
          </span>
          <span className="pt-0.5 text-sm leading-relaxed text-foreground/90">{step}</span>
        </li>
      ))}
    </ol>
  );
}
