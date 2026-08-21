"use client";

import { useActionState } from "react";
import { loginAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// TODO: replace with ASODITECH's real WhatsApp number, phone number and
// support email once provided — these are placeholders.
const CONTACT = {
  whatsapp: "212600000000",
  phone: "+212600000000",
  email: "contact@asoditech.com",
};

const CONTACT_LINKS = [
  {
    name: "WhatsApp",
    href: `https://wa.me/${CONTACT.whatsapp}`,
    external: true,
    icon: (
      <svg viewBox="0 0 32 32" className="size-4.5 fill-foreground">
        <path d="M16.001 7C11.03 7 7 11.03 7 16c0 1.77.51 3.42 1.4 4.81L7.6 24.4l3.68-.97a8.96 8.96 0 004.72 1.34c4.97 0 9-4.03 9-9s-4.03-9-9-9zm5.2 12.79c-.22.61-1.08 1.12-1.77 1.27-.47.1-1.09.18-3.17-.68-2.66-1.1-4.37-3.78-4.5-3.96-.13-.18-1.08-1.43-1.08-2.73 0-1.29.68-1.93.92-2.19.24-.26.53-.33.7-.33l.5.01c.16 0 .38-.06.59.45.22.53.74 1.82.8 1.95.07.14.11.29.02.47-.09.18-.14.29-.27.45-.14.16-.29.35-.41.47-.14.14-.28.29-.12.56.16.27.71 1.17 1.52 1.9 1.05.94 1.93 1.23 2.2 1.37.27.14.43.11.59-.07.16-.18.68-.79.86-1.06.18-.27.36-.22.61-.13.25.09 1.57.74 1.84.88.27.14.45.2.52.32.07.11.07.65-.15 1.26z" />
      </svg>
    ),
  },
  {
    name: "Téléphone",
    href: `tel:${CONTACT.phone}`,
    external: false,
    icon: (
      <svg viewBox="0 0 24 24" className="size-4.5 fill-foreground">
        <path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 011 1V20a1 1 0 01-1 1C10.61 21 3 13.39 3 4a1 1 0 011-1h3.5a1 1 0 011 1c0 1.24.2 2.45.57 3.57a1 1 0 01-.25 1.02l-2.2 2.2z" />
      </svg>
    ),
  },
  {
    name: "E-mail",
    href: `mailto:${CONTACT.email}`,
    external: false,
    icon: (
      <svg viewBox="0 0 24 24" className="size-4.5 text-foreground" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 7l9 6 9-6" />
      </svg>
    ),
  },
];

export function LoginForm() {
  const [state, formAction, isPending] = useActionState(loginAction, undefined);

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="email">E-mail</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            className="h-10 rounded-xl border-black/10 bg-white/70"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Mot de passe</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="h-10 rounded-xl border-black/10 bg-white/70"
          />
        </div>
        {state && !state.ok && (
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
        )}
        <Button
          type="submit"
          size="lg"
          disabled={isPending}
          className="w-full rounded-xl border-0 text-white shadow-lg shadow-orange-500/25 transition hover:brightness-105 hover:shadow-orange-500/35 focus-visible:ring-orange-400/50 active:brightness-95"
          style={{
            backgroundColor: "#ff6a3d",
            backgroundImage:
              "radial-gradient(ellipse at top, #ffd93d 0%, #ff8a3d 35%, #ff3d3d 65%, transparent 75%)",
          }}
        >
          {isPending ? "Connexion..." : "Se connecter"}
        </Button>
      </form>

      <div className="h-px w-full bg-black/10" />

      <div className="flex justify-center gap-3">
        {CONTACT_LINKS.map((contact) => (
          <a
            key={contact.name}
            href={contact.href}
            target={contact.external ? "_blank" : undefined}
            rel={contact.external ? "noopener noreferrer" : undefined}
            aria-label={contact.name}
            title={contact.name}
            className="flex size-11 items-center justify-center rounded-full border border-black/10 bg-white/70 shadow-sm backdrop-blur transition hover:bg-white hover:shadow-md active:scale-95"
          >
            {contact.icon}
          </a>
        ))}
      </div>
    </div>
  );
}
