"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X } from "lucide-react";
import { revokeInvitationAction } from "@/actions/invitations";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import { formatDate } from "@/lib/format";

export interface PendingInvitationRow {
  id: string;
  email: string;
  name: string;
  role: string;
  expiresAt: string;
  invitedByName: string | null;
}

export function PendingInvitationsList({ invitations }: { invitations: PendingInvitationRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (invitations.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invitations en attente</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>E-mail</TableHead>
              <TableHead>Nom</TableHead>
              <TableHead>Rôle</TableHead>
              <TableHead>Invité par</TableHead>
              <TableHead>Expire le</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invite) => (
              <TableRow key={invite.id}>
                <TableCell className="text-muted-foreground">{invite.email}</TableCell>
                <TableCell>{invite.name}</TableCell>
                <TableCell>{USER_ROLE_LABELS[invite.role] ?? invite.role}</TableCell>
                <TableCell className="text-muted-foreground">{invite.invitedByName ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(invite.expiresAt)}</TableCell>
                <TableCell>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={isPending}
                    title="Révoquer l'invitation"
                    onClick={() => {
                      startTransition(async () => {
                        const formData = new FormData();
                        formData.set("id", invite.id);
                        const result = await revokeInvitationAction(formData);
                        if (result.ok) {
                          toast.success("Invitation révoquée.");
                          router.refresh();
                        } else {
                          toast.error(result.error);
                        }
                      });
                    }}
                  >
                    <X className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
