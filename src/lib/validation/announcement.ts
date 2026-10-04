import { z } from "zod";
import {
  ANNOUNCEMENT_ACTION_LABEL_MAX,
  ANNOUNCEMENT_MESSAGE_MAX,
  ANNOUNCEMENT_TYPES,
  safeAnnouncementUrl,
} from "@/lib/announcements";

/**
 * Platform announcement editing (`/platform/annonces`, docs/adr/0059).
 * Dates arrive as ISO-8601 instants (the browser converts its local
 * `datetime-local` value before submitting — the server never guesses a time
 * zone); an empty string means "no bound".
 */
const optionalInstant = z
  .union([z.literal(""), z.null(), z.undefined(), z.iso.datetime({ offset: true })])
  .transform((v) => (v ? new Date(v) : null));

const optionalText = (max: number) =>
  z
    .union([z.null(), z.undefined(), z.string().trim().max(max)])
    .transform((v) => (v ? v : null));

export const announcementInputSchema = z
  .object({
    message: z
      .string()
      .trim()
      .min(1, "Le message est requis.")
      .max(ANNOUNCEMENT_MESSAGE_MAX, `${ANNOUNCEMENT_MESSAGE_MAX} caractères maximum.`),
    type: z.enum(ANNOUNCEMENT_TYPES),
    isPublished: z.boolean(),
    startsAt: optionalInstant,
    endsAt: optionalInstant,
    actionLabel: optionalText(ANNOUNCEMENT_ACTION_LABEL_MAX),
    actionUrl: optionalText(1000),
  })
  .superRefine((v, ctx) => {
    if (v.startsAt && v.endsAt && v.endsAt.getTime() <= v.startsAt.getTime()) {
      ctx.addIssue({ code: "custom", path: ["endsAt"], message: "La fin doit être après le début." });
    }
    if (v.actionUrl && !safeAnnouncementUrl(v.actionUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["actionUrl"],
        message: "Lien invalide : un chemin de l'application (« /… ») ou une adresse https:// uniquement.",
      });
    }
    if (Boolean(v.actionLabel) !== Boolean(v.actionUrl)) {
      ctx.addIssue({
        code: "custom",
        path: [v.actionLabel ? "actionUrl" : "actionLabel"],
        message: "Le libellé et le lien du bouton vont ensemble.",
      });
    }
  })
  .transform((v) => ({ ...v, actionUrl: v.actionUrl ? safeAnnouncementUrl(v.actionUrl) : null }));

export type AnnouncementInput = z.output<typeof announcementInputSchema>;

/** FormData → schema input (checkbox/switch posts "on" / "true"). */
export function announcementFormValues(formData: FormData) {
  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : null;
  };
  return {
    message: str("message") ?? "",
    type: str("type") ?? "",
    isPublished: str("isPublished") === "on" || str("isPublished") === "true",
    startsAt: str("startsAt"),
    endsAt: str("endsAt"),
    actionLabel: str("actionLabel"),
    actionUrl: str("actionUrl"),
  };
}

export const announcementIdSchema = z.string().trim().min(1).max(64);
