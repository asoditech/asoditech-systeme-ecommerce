import { PageHeader } from "@/components/page-header";
import { AiAssistantPanel } from "@/components/ai/ai-assistant-panel";
import { requirePermission } from "@/lib/auth/guards";
import { aiQuestionsForRole } from "@/lib/ai/tools";

export const metadata = { title: "Assistant IA — ASODITECH Gestion E-commerce" };

export default async function AssistantIaPage() {
  const user = await requirePermission("ai.use");

  return (
    <div>
      <PageHeader
        title="Assistant IA"
        description="Réponses basées sur des requêtes contrôlées vers vos données réelles — aucune donnée n'est inventée. Seules les questions autorisées par votre rôle sont proposées. L'intégration d'un fournisseur IA conversationnel (Intégrations) est prévue pour une phase ultérieure."
      />
      <AiAssistantPanel questions={aiQuestionsForRole(user.role)} />
    </div>
  );
}
