import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { findUsableInvitation } from "@/lib/auth/token-lookup";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { USER_ROLE_LABELS } from "@/lib/status-labels";

export const metadata = { title: "Accepter l'invitation — ASODITECH Gestion E-commerce" };

export default async function AcceptInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/tableau-de-bord");
  }

  const { token } = await params;
  const found = await findUsableInvitation(token);

  if (!found || !found.usable) {
    return (
      <AuthShell title="Invitation invalide" description="Ce lien d'invitation n'est plus valide.">
        <p className="text-sm text-muted-foreground">
          Il a peut-être expiré, déjà été utilisé, ou été révoqué. Demandez une nouvelle invitation à votre
          administrateur.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Bonjour ${found.invitation.name}`}
      description={`Vous avez été invité(e) en tant que ${USER_ROLE_LABELS[found.invitation.role] ?? found.invitation.role}.`}
    >
      <AcceptInvitationForm token={token} email={found.invitation.email} />
    </AuthShell>
  );
}
