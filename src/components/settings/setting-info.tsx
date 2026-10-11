"use client";

import { ExplanationInfo } from "@/components/explanations/explanation-info";
import { SETTINGS_EXPLANATIONS, SETTINGS_SECTION_TITLES, type SettingId } from "@/lib/settings/settings-explanations";

/**
 * « ⓘ » next to a /parametres setting, switch or figure
 * (src/lib/settings/settings-explanations.ts): the full explanation (short
 * texts — no « Définitions » panel on settings screens), with « Effet »
 * instead of « Calcul », and the Français / العربية switch.
 */
export function SettingInfo({ setting, label, className }: { setting: SettingId; label?: string; className?: string }) {
  const doc = SETTINGS_EXPLANATIONS[setting];
  return <ExplanationInfo label={label ?? doc.labels[0]} text={doc.text} compact={false} titles={SETTINGS_SECTION_TITLES} className={className} />;
}
