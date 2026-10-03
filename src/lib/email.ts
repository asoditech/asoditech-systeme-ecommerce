import "server-only";

import { Resend } from "resend";
import { env } from "@/lib/env";
import { USER_ROLE_LABELS } from "@/lib/status-labels";
import type { UserRole } from "@prisma/client";
import { renderNotificationEmail, type NotificationEmail } from "@/lib/notification-email";

/**
 * Transactional email — invitations, password resets (see
 * docs/adr/0027-tenant-provisioning.md), forwarded support-widget
 * problem reports, and the four critical business alerts (docs/adr/0057).
 * Deliberately minimal: one
 * provider (Resend — a plain HTTPS API, no SMTP config, already the
 * simplest option compatible with a Vercel deployment), plain template
 * strings, no queue, no retry. A failed send is logged and swallowed,
 * never thrown: the invitation/token row this email describes has
 * already been committed by the time this runs, and the UI (invitations)
 * or audit trail (password reset) already carries the link as a
 * fallback — a missing email should not roll back or fail the action
 * that triggered it.
 *
 * Without RESEND_API_KEY + EMAIL_FROM set, every send falls back to the
 * previous behavior (logging the link) so no existing environment
 * (local dev, this test suite, CI) changes until an operator
 * deliberately configures real delivery.
 *
 * NODE_ENV==="test" always forces the log-only path, regardless of those
 * two vars — found necessary the hard way: `.env.test` deliberately
 * curates a minimal, hermetic set of vars for the test suite, but
 * `@prisma/client`'s own runtime auto-loads the real `.env` file for any
 * variable that isn't already set in `process.env`, so a developer's real
 * RESEND_API_KEY/EMAIL_FROM (present in their local, gitignored `.env`
 * for manual testing, absent from `.env.test`) silently leaks into every
 * test run and fires real Resend API calls. This guard makes the test
 * suite hermetic against that leak instead of relying on every developer
 * mirroring every new `.env` var into `.env.test` correctly forever.
 */

let client: Resend | null = null;

function getClient(): Resend | null {
  if (env.NODE_ENV === "test") return null;
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return null;
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

/** Whether outgoing email is actually delivered on this server (read-only
 * status for Paramètres → Notifications; never exposes the key). */
export function isEmailConfigured(): boolean {
  return getClient() !== null;
}

async function sendEmail(input: { to: string; subject: string; html: string; text: string }): Promise<void> {
  const resend = getClient();
  if (!resend) {
    // In production the body (invitation / reset links = live bearer tokens)
    // never goes to the server log (docs/adr/0053) — only that a message
    // was NOT sent. Locally the full text is still printed for development.
    if (process.env.NODE_ENV === "production") {
      console.warn(`[email] NOT SENT — RESEND_API_KEY/EMAIL_FROM unset (subject: ${input.subject})`);
    } else {
      console.log(`[email] not configured (RESEND_API_KEY/EMAIL_FROM unset) — logging instead:\nTo: ${input.to}\nSubject: ${input.subject}\n${input.text}`);
    }
    return;
  }

  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM!,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });

  if (error) {
    // Best-effort: the caller's own record (invitation/token) already
    // exists and its link is already visible another way — see the
    // module doc comment. Never let a delivery failure surface as an
    // action failure.
    console.error(`[email] Resend send failed for ${input.to}:`, error);
  }
}

function absoluteUrl(path: string): string {
  return new URL(path, env.APP_URL).toString();
}

export async function sendInvitationEmail(input: {
  to: string;
  inviteeName: string;
  role: UserRole;
  inviteUrl: string;
}): Promise<void> {
  const url = absoluteUrl(input.inviteUrl);
  const roleLabel = USER_ROLE_LABELS[input.role] ?? input.role;

  await sendEmail({
    to: input.to,
    subject: "Vous êtes invité(e) sur ASODITECH",
    text: `Bonjour ${input.inviteeName},\n\nVous avez été invité(e) à rejoindre ASODITECH en tant que ${roleLabel}.\n\nCréez votre compte : ${url}\n\nCe lien expire dans 7 jours et ne peut être utilisé qu'une seule fois.`,
    html: `<p>Bonjour ${input.inviteeName},</p><p>Vous avez été invité(e) à rejoindre ASODITECH en tant que <strong>${roleLabel}</strong>.</p><p><a href="${url}">Créez votre compte</a></p><p>Ce lien expire dans 7 jours et ne peut être utilisé qu'une seule fois.</p>`,
  });
}

/**
 * A problem reported from the in-app support widget, forwarded to the
 * tenant's configured support address. Best-effort, same as every other
 * send here: the SupportTicket row is already committed and visible to
 * admins in-app, so a failed forward never fails the report. No secrets —
 * category, the user's own description, and the page they were on.
 */
export async function sendSupportTicketEmail(input: {
  to: string;
  companyName: string;
  categoryLabel: string;
  description: string;
  reporterName: string;
  reporterEmail: string;
  reporterRole?: string | null;
  pageUrl?: string | null;
  contextLine?: string | null;
}): Promise<void> {
  const reporter = input.reporterRole
    ? `${input.reporterName} — ${input.reporterRole} (${input.reporterEmail})`
    : `${input.reporterName} (${input.reporterEmail})`;
  const contextLines = [
    `Entreprise : ${input.companyName}`,
    `Catégorie : ${input.categoryLabel}`,
    `Signalé par : ${reporter}`,
    ...(input.pageUrl ? [`Page : ${input.pageUrl}`] : []),
    ...(input.contextLine ? [input.contextLine] : []),
  ];

  await sendEmail({
    to: input.to,
    subject: `[Support ${input.companyName}] ${input.categoryLabel}`,
    text: `${contextLines.join("\n")}\n\n---\n\n${input.description}`,
    html: `<p>${contextLines.join("<br>")}</p><hr><p style="white-space:pre-wrap">${input.description
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</p>`,
  });
}

export async function sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void> {
  const url = absoluteUrl(input.resetUrl);

  await sendEmail({
    to: input.to,
    subject: "Réinitialisation de votre mot de passe ASODITECH",
    text: `Une réinitialisation de mot de passe a été demandée pour ce compte.\n\nChoisissez un nouveau mot de passe : ${url}\n\nCe lien expire dans 1 heure et ne peut être utilisé qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.`,
    html: `<p>Une réinitialisation de mot de passe a été demandée pour ce compte.</p><p><a href="${url}">Choisissez un nouveau mot de passe</a></p><p>Ce lien expire dans 1 heure et ne peut être utilisé qu'une seule fois. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>`,
  });
}

/**
 * Critical business-notification emails (docs/adr/0057) — one rendered
 * message per recipient (each addressed alone: no recipient sees another's
 * address), sent through Resend's batch endpoint so a fan-out to several
 * users is one API call, not a burst against the rate limit. Same
 * best-effort contract as every send here: never throws; a failure is
 * logged (no address, no body) and the in-app notification already exists.
 */
export async function sendNotificationEmails(
  messages: { to: string; email: NotificationEmail }[]
): Promise<void> {
  if (messages.length === 0) return;
  const rendered = messages.map((m) => ({ to: m.to, ...renderNotificationEmail(m.email, env.APP_URL) }));
  const resend = getClient();
  if (!resend) {
    for (const m of rendered) await sendEmail(m); // the log-only path, unchanged
    return;
  }
  for (let i = 0; i < rendered.length; i += 100) {
    const chunk = rendered.slice(i, i + 100);
    try {
      const { error } = await resend.batch.send(
        chunk.map((m) => ({ from: env.EMAIL_FROM!, to: m.to, subject: m.subject, html: m.html, text: m.text }))
      );
      if (error) console.error(`[email] Resend batch send failed (${chunk.length} notification email(s), subject: ${chunk[0].subject}):`, error);
    } catch (error) {
      console.error(`[email] Resend batch send threw (${chunk.length} notification email(s), subject: ${chunk[0].subject}):`, error);
    }
  }
}
