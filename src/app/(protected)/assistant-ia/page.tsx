import { PageHeader } from "@/components/page-header";
import { AiAssistantPanel } from "@/components/ai/ai-assistant-panel";
import { requirePermission } from "@/lib/auth/guards";

export const metadata = { title: "Assistant IA — ASODITECH Gestion E-commerce" };

export default async function AssistantIaPage() {
  await requirePermission("ai.use");

  return (
    <div>
      <PageHeader
        title="Assistant IA"
        description="Réponses basées sur des requêtes contrôlées vers vos données réelles — aucune donnée n'est inventée. L'intégration d'un fournisseur IA conversationnel (Intégrations) est prévue pour une phase ultérieure."
      />
      <AiAssistantPanel />
    </div>
  );
}
