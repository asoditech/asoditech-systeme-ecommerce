import { logoutAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export function LogoutButton() {
  return (
    <form action={logoutAction}>
      <Button type="submit" variant="ghost" size="icon" aria-label="Déconnexion" title="Déconnexion">
        <LogOut className="size-4" />
      </Button>
    </form>
  );
}
