"use client";

import { useTransition } from "react";
import { LogOut } from "lucide-react";
import { logoutAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";

export function LogoutButton() {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      disabled={isPending}
      aria-label="Se déconnecter"
      className="rounded-full px-3 sm:px-4"
      onClick={() => startTransition(() => void logoutAction())}
    >
      <LogOut className="size-4" />
      <span className="hidden sm:inline">Se déconnecter</span>
    </Button>
  );
}
